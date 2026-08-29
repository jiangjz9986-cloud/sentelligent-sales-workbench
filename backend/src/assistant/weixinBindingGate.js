// v0.9.3 入口安全闸（§2.1 序 5a/5b）：未绑定 sender 能力面={绑定意图}，其余零能力
// 固定拒答——不入编排、不落 assistant_inbound_events、不写 blob；已绑定者「解绑/确认
// 解绑」两段自助。防爆破复用 loginRateLimit 全套。回 200 保证 worker 把引导文案带回
// 用户（403 会被 worker 当错误吞掉）。
import { insertAudit } from "../audit/auditRepository.js";
import {
  assertLoginAllowed,
  clearLoginFailures,
  loginRateLimitKey,
  pruneLoginRateLimits,
  recordLoginFailure,
} from "../auth/loginRateLimit.js";
import { getUser } from "../auth/usersStore.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { pruneExpiredBindingCodes, redeemBindingCode } from "../weixin/bindingCodes.js";
import { weixinSenderHash } from "../weixin/bindingsRepository.js";

const BIND_RE = /^绑定\s*([0-9]{6})$/u;

export const WEIXIN_UNBOUND_DENIAL_TEXT = "您尚未绑定工作台账号，请联系管理员获取绑定码后发送：绑定 123456";
const RATE_LIMITED_TEXT = "绑定尝试过于频繁，请 15 分钟后再试。";
const REJECTION_TEXTS = Object.freeze({
  invalid: "绑定码无效，请核对后重试，或联系管理员重新生成。",
  expired: "绑定码已过期（有效期 10 分钟），请联系管理员重新生成。",
  used: "该绑定码已被使用，请联系管理员重新生成。",
});

export function classifyBindingText(text) {
  const normalized = String(text ?? "").trim();
  const bindMatch = BIND_RE.exec(normalized);
  if (bindMatch) return { kind: "bind", code: bindMatch[1] };
  if (normalized === "解绑") return { kind: "unbind" };
  if (normalized === "确认解绑") return { kind: "unbind_confirm" };
  return { kind: "none" };
}

function welcomeText(binding, user) {
  const name = binding.displayName || user?.displayName || binding.account;
  return [
    `绑定成功！${name}，你好，我是小小。`,
    "现在可以直接发消息使用：",
    "· 查客户/商机（如「客户详情 XX医院」「商机列表」）",
    "· 记拜访、记待办（如「记待办 明天上午回访」）",
    "· 每天 09:00 晨报与周五 16:30 收尾提醒已默认开启",
    "记账能力需管理员开通后才可使用；回复「解绑」可随时解除绑定。",
  ].join("\n");
}

export function createWeixinBindingGate({
  db,
  bindingsRepository,
  codeSecret,
  rateLimitSecret,
  clock = () => new Date(),
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (!bindingsRepository || typeof bindingsRepository.bind !== "function") {
    throw new TypeError("bindingsRepository is required");
  }
  if (!codeSecret) throw new TypeError("codeSecret is required");
  if (typeof rateLimitSecret !== "string" || !rateLimitSecret.trim()) {
    throw new TypeError("rateLimitSecret is required");
  }

  function nowDate() {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid Date");
    return date;
  }

  function audit(action, { senderId, actor, metadata = {}, after = null }) {
    const senderHash = weixinSenderHash(senderId);
    insertAudit(db, {
      action,
      entityType: "weixin_binding",
      entityId: senderHash,
      actor,
      before: null,
      after,
      metadata: { senderHash, ...metadata },
    });
  }

  function denied(text) {
    return { status: 200, body: { status: "denied", text } };
  }

  function limiterKey(senderId) {
    return loginRateLimitKey(rateLimitSecret, `weixin-binding:${senderId}`, "weixin");
  }

  // §2.1 序 5a：未绑定 sender——仅在私聊里识别「绑定 ######」，其余一律固定拒答。
  function handleUnbound({ senderId, chatType, text } = {}) {
    const classification = classifyBindingText(text);
    if (chatType !== "direct" || classification.kind !== "bind") {
      audit("weixin.binding.denied", { senderId, actor: "weixin-agent", metadata: { chatType } });
      return denied(WEIXIN_UNBOUND_DENIAL_TEXT);
    }

    const now = nowDate();
    const nowMs = now.getTime();
    const key = limiterKey(senderId);
    pruneLoginRateLimits(db, nowMs);
    try {
      assertLoginAllowed(db, key, nowMs);
    } catch {
      audit("weixin.binding.code_rejected", { senderId, actor: "weixin-agent", metadata: { reason: "rate_limited" } });
      return denied(RATE_LIMITED_TEXT);
    }

    let outcome;
    try {
      // redeem+校验+bind 同事务：任何失败回滚码消耗，绑定成功才算兑换。
      outcome = withImmediateTransaction(db, () => {
        pruneExpiredBindingCodes(db, { now: nowMs });
        const redeemed = redeemBindingCode(db, { code: classification.code, secret: codeSecret, now: nowMs });
        if (redeemed.error) return { rejected: redeemed.error };
        const user = getUser(db, redeemed.account);
        if (!user || user.status !== "active") return { rejected: "invalid" };
        const binding = bindingsRepository.bind({
          senderId,
          account: redeemed.account,
          displayName: user.displayName,
          boundBy: redeemed.account,
          financialEnabled: false,
          digestEnabled: true,
        });
        audit("weixin.binding.bound", {
          senderId,
          actor: redeemed.account,
          after: {
            account: binding.account,
            financialEnabled: binding.financialEnabled,
            digestEnabled: binding.digestEnabled,
            status: binding.status,
          },
          metadata: { via: "weixin" },
        });
        return { binding, user };
      });
    } catch (error) {
      if (error?.code === "ACCOUNT_ALREADY_BOUND") {
        recordLoginFailure(db, key, nowMs);
        audit("weixin.binding.code_rejected", { senderId, actor: "weixin-agent", metadata: { reason: "invalid" } });
        return denied("该账号已在其他微信生效绑定，请先解绑或联系管理员处理。");
      }
      throw error;
    }
    if (outcome.rejected) {
      recordLoginFailure(db, key, nowMs);
      audit("weixin.binding.code_rejected", {
        senderId,
        actor: "weixin-agent",
        metadata: { reason: outcome.rejected },
      });
      return denied(REJECTION_TEXTS[outcome.rejected] ?? REJECTION_TEXTS.invalid);
    }
    clearLoginFailures(db, key);
    return { status: 200, body: { status: "ok", text: welcomeText(outcome.binding, outcome.user) } };
  }

  // §2.1 序 5b：已绑定者绑定控制词优先；命中返回响应，未命中返回 null 走正常编排。
  function handleBoundControl({ binding, chatType, text } = {}) {
    if (!binding || chatType !== "direct") return null;
    const classification = classifyBindingText(text);
    if (classification.kind === "bind") {
      // 不消耗码，防误换绑。
      const label = binding.displayName || binding.account;
      return {
        status: 200,
        body: { status: "ok", text: `当前微信已绑定 ${label}，如需换绑请先发送「解绑」，解绑后再使用新的绑定码。` },
      };
    }
    if (classification.kind === "unbind") {
      return {
        status: 200,
        body: {
          status: "ok",
          text: "确定要解除微信绑定吗？解绑后将无法继续在微信使用工作台服务。回复「确认解绑」完成解除。",
        },
      };
    }
    if (classification.kind === "unbind_confirm") {
      bindingsRepository.disable(binding.senderId, { by: binding.account });
      audit("weixin.binding.unbound", {
        senderId: binding.senderId,
        actor: binding.account,
        metadata: { via: "weixin_self" },
      });
      return {
        status: 200,
        body: { status: "ok", text: "已解绑。感谢使用，随时可凭管理员提供的新绑定码重新绑定。" },
      };
    }
    return null;
  }

  return Object.freeze({ handleUnbound, handleBoundControl });
}
