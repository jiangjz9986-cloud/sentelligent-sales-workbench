#!/usr/bin/env bash
# Five-minute inspection: outbox watermark, worker, backend/schedulers/delivery,
# and 26-hour backup freshness. Installed 0700 and run by the root oneshot.
# Incident transitions are saved before delivery; stable event keys survive a
# restart, lost POST response, or hour roll. ops-alert.sh owns delivery/spooling.
set -uo pipefail
ROOT="${SENTELLIGENT_ROOT:-/opt/sentelligent-sales-workbench}"
NODE="$ROOT/runtime/node-v24/bin/node"
DB="${OPS_INSPECT_DB:-/var/lib/sentelligent-sales-workbench/sales-workbench.sqlite}"
OPS_ALERT_SCRIPT="${OPS_ALERT_SCRIPT:-$ROOT/tools/ops-alert.sh}"
ENV_FILE="${OPS_ALERT_ENV_FILE:-$ROOT/config/backend.env}"

exec python3 - "$ROOT" "$NODE" "$DB" "$OPS_ALERT_SCRIPT" "$ENV_FILE" <<'PY'
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import uuid

root, node, database, alert_script, env_file = [os.fsencode(v).decode('utf-8', 'replace') for v in sys.argv[1:]]
tools = Path(root) / 'tools'
legacy_path = tools / '.ops-inspect-state'
state_dir = tools / '.ops-inspect-incidents'
state_dir.mkdir(mode=0o700, exist_ok=True)
directory = state_dir.lstat()
if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.geteuid():
    raise SystemExit('ops-inspect: unsafe incident directory')
state_dir.chmod(0o700)
os.umask(0o077)


def private_open(path, flags):
    fd = os.open(str(path), flags | os.O_NOFOLLOW, 0o600)
    metadata = os.fstat(fd)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_nlink != 1:
        os.close(fd)
        raise RuntimeError('ops-inspect: unsafe state file')
    os.fchmod(fd, 0o600)
    return fd


# Serialize concurrent timer/manual invocations, including the POST handoff.
lock_fd = private_open(state_dir / 'lock', os.O_CREAT | os.O_RDWR)
try:
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit(0)


def read_private(path):
    try:
        with os.fdopen(private_open(path, os.O_RDONLY), 'r', encoding='utf-8') as handle:
            return handle.read()
    except FileNotFoundError:
        return None


def atomic_write(path, text):
    fd, temporary = tempfile.mkstemp(prefix='.pending-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, str(path))
        parent_fd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


legacy_lines = (read_private(legacy_path) or '').splitlines()
legacy_mark = next((line.split('=', 1)[1] for line in legacy_lines if line.startswith('outbox_failed_mark=')), None)
state_path = state_dir / 'state.json'
saved = read_private(state_path)
state = json.loads(saved) if saved is not None else {
    'version': 1, 'outboxFailedMark': legacy_mark, 'incidents': {}, 'pending': [],
}
if state.get('version') != 1 or not isinstance(state.get('incidents'), dict) or not isinstance(state.get('pending'), list):
    raise SystemExit('ops-inspect: invalid incident state; refusing to discard pending events')


def save():
    atomic_write(state_path, json.dumps(state, ensure_ascii=False, separators=(',', ':')) + '\n')
    if state.get('outboxFailedMark') is not None:
        lines = [line for line in legacy_lines if not line.startswith('outbox_failed_mark=')]
        lines.append('outbox_failed_mark=' + state['outboxFailedMark'])
        atomic_write(legacy_path, '\n'.join(lines) + '\n')


def run(args, env=None):
    try:
        return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return subprocess.CompletedProcess(args, 1, stdout=b'')


def output(result):
    return result.stdout.decode('utf-8', 'replace').strip()


def parse_date(value):
    # strptime also works on the older Python 3 runtimes used by the host.
    return datetime.datetime.strptime(value, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=datetime.timezone.utc)


now = output(run(['date', '-u', '+%Y-%m-%dT%H:%M:%S.000Z']))
now_date = parse_date(now)
observations = {}


def clean(value, limit):
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', ' ', str(value))
    # The existing backend limits strings by JavaScript UTF-16 code units.
    return text.encode('utf-16-le', 'replace')[:limit * 2].decode('utf-16-le', 'ignore')


def observe(source, severity=None, summary='', detail='', failure_key=None):
    observations['ops-inspect:' + source] = (severity, clean(summary, 220), clean(detail, 1200), failure_key)


# Drain already-durable events independently of whether today's probe succeeds.
run([alert_script, '--drain'])

# First-run baseline and lifecycle-terminal exclusions retain the old watermark
# semantics. An empty baseline is initialized too, so the first later failure alerts.
query = "SELECT COALESCE(MAX(updated_at),'') m, COUNT(*) n FROM weixin_confirmation_outbox WHERE status='failed' AND COALESCE(last_error_code,'') NOT IN ('WEIXIN_OUTBOX_STALE','WEIXIN_OUTBOX_SUPERSEDED','WEIXIN_OUTBOX_CANCELLED')"
javascript = "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[1],{readOnly:true});const r=d.prepare(" + json.dumps(query) + ").get();console.log(r.m+'|'+r.n)"
failed = run([node, '--input-type=module', '-e', javascript, database])
if failed.returncode == 0 and '|' in output(failed):
    current, count = output(failed).rsplit('|', 1)
    if count.isdigit():
        mark = state.get('outboxFailedMark')
        active = state['incidents'].get('ops-inspect:outbox-failed', {}).get('recoveredAt', True) is None
        if mark is not None and ((current and current > mark) or (active and int(count) > 0)):
            observe('outbox-failed', 'critical', 'outbox 出现新的 failed 消息（现共 ' + count + ' 条）', '最新 failed updated_at=' + current + '；请查 weixin_confirmation_outbox 与 worker 日志', failure_key=max(mark, current))
        elif int(count) == 0:
            observe('outbox-failed')
        state['outboxFailedMark'] = max(mark or '', current)

worker = run(['systemctl', 'is-active', '--quiet', 'sentelligent-weixin-agent'])
observe('weixin-worker', None if worker.returncode == 0 else 'critical', 'sentelligent-weixin-agent 未在运行', '请查 sentelligent-weixin-agent 的 systemd 状态和 worker 日志')

try:
    token = next((line.split('=', 1)[1] for line in Path(env_file).read_text(encoding='utf-8').splitlines() if line.startswith('OPS_ALERT_TOKEN=')), '')
except OSError:
    token = ''
response = run(['curl', '-sS', '--max-time', '10', '-w', '\n%{http_code}', '-H', 'Authorization: Bearer ' + token, 'http://127.0.0.1:8897/api/integrations/ops-alerts/status'])


def reject_constant(value):
    raise ValueError('status invalid JSON constant')


try:
    if response.returncode != 0:
        raise ValueError('status transport failed')
    body, code = response.stdout.decode('utf-8').strip().rsplit('\n', 1)
    if not re.fullmatch(r'2[0-9][0-9]', code):
        raise ValueError('status HTTP ' + clean(code, 3))
    document = json.loads(body, parse_constant=reject_constant)
    item = document.get('item') if isinstance(document, dict) else None
    if not isinstance(item, dict) or not isinstance(item.get('schedulers'), dict) or 'hospitalTender' not in item['schedulers']:
        raise ValueError('status missing item/schedulers')
    delivery = item.get('weixinDelivery')
    if not isinstance(delivery, dict) or delivery.get('status') not in ('ready', 'not_ready'):
        raise ValueError('status invalid weixinDelivery')
    for name, scheduler in item['schedulers'].items():
        if not re.fullmatch(r'[A-Za-z0-9._@-]{1,76}', name) or (scheduler is not None and not isinstance(scheduler, dict)):
            raise ValueError('status invalid scheduler')
except (ValueError, TypeError) as error:
    observe('backend', 'critical', 'backend 状态端点不可用', 'curl 127.0.0.1:8897；' + clean(error, 180))
else:
    observe('backend')
    for name, scheduler in item['schedulers'].items():
        if scheduler is None:
            continue  # Missing observations cannot recover an existing incident.
        failed_status = scheduler.get('lastStatus') == 'failed'
        partial = scheduler.get('lastStatus') == 'partial'
        error = scheduler.get('lastError')
        health = scheduler.get('sourceHealth')
        all_sources_failed = False
        context = 'lastStatus=' + str(scheduler.get('lastStatus'))
        if isinstance(health, dict):
            counts = [health.get(key) for key in ('total', 'healthy', 'degraded', 'error')]
            if all(type(n) is int and n >= 0 for n in counts) and sum(counts[1:]) == counts[0]:
                total, healthy, degraded, errors = counts
                all_sources_failed = total > 0 and errors == total
                partial = partial or degraded + errors > 0
                context += '; sourceHealth=' + json.dumps(health, separators=(',', ':'))
        ids = scheduler.get('affectedSourceIds')
        if isinstance(ids, list):
            context += '; affectedSourceIds=' + ','.join(clean(v, 80) for v in ids[:20])
        affected = scheduler.get('affectedCustomerCount')
        context += '; affectedCustomerCount=' + (str(affected) if type(affected) is int and affected >= 0 else 'unknown')
        severity = None
        if error or partial or failed_status:
            severity = 'warning' if (partial or error == '部分公开来源失败') and not failed_status else 'critical'
        if all_sources_failed:
            severity = 'critical'
        if name == 'hospitalTender' and severity is None and scheduler.get('lastStatus') != 'success':
            continue  # Starting/waiting/disabled does not prove a failed source recovered.
        observe('scheduler-' + name, severity, '巡检发现异常：scheduler-' + name, context + '; ' + clean(error or '', 500))
    expires_at = delivery.get('expiresAt')
    if expires_at:
        try:
            remaining = (parse_date(expires_at) - now_date).total_seconds()
            observe('weixin-context-expiry', 'critical' if remaining <= 0 else ('warning' if remaining <= 10800 else None), '微信主动推送上下文' + ('已到期' if remaining <= 0 else '将在 3 小时内到期'), 'expiresAt=' + expires_at + '；请给小小发送真实微信消息刷新上下文。普通心跳不能续期。')
        except (ValueError, TypeError):
            observe('weixin-context-expiry', 'warning', '微信主动推送上下文到期时间无效', '无法核验 expiresAt')
    else:
        observe('weixin-context-expiry')
    observe('weixin-delivery', 'warning' if delivery['status'] != 'ready' else None, '巡检发现异常：weixin-delivery', clean(delivery.get('reason', 'not_ready'), 300))

backups = list((Path(root) / 'backups/daily').glob('*.sqlite'))
latest = max(backups, key=lambda path: path.stat().st_mtime) if backups else None
stale = latest is None or now_date.timestamp() - latest.stat().st_mtime > 93600
observe('backup-freshness', 'critical' if stale else None, '每日备份超过 26 小时未更新', '最新文件：' + (latest.name if latest else '无') + '；请查 sentelligent-daily-backup timer/journal')


def transition(source, incident, stage, summary, detail):
    context = 'incidentId=' + incident['id'] + '; firstFailureAt=' + incident['firstFailureAt'] + '; consecutiveFailures=' + str(incident['consecutiveFailures'])
    if stage == 'recovered':
        context += '; recoveredAt=' + now + '; previousSeverity=' + incident['severity']
    state['pending'].append({
        'source': source, 'severity': 'warning' if stage == 'recovered' else stage,
        'summary': summary, 'detail': clean(context + '; ' + detail, 1900),
        'eventId': incident['id'] + ':' + stage, 'occurredAt': now,
    })


for source, (severity, summary, detail, failure_key) in observations.items():
    incident = state['incidents'].get(source)
    active = incident is not None and incident.get('recoveredAt') is None
    # Outbox watermark advances represent new failures even if older failed
    # rows remain. Rechecking the same watermark still belongs to one incident.
    if active and failure_key is not None and incident.get('failureKey') != failure_key:
        active = False
    if severity is None:
        if active:
            incident['recoveredAt'] = now
            transition(source, incident, 'recovered', '巡检恢复：' + source, incident['detail'])
        continue
    if not active:
        incident = {'id': source + ':' + uuid.uuid4().hex, 'firstFailureAt': now, 'consecutiveFailures': 0, 'severity': severity, 'recoveredAt': None, 'failureKey': failure_key}
        state['incidents'][source] = incident
    incident['consecutiveFailures'] += 1
    incident['lastFailureAt'] = now
    incident['detail'] = detail
    # Three consecutive failed inspections escalate a warning once. Keep the
    # highest severity until an explicit successful observation closes it.
    if severity == 'warning' and incident['consecutiveFailures'] >= 3:
        severity = 'critical'
    if not active or (incident['severity'] == 'warning' and severity == 'critical'):
        incident['severity'] = severity
        transition(source, incident, severity, summary, detail)

# Save both the transition and frozen payload before any network side effect.
# If POST and spool both fail, pending survives the next process invocation.
save()
for event in list(state['pending']):
    environment = dict(os.environ, OPS_ALERT_EVENT_ID=event['eventId'], OPS_ALERT_OCCURRED_AT=event['occurredAt'])
    result = run([alert_script, '--emit', event['source'], event['severity'], event['summary'], event['detail']], env=environment)
    if result.returncode == 0:
        state['pending'].remove(event)
        save()
    else:
        print('ops-inspect: event remains pending: ' + event['eventId'], file=sys.stderr)
PY
