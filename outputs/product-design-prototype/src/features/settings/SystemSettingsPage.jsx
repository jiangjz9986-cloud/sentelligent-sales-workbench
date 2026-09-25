import {
  BellRing,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  Clock3,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  ScrollText,
  ShieldCheck,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Panel } from "../../components/primitives.jsx";

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

function statusLabel(value) {
  return value === "active" ? "已启用" : value === "cleared" ? "已清除" : "未配置";
}

function sourceLabel(value) {
  if (value === "ai-platform") return "AI 调度平台";
  return value === "settings"
    ? "加密配置"
    : value === "environment"
      ? "部署环境"
      : value === "none" && value !== undefined
        ? "未启用"
        : "—";
}

function bindingStatusLabel(value) {
  return {
    idle: "未启动",
    starting: "启动中",
    waiting_scan: "等待扫码",
    logged_in: "已绑定",
    authenticated: "已绑定",
    stopped: "已停止",
    expired: "已过期",
    error: "异常",
  }[value] ?? "未知";
}

function hospitalHealthLabel(value) {
  return {
    healthy: "健康",
    degraded: "降级",
    unhealthy: "异常",
    disabled: "已停用",
    unknown: "未知",
  }[value] ?? "未知";
}

function schedulerRunLabel(value) {
  return {
    success: "成功",
    partial: "部分完成",
    running: "运行中",
    failed: "失败",
    skipped: "已跳过",
    waiting: "等待运行",
    idle: "尚未运行",
  }[value] ?? "未知";
}

const BOOKKEEPING_ACTION_LABELS = {
  "travel_expense.create": "新增费用",
  "travel_expense.update": "修改费用",
  "travel_expense.delete": "删除费用",
  "travel_expense.attachment_add": "关联付款凭证",
  "travel_expense.attachment_delete": "移除付款凭证",
  "travel_expense.no_invoice_confirm": "确认无需发票",
  "travel_expense.no_invoice_revoke": "撤销无票确认",
  "travel_expense.region_profile.save": "保存出差区域",
  "travel_expense_advance.create": "新增借款",
  "travel_expense_advance.update": "修改借款",
  "travel_expense_advance.delete": "删除借款",
  "travel_expense_document_inbox.create": "收到付款凭证",
  "travel_expense_document_inbox.confirm": "确认付款凭证",
  "travel_expense_document_inbox.reject": "拒绝付款凭证",
  "invoice.create": "上传发票",
  "invoice.delete": "删除发票",
  "invoice.match_confirm": "确认发票匹配",
  "invoice.match_revoke": "撤销发票匹配",
  "invoice.candidate_accept": "采纳发票建议",
  "invoice.candidate_reject": "拒绝发票建议",
  "invoice.review_finalize": "完成发票复核",
  "invoice.suggestions_generate": "生成发票建议",
  "shortcut_bookkeeping.receive": "小小收到记账",
  "shortcut_bookkeeping.accept": "小小确认入账",
  "shortcut_bookkeeping.manual_reject": "拒绝小小记账",
  "shortcut_bookkeeping.manual_retry": "重新识别记账",
  "shortcut_bookkeeping.review_required": "记账待确认",
  "shortcut_bookkeeping.advance_received": "借款到账",
  "shortcut_bookkeeping.processing_failed": "记账识别失败",
  "bookkeeping_client.print_expense_list": "打印费用清单",
  "bookkeeping_client.print_invoices": "打印发票",
  "bookkeeping_client.export_expense_xlsx": "导出费用 Excel",
};

function bookkeepingActionLabel(action) {
  return BOOKKEEPING_ACTION_LABELS[action] ?? action ?? "未知操作";
}

function formatTimeOfDay(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("zh-CN", { hour12: false });
}

function bookkeepingEntityShortId(item) {
  const referenceCode = item?.metadata?.referenceCode;
  if (typeof referenceCode === "string" && referenceCode) return referenceCode;
  const entityId = String(item?.entityId ?? "");
  return entityId ? entityId.slice(0, 8) : "";
}

function bookkeepingLogTone(action = "") {
  if (action.endsWith(".delete") || action.includes("reject") || action.includes("failed")) return "failed";
  if (action.startsWith("bookkeeping_client.")) return "waiting";
  return "success";
}

function categoryEntryTypeLabel(value) {
  return value === "income" ? "收入" : "支出";
}

function categorySubcategoryLabel(item) {
  return item.subcategories?.length ? item.subcategories.join("、") : "无小类";
}

function bookkeepingLogSummary(item) {
  const source = (item?.after && typeof item.after === "object" ? item.after : null)
    ?? (item?.metadata && typeof item.metadata === "object" ? item.metadata : null)
    ?? {};
  const parts = [];
  const amountCents = Number.isSafeInteger(source.amountCents) ? source.amountCents : null;
  if (amountCents !== null) parts.push(`¥${(amountCents / 100).toFixed(2)}`);
  if (typeof source.occurredOn === "string" && source.occurredOn) parts.push(source.occurredOn);
  if (typeof source.referenceCode === "string" && source.referenceCode) parts.push(source.referenceCode);
  if (typeof source.weekStart === "string" && source.weekStart) parts.push(`${source.weekStart} 当周`);
  if (Number.isSafeInteger(source.itemCount)) parts.push(`${source.itemCount} 条`);
  if (typeof source.purpose === "string" && source.purpose) parts.push(source.purpose);
  return parts.slice(0, 3).join(" · ");
}

function toneForStatus(value) {
  if (["healthy", "logged_in", "authenticated", "connected"].includes(value)) return "success";
  if (["degraded", "starting", "waiting_scan", "connecting"].includes(value)) return "warning";
  if (["unhealthy", "error", "expired", "offline"].includes(value)) return "danger";
  return "neutral";
}

function StatusMark({ status, children }) {
  const tone = toneForStatus(status);
  return (
    <span className={`settings-status-value ${tone}`}>
      {tone === "success" ? <CheckCircle2 size={15} aria-hidden="true" /> : null}
      {tone === "danger" ? <CircleAlert size={15} aria-hidden="true" /> : null}
      {tone === "warning" ? <LoaderCircle size={15} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function SystemSettingsPage({ apiClient, backendStatus, section = "security", role = "admin" }) {
  const [settings, setSettings] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [pushplusForm, setPushplusForm] = useState({ token: "", accessKey: "" });
  const [passwordForm, setPasswordForm] = useState({ current: "", next: "", confirm: "" });
  const [integrationStatus, setIntegrationStatus] = useState({
    loading: true,
    error: "",
    weixin: null,
    hospitalHealth: null,
    scheduler: null,
    pushplusCredentials: null,
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [bookkeepingLog, setBookkeepingLog] = useState({ loading: true, error: "", items: [], updatedAt: null });
  const [bookkeepingLogReloadToken, setBookkeepingLogReloadToken] = useState(0);
  const [categoryState, setCategoryState] = useState({ loading: true, error: "", items: [], updatedAt: null });
  const [categoryEntryType, setCategoryEntryType] = useState("expense");
  const [categoryShowArchived, setCategoryShowArchived] = useState(false);
  const [categoryEditor, setCategoryEditor] = useState(null);
  const [categoryReloadToken, setCategoryReloadToken] = useState(0);

  async function loadSettings() {
    if (["notifications", "tender-schedule", "bookkeeping-log", "bookkeeping-categories"].includes(section)) {
      setLoading(false);
      return;
    }
    // member 在安全子页只见改密卡，不拉取密钥元数据（写端点也已被后端 admin 门禁拦截）。
    if (role !== "admin" && section === "security") {
      setLoading(false);
      return;
    }
    if (!apiClient?.isEnabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setSettings(await apiClient.getSecuritySettings());
      setError("");
    } catch {
      setError("系统配置暂时无法加载，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
  }, [apiClient, backendStatus, section]);

  useEffect(() => {
    let disposed = false;
    const readsNotifications = section === "notifications";
    const readsTenderSchedule = section === "tender-schedule";
    // 运行状态端点均为 admin 门禁。只读取当前子页需要的数据，避免成员
    // 或其他设置子页产生无意义的 403 和后台探测。
    if (!apiClient?.isEnabled
      || backendStatus !== "connected"
      || role !== "admin"
      || (!readsNotifications && !readsTenderSchedule)) {
      setIntegrationStatus({ loading: false, error: "", weixin: null, hospitalHealth: null, scheduler: null, pushplusCredentials: null });
      return () => {
        disposed = true;
      };
    }

    setIntegrationStatus((current) => ({ ...current, loading: true, error: "" }));
    const read = async (method, normalize = (value) => value) => {
      if (typeof apiClient[method] !== "function") return null;
      try {
        return normalize(await apiClient[method]());
      } catch {
        return null;
      }
    };
    void Promise.all([
      readsNotifications ? read("getWeixinBindingStatus", (value) => value ? {
        status: value.status,
        message: value.message,
        updatedAt: value.updatedAt,
      } : null) : Promise.resolve(null),
      readsNotifications || readsTenderSchedule ? read("getHospitalTenderHealth", (value) => value ? {
        status: value.status,
        sourceCount: value.sourceCount,
        staleCount: value.staleCount,
        latestRun: value.latestRun,
        notification: value.notification ?? null,
      } : null) : Promise.resolve(null),
      readsTenderSchedule ? read("getHospitalTenderScheduler", (value) => {
        const item = value?.item ?? value;
        return item ? {
          item: {
            enabled: item.enabled,
            intervalMinutes: item.intervalMinutes,
            batchSize: item.batchSize,
            lastStatus: item.lastStatus,
            cycleNumber: item.cycleNumber,
            cycleProcessedCount: item.cycleProcessedCount,
            cycleCustomerCount: item.cycleCustomerCount,
            lastBatchCount: item.lastBatchCount,
            lastAcceptedCount: item.lastAcceptedCount,
            lastRejectedCount: item.lastRejectedCount,
            lastStartedAt: item.lastStartedAt,
            lastFinishedAt: item.lastFinishedAt,
            nextRunAt: item.nextRunAt,
            lastError: item.lastError,
          },
          runs: Array.isArray(value?.runs) ? value.runs.slice(0, 6).map((run) => ({
            id: run.id,
            status: run.status,
            cycleNumber: run.cycleNumber,
            batchCount: run.batchCount,
            acceptedCount: run.acceptedCount,
            rejectedCount: run.rejectedCount,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          })) : [],
          notification: value?.notification ? {
            status: value.notification.status,
            provider: value.notification.provider,
            configured: value.notification.configured,
            deliveryVerification: value.notification.deliveryVerification,
            deliveryCounts: value.notification.deliveryCounts,
            lastSuccessAt: value.notification.lastSuccessAt,
            lastFailureAt: value.notification.lastFailureAt,
          } : null,
        } : null;
      }) : Promise.resolve(null),
      readsNotifications ? read("requestHospitalTenderPushplusCredentials", (value) => value ? {
        token: value.token ?? null,
        accessKey: value.accessKey ?? null,
      } : null) : Promise.resolve(null),
    ]).then(([weixin, hospitalHealth, scheduler, pushplusCredentials]) => {
      if (disposed) return;
      const failed = readsNotifications
        ? weixin === null || pushplusCredentials === null
        : hospitalHealth === null && scheduler === null;
      setIntegrationStatus({
        loading: false,
        error: failed ? "运行状态暂时无法读取。" : "",
        weixin,
        hospitalHealth,
        scheduler,
        pushplusCredentials,
      });
    });
    return () => {
      disposed = true;
    };
  }, [apiClient, backendStatus, section, role]);

  useEffect(() => {
    if (section !== "bookkeeping-log") return undefined;
    if (!apiClient?.isEnabled || backendStatus !== "connected" || typeof apiClient.listBookkeepingAuditLogs !== "function") {
      setBookkeepingLog({ loading: false, error: "", items: [], updatedAt: null });
      return undefined;
    }
    let disposed = false;
    const load = async () => {
      try {
        const items = await apiClient.listBookkeepingAuditLogs({ limit: 80 });
        if (disposed) return;
        setBookkeepingLog({ loading: false, error: "", items, updatedAt: new Date().toISOString() });
      } catch {
        if (disposed) return;
        setBookkeepingLog((current) => ({ ...current, loading: false, error: "记账日志暂时无法读取，将自动重试。" }));
      }
    };
    setBookkeepingLog((current) => ({ ...current, loading: true }));
    void load();
    const timer = setInterval(() => { void load(); }, 10000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [apiClient, backendStatus, section, bookkeepingLogReloadToken]);

  useEffect(() => {
    if (section !== "bookkeeping-categories") return undefined;
    if (!apiClient?.isEnabled || backendStatus !== "connected" || typeof apiClient.listBookkeepingCategories !== "function") {
      setCategoryState({ loading: false, error: "", items: [], updatedAt: null });
      return undefined;
    }
    let disposed = false;
    const load = async () => {
      try {
        const items = await apiClient.listBookkeepingCategories({ includeArchived: categoryShowArchived });
        if (disposed) return;
        setCategoryState({ loading: false, error: "", items, updatedAt: new Date().toISOString() });
      } catch (loadError) {
        if (disposed) return;
        setCategoryState((current) => ({
          ...current,
          loading: false,
          error: loadError?.message ?? "记账分类暂时无法读取。",
        }));
      }
    };
    setCategoryState((current) => ({ ...current, loading: true, error: "" }));
    void load();
    return () => {
      disposed = true;
    };
  }, [apiClient, backendStatus, section, categoryShowArchived, categoryReloadToken]);

  async function saveApiKey(event) {
    event.preventDefault();
    if (!apiKey.trim()) {
      setError("请输入 DeepSeek API Key。");
      return;
    }
    setBusy("deepseek");
    setNotice("");
    try {
      const result = await apiClient.saveDeepSeekApiKey(apiKey);
      setApiKey("");
      setSettings((current) => ({ ...(current ?? {}), deepseek: result }));
      setNotice("DeepSeek API Key 已安全保存，页面不会再次显示明文。");
      setError("");
    } catch {
      setError("DeepSeek API Key 保存失败，请检查输入后重试。");
    } finally {
      setBusy("");
    }
  }

  async function clearApiKey() {
    const confirmed = typeof window !== "undefined"
      && window.confirm("确定清除 DeepSeek API Key 吗？清除后运行时将不再调用已保存的密钥。");
    if (!confirmed) return;
    setBusy("clear-deepseek");
    setNotice("");
    try {
      const result = await apiClient.clearDeepSeekApiKey();
      setSettings((current) => ({ ...(current ?? {}), deepseek: result }));
      setNotice("DeepSeek API Key 已清除。");
      setError("");
    } catch {
      setError("DeepSeek API Key 清除失败，请稍后重试。");
    } finally {
      setBusy("");
    }
  }

  async function savePushplusCredentials(event) {
    event.preventDefault();
    if (!pushplusForm.token.trim() && !pushplusForm.accessKey.trim()) {
      setError("至少填写 PushPlus Token 或 AccessKey。");
      return;
    }
    setBusy("pushplus");
    setNotice("");
    try {
      const result = await apiClient.requestHospitalTenderPushplusCredentials("PUT", {
        token: pushplusForm.token.trim(),
        accessKey: pushplusForm.accessKey.trim(),
      });
      setPushplusForm({ token: "", accessKey: "" });
      setIntegrationStatus((current) => ({ ...current, pushplusCredentials: result }));
      setNotice("PushPlus 凭据已加密保存，页面不会再次显示明文。");
      setError("");
    } catch {
      setError("PushPlus 凭据保存失败，请检查输入后重试。");
    } finally {
      setBusy("");
    }
  }

  async function clearPushplusCredentials() {
    const confirmed = typeof window !== "undefined"
      && window.confirm("确定清除 PushPlus Token 和 AccessKey 吗？清除后招标通知与送达核验将停止。");
    if (!confirmed) return;
    setBusy("clear-pushplus");
    setNotice("");
    try {
      const result = await apiClient.requestHospitalTenderPushplusCredentials("DELETE", { confirmation: "CLEAR" });
      setPushplusForm({ token: "", accessKey: "" });
      setIntegrationStatus((current) => ({ ...current, pushplusCredentials: result }));
      setNotice("PushPlus 凭据已清除，招标自动轮巡已停止。");
      setError("");
    } catch {
      setError("PushPlus 凭据清除失败，请稍后重试。");
    } finally {
      setBusy("");
    }
  }

  async function submitPasswordChange(event) {
    event.preventDefault();
    if (!passwordForm.current || !passwordForm.next || !passwordForm.confirm) {
      setError("请完整填写当前密码、新密码与确认新密码。");
      return;
    }
    if (passwordForm.next.length < 10) {
      setError("新密码至少 10 个字符。");
      return;
    }
    if (passwordForm.next !== passwordForm.confirm) {
      setError("两次输入的新密码不一致。");
      return;
    }
    setBusy("change-password");
    setNotice("");
    try {
      await apiClient.changePassword({
        currentPassword: passwordForm.current,
        newPassword: passwordForm.next,
      });
      setPasswordForm({ current: "", next: "", confirm: "" });
      setNotice("密码已修改，其他已登录设备将需要重新登录。");
      setError("");
    } catch (changeError) {
      if (changeError?.code === "CURRENT_PASSWORD_INCORRECT") {
        setError("当前密码不正确");
      } else if (changeError?.status === 429) {
        setError("尝试过于频繁，请 15 分钟后再试");
      } else if (changeError?.code === "USER_NOT_PROVISIONED") {
        setError("当前会话来自环境凭据回退，暂不能在线修改密码，请联系管理员。");
      } else {
        setError("密码修改失败，请稍后重试。");
      }
    } finally {
      setBusy("");
    }
  }

  async function refreshScheduler() {
    if (typeof apiClient?.getHospitalTenderScheduler !== "function") return null;
    const result = await apiClient.getHospitalTenderScheduler();
    setIntegrationStatus((current) => ({ ...current, scheduler: result, error: "" }));
    return result;
  }

  async function toggleSchedulerEnabled() {
    const schedulerState = integrationStatus.scheduler?.item ?? integrationStatus.scheduler ?? null;
    if (!schedulerState || typeof apiClient?.updateHospitalTenderScheduler !== "function") return;
    setBusy("scheduler-toggle");
    setNotice("");
    try {
      const result = await apiClient.updateHospitalTenderScheduler({ enabled: !schedulerState.enabled });
      setIntegrationStatus((current) => ({ ...current, scheduler: result, error: "" }));
      setNotice(result?.item?.enabled ? "医院招标自动轮巡已启用。" : "医院招标自动轮巡已停用。");
      setError("");
    } catch {
      setError("招标轮巡状态更新失败，请稍后重试。");
    } finally {
      setBusy("");
    }
  }

  async function runSchedulerNow() {
    if (typeof apiClient?.runHospitalTenderScheduler !== "function") return;
    setBusy("scheduler-run");
    setNotice("");
    try {
      const result = await apiClient.runHospitalTenderScheduler();
      await refreshScheduler();
      const accepted = Number(result?.acceptedCount ?? result?.state?.lastAcceptedCount ?? 0);
      const rejected = Number(result?.rejectedCount ?? result?.state?.lastRejectedCount ?? 0);
      setNotice(`本批检测已完成：入库 ${accepted} 条，异常 ${rejected} 条。`);
      setError("");
    } catch {
      setError("当前批次未能完成，请查看最近运行记录后重试。");
    } finally {
      setBusy("");
    }
  }

  function beginCreateCategory() {
    setCategoryEditor({
      id: null,
      version: null,
      entryType: categoryEntryType,
      name: "",
      subcategoriesText: "",
      aliasesText: "",
      isSystem: false,
      status: "active",
    });
    setError("");
    setNotice("");
  }

  function beginEditCategory(item) {
    setCategoryEditor({
      id: item.id,
      version: item.version,
      entryType: item.entryType,
      name: item.name,
      subcategoriesText: item.subcategories.join("、"),
      aliasesText: (item.aliases ?? []).join("、"),
      isSystem: item.isSystem,
      status: item.status,
    });
    setError("");
    setNotice("");
  }

  async function saveCategory(event) {
    event.preventDefault();
    if (!categoryEditor?.name.trim()) {
      setError("请输入分类名称。");
      return;
    }
    const subcategories = categoryEditor.subcategoriesText
      .split(/[、,，]/u)
      .map((item) => item.trim())
      .filter(Boolean);
    const aliases = categoryEditor.aliasesText
      .split(/[、,，]/u)
      .map((item) => item.trim())
      .filter(Boolean);
    setBusy("category-save");
    setError("");
    setNotice("");
    try {
      if (categoryEditor.id) {
        const updatePayload = categoryEditor.isSystem
          ? { subcategories, aliases }
          : { name: categoryEditor.name.trim(), subcategories, aliases, status: categoryEditor.status };
        await apiClient.updateBookkeepingCategory(
          categoryEditor.id,
          updatePayload,
          categoryEditor.version,
        );
        setNotice("记账分类已更新。");
      } else {
        await apiClient.createBookkeepingCategory({
          entryType: categoryEditor.entryType,
          name: categoryEditor.name.trim(),
          subcategories,
          aliases,
        });
        setNotice("记账分类已添加。");
      }
      setCategoryEditor(null);
      setCategoryReloadToken((value) => value + 1);
    } catch (saveError) {
      if (saveError?.code === "BOOKKEEPING_CATEGORY_EXISTS") {
        setError("同一类账本中已经存在同名分类。");
      } else if (saveError?.code === "VERSION_CONFLICT") {
        setError("分类已被其他操作更新，请刷新后重新编辑。");
      } else {
        setError(saveError?.message ?? "记账分类保存失败，请稍后重试。");
      }
    } finally {
      setBusy("");
    }
  }

  async function archiveCategory(item) {
    const confirmed = typeof window !== "undefined"
      && window.confirm(`确定停用“${item.name}”吗？历史记账仍会保留该分类。`);
    if (!confirmed) return;
    setBusy(`category-archive-${item.id}`);
    setError("");
    setNotice("");
    try {
      await apiClient.deleteBookkeepingCategory(item.id, item.version);
      setNotice(`“${item.name}”已停用。`);
      setCategoryReloadToken((value) => value + 1);
      if (categoryEditor?.id === item.id) setCategoryEditor(null);
    } catch (archiveError) {
      setError(archiveError?.message ?? "记账分类停用失败，请刷新后重试。");
    } finally {
      setBusy("");
    }
  }

  async function restoreCategory(item) {
    setBusy(`category-restore-${item.id}`);
    setError("");
    setNotice("");
    try {
      await apiClient.updateBookkeepingCategory(item.id, { status: "active" }, item.version);
      setNotice(`“${item.name}”已恢复。`);
      setCategoryReloadToken((value) => value + 1);
    } catch (restoreError) {
      setError(restoreError?.message ?? "记账分类恢复失败，请刷新后重试。");
    } finally {
      setBusy("");
    }
  }

  const deepseek = settings?.deepseek;
  const schedulerState = integrationStatus.scheduler?.item ?? integrationStatus.scheduler ?? null;
  const schedulerRuns = Array.isArray(integrationStatus.scheduler?.runs)
    ? integrationStatus.scheduler.runs
    : [];
  const hospitalHealth = integrationStatus.hospitalHealth;
  const weixin = integrationStatus.weixin;
  const pushplus = hospitalHealth?.notification ?? integrationStatus.scheduler?.notification ?? null;
  const pushplusTokenMeta = integrationStatus.pushplusCredentials?.token;
  const pushplusAccessKeyMeta = integrationStatus.pushplusCredentials?.accessKey;
  const pushplusConfigured = pushplusTokenMeta ? Boolean(pushplusTokenMeta.configured) : Boolean(pushplus?.configured);
  const pushplusVerificationReady = pushplusAccessKeyMeta
    ? Boolean(pushplusAccessKeyMeta.configured)
    : pushplus?.deliveryVerification === "enabled";
  const pushplusCounts = pushplus?.deliveryCounts ?? {};
  const pushplusSubmitting = ["queued", "submitting"]
    .reduce((total, status) => total + (Number.isSafeInteger(pushplusCounts[status]) ? pushplusCounts[status] : 0), 0);
  const weixinReady = ["logged_in", "authenticated"].includes(weixin?.status);
  const notificationRuntimeStatus = backendStatus !== "connected"
    ? backendStatus
    : weixinReady ? "connected" : weixin?.status;
  const notificationRuntimeLabel = backendStatus !== "connected"
    ? "服务未连接"
    : integrationStatus.loading
      ? "读取中"
      : integrationStatus.error
        ? "状态不可用"
        : weixinReady ? "Clawbot 在线" : bindingStatusLabel(weixin?.status);
  const schedulerStatus = !schedulerState
    ? undefined
    : schedulerState.lastStatus === "failed"
      ? "error"
      : schedulerState.enabled ? "connected" : "offline";
  const sectionMeta = {
    security: {
      eyebrow: "安全与 AI",
      title: "安全与 AI 配置",
      description: "配置服务端 AI 能力。密钥仅加密保存，浏览器不会再次读取明文。",
      icon: ShieldCheck,
    },
    notifications: {
      eyebrow: "通知服务",
      title: "通知渠道",
      description: "Clawbot 仅用于记账，医院招标由 PushPlus 推送，其他提醒保存在站内通知中心。",
      icon: BellRing,
    },
    "tender-schedule": {
      eyebrow: "招标调度",
      title: "医院招标自动轮巡",
      description: "查看固定节奏、按批次推进的客户轮巡状态，并控制启停或立即运行下一批。",
      icon: CalendarClock,
    },
    "bookkeeping-log": {
      eyebrow: "记账审计",
      title: "记账实时日志",
      description: "记账、修改、取消、确认、发票、借款、打印与导出的每一步都会在这里留痕，每 10 秒自动刷新。",
      icon: ScrollText,
    },
    "bookkeeping-categories": {
      eyebrow: "记账配置",
      title: "记账分类",
      description: "维护小小记账使用的收入与支出分类；停用不会影响历史记账。",
      icon: Tags,
    },
  }[section] ?? null;
  const SectionIcon = sectionMeta?.icon ?? ShieldCheck;

  const processedCount = Number(schedulerState?.cycleProcessedCount) || 0;
  const customerCount = Number(schedulerState?.cycleCustomerCount) || 0;
  const progressPercent = customerCount > 0
    ? Math.min(100, Math.round((processedCount / customerCount) * 100))
    : 0;
  const categoryItems = categoryState.items.filter((item) => item.entryType === categoryEntryType);

  return (
    <div className="system-settings-page" data-testid="system-settings-page" data-section={section}>
      <div className="settings-intro">
        <div>
          <span className="eyebrow">{sectionMeta?.eyebrow ?? "系统配置"}</span>
          <h2>{sectionMeta?.title ?? "系统配置"}</h2>
          <p>{sectionMeta?.description ?? "管理系统安全配置与服务连接。"}</p>
          {role === "admin" && section === "security" ? (
            <a href="/api/ai-platform/console/" target="_blank" rel="noopener noreferrer" className="ghost-button">
              <ExternalLink size={16} aria-hidden="true" />AI 统一调度平台
            </a>
          ) : null}
        </div>
        <SectionIcon size={30} aria-hidden="true" />
      </div>

      {error ? <p className="settings-feedback error" role="alert">{error}</p> : null}
      {notice ? <p className="settings-feedback" role="status">{notice}</p> : null}

      {loading ? (
        <section className="settings-loading" role="status">正在加载系统配置…</section>
      ) : null}

      {!loading && section === "security" ? (
        <section className="settings-focused-section" data-testid="settings-security-section">
          <div className="settings-grid settings-grid-focused">
            <Panel title="修改密码" meta="全部角色可用" className="settings-card" data-testid="change-password-card">
              <div className="settings-card-icon deepseek"><LockKeyhole size={20} /></div>
              <p className="settings-description">修改成功后，其他已登录设备会立即退出登录，本设备保持在线。</p>
              <form className="settings-key-form" data-testid="change-password-form" onSubmit={submitPasswordChange}>
                <label>
                  <span>当前密码</span>
                  <input
                    type="password"
                    value={passwordForm.current}
                    onChange={(event) => setPasswordForm((current) => ({ ...current, current: event.target.value }))}
                    autoComplete="current-password"
                    aria-label="当前密码"
                  />
                </label>
                <label>
                  <span>新密码（至少 10 个字符）</span>
                  <input
                    type="password"
                    value={passwordForm.next}
                    onChange={(event) => setPasswordForm((current) => ({ ...current, next: event.target.value }))}
                    autoComplete="new-password"
                    aria-label="新密码"
                  />
                </label>
                <label>
                  <span>确认新密码</span>
                  <input
                    type="password"
                    value={passwordForm.confirm}
                    onChange={(event) => setPasswordForm((current) => ({ ...current, confirm: event.target.value }))}
                    autoComplete="new-password"
                    aria-label="确认新密码"
                  />
                </label>
                <div className="settings-button-row">
                  <button className="primary-button" type="submit" disabled={busy !== ""}>
                    <LockKeyhole size={16} /> {busy === "change-password" ? "修改中…" : "修改密码"}
                  </button>
                </div>
              </form>
            </Panel>

            {role === "admin" ? (
            <>
            <Panel title="DeepSeek API Key" meta={statusLabel(deepseek?.status)} className="settings-card">
              <div className="settings-card-icon deepseek"><KeyRound size={20} /></div>
              <p className="settings-description">用于服务端 AI 分析。保存后只显示掩码和更新时间，不能从页面取回明文。</p>
              <dl className="settings-facts">
                <div><dt>状态</dt><dd><CheckCircle2 size={15} /> {statusLabel(deepseek?.status)}</dd></div>
                <div><dt>来源</dt><dd>{sourceLabel(deepseek?.source)}</dd></div>
                <div><dt>当前掩码</dt><dd>{deepseek?.masked ?? "未配置"}</dd></div>
                <div><dt>更新时间</dt><dd>{formatDate(deepseek?.updatedAt)}</dd></div>
              </dl>
              <form className="settings-key-form" onSubmit={saveApiKey}>
                <label>
                  <span>{deepseek?.configured ? "替换 API Key" : "设置 API Key"}</span>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    autoComplete="new-password"
                    placeholder="仅在此处输入，不会写入浏览器存储"
                    aria-label="DeepSeek API Key"
                  />
                </label>
                <div className="settings-button-row">
                  <button className="primary-button" type="submit" disabled={busy !== ""}>
                    <KeyRound size={16} /> {busy === "deepseek" ? "保存中…" : "安全保存"}
                  </button>
                  {deepseek?.configured ? (
                    <button className="danger-button" type="button" onClick={clearApiKey} disabled={busy !== ""}>
                      <Trash2 size={16} /> {busy === "clear-deepseek" ? "清除中…" : "清除"}
                    </button>
                  ) : null}
                </div>
              </form>
            </Panel>

            <Panel title="安全连接状态" meta={backendStatus === "connected" ? "已连接" : "需检查"} className="settings-card settings-status-card">
              <div className="settings-status-list">
                <div className="settings-status-item">
                  <div>
                    <strong>服务连接</strong>
                    <span>认证、业务接口与加密设置</span>
                  </div>
                  <StatusMark status={backendStatus}>
                    {backendStatus === "connected" ? "已连接" : backendStatus === "connecting" ? "连接中" : "未连接"}
                  </StatusMark>
                </div>
                <div className="settings-status-item">
                  <div>
                    <strong>配置保护</strong>
                    <span>只保存掩码、来源与更新时间</span>
                  </div>
                  <StatusMark status="connected">服务端加密</StatusMark>
                </div>
              </div>
              <p className="settings-inline-note">浏览器、普通业务接口和审计记录都不会返回密钥明文。</p>
            </Panel>
            </>
            ) : null}
          </div>
        </section>
      ) : null}

      {!loading && section === "notifications" ? (
        <section
          className="settings-focused-section"
          data-testid="settings-notifications-section"
          data-notification-mode="admin-configurable"
        >
          <div className="settings-grid settings-grid-focused">
            <Panel title="渠道职责与状态" meta="运行状态" className="settings-card settings-status-card">
              <div className="settings-card-icon clawbot"><BellRing size={20} /></div>
              <p className="settings-description">站内通知面向工作简报、待办、发票缺口、运维告警和主动助手提醒。管理员可在本页安全配置招标 PushPlus 凭据。</p>
              <dl className="settings-facts">
                <div><dt>记账助手</dt><dd>微信 Clawbot（仅记账）</dd></div>
                <div><dt>Clawbot 会话</dt><dd><StatusMark status={notificationRuntimeStatus}>{integrationStatus.loading ? "读取中" : notificationRuntimeLabel}</StatusMark></dd></div>
                <div><dt>医院招标</dt><dd>{integrationStatus.loading ? "读取中" : `PushPlus${pushplusConfigured ? "（已配置）" : "（未配置）"}`}</dd></div>
                <div><dt>PushPlus 送达核验</dt><dd>{integrationStatus.loading ? "读取中" : pushplusVerificationReady ? "已启用" : "未配置 AccessKey"}</dd></div>
                <div><dt>招标通知状态</dt><dd className="notification-delivery-counts">{integrationStatus.loading ? "读取中" : `已送达 ${pushplusCounts.sent ?? 0} · 已受理 ${pushplusCounts.accepted ?? 0} · 提交中 ${pushplusSubmitting} · 失败 ${pushplusCounts.failed ?? 0} · 结果未知 ${pushplusCounts.uncertain ?? 0}`}</dd></div>
              </dl>
              {weixin?.message ? <p className="settings-inline-note">{weixin.message}</p> : null}
            </Panel>

            <Panel title="站内通知与投递状态" meta="服务端管理" className="settings-card settings-status-card">
              <div className="settings-status-list">
                <div className="settings-status-item">
                  <div>
                    <strong>其他业务提醒</strong>
                    <span>工作简报、待办、发票、运维和主动助手提醒统一进入站内通知中心</span>
                  </div>
                  <StatusMark status={backendStatus}>{backendStatus === "connected" ? "站内可查" : "服务未连接"}</StatusMark>
                </div>
                <div className="settings-status-item">
                  <div>
                    <strong>PushPlus 状态含义</strong>
                    <span>“已受理”不等于已送达；配置 AccessKey 后才会轮询最终结果</span>
                  </div>
                  <StatusMark status={pushplusVerificationReady ? "connected" : "offline"}>
                    {pushplusVerificationReady ? "可核验" : "待配置"}
                  </StatusMark>
                </div>
              </div>
              <p className="settings-inline-note">站内通知会按账号隔离并保留已读状态；PushPlus 的提交、送达、失败或结果未知状态由服务端记录。</p>
            </Panel>

            {role === "admin" ? (
              <Panel
                title="医院招标 PushPlus 凭据"
                meta={pushplusConfigured && pushplusVerificationReady ? "配置完整" : pushplusConfigured || pushplusVerificationReady ? "待补全" : "未配置"}
                className="settings-card"
                data-testid="pushplus-credentials-card"
              >
                <div className="settings-card-icon deepseek"><KeyRound size={20} /></div>
                <p className="settings-description">凭据仅发送到后端并以服务端密钥加密保存。保存后只显示掩码，页面不再读取明文。</p>
                <dl className="settings-facts">
                  <div><dt>PushPlus Token</dt><dd>{pushplusTokenMeta?.masked ?? (pushplusTokenMeta?.configured ? "已配置" : "未配置")}</dd></div>
                  <div><dt>AccessKey</dt><dd>{pushplusAccessKeyMeta?.masked ?? (pushplusAccessKeyMeta?.configured ? "已配置" : "未配置")}</dd></div>
                  <div><dt>配置来源</dt><dd>{sourceLabel(pushplusTokenMeta?.source)}</dd></div>
                  <div><dt>最近更新</dt><dd>{formatDate(pushplusTokenMeta?.updatedAt ?? pushplusAccessKeyMeta?.updatedAt)}</dd></div>
                </dl>
                <form className="settings-key-form" data-testid="pushplus-credentials-form" onSubmit={savePushplusCredentials}>
                  <label>
                    <span>PushPlus Token{pushplusTokenMeta?.configured ? "（留空不修改）" : ""}</span>
                    <input
                      type="password"
                      value={pushplusForm.token}
                      onChange={(event) => setPushplusForm((current) => ({ ...current, token: event.target.value }))}
                      autoComplete="new-password"
                      placeholder={pushplusTokenMeta?.configured ? "已配置；输入新值以替换" : "输入 PushPlus Token"}
                      aria-label="PushPlus Token"
                      data-testid="pushplus-token-input"
                    />
                  </label>
                  <label>
                    <span>送达核验 AccessKey{pushplusAccessKeyMeta?.configured ? "（留空不修改）" : ""}</span>
                    <input
                      type="password"
                      value={pushplusForm.accessKey}
                      onChange={(event) => setPushplusForm((current) => ({ ...current, accessKey: event.target.value }))}
                      autoComplete="new-password"
                      placeholder={pushplusAccessKeyMeta?.configured ? "已配置；输入新值以替换" : "输入 PushPlus AccessKey"}
                      aria-label="PushPlus AccessKey"
                      data-testid="pushplus-access-key-input"
                    />
                  </label>
                  <div className="settings-button-row">
                    <button className="primary-button" type="submit" disabled={busy !== "" || backendStatus !== "connected"}>
                      <Save size={16} /> {busy === "pushplus" ? "保存中…" : "安全保存"}
                    </button>
                    {pushplusConfigured || pushplusVerificationReady ? (
                      <button className="danger-button" type="button" onClick={clearPushplusCredentials} disabled={busy !== ""}>
                        <Trash2 size={16} /> {busy === "clear-pushplus" ? "清除中…" : "清除凭据"}
                      </button>
                    ) : null}
                  </div>
                </form>
                <p className="settings-inline-note">空白字段不会覆盖现有值。Token 用于推送，AccessKey 用于查询最终送达状态；清除凭据会停用自动轮巡。</p>
              </Panel>
            ) : null}
          </div>
        </section>
      ) : null}

      {!loading && section === "tender-schedule" ? (
        <section className="settings-focused-section" data-testid="settings-tender-schedule-section">
          <div className="settings-grid settings-grid-focused settings-scheduler-grid">
            <Panel title="轮巡状态" meta={schedulerState?.enabled ? "已启用" : "已停用"} className="settings-card settings-status-card">
              <div className="settings-status-list">
                <div className="settings-status-item">
                  <div>
                    <strong>公开来源健康</strong>
                    <span>{hospitalHealth ? `${hospitalHealth.sourceCount ?? 0} 个来源 · ${hospitalHealth.staleCount ?? 0} 个需关注` : "尚未读取来源状态"}</span>
                  </div>
                  <StatusMark status={hospitalHealth?.status}>
                    {hospitalHealth ? hospitalHealthLabel(hospitalHealth.status) : "未读取"}
                  </StatusMark>
                </div>
                <div className="settings-status-item">
                  <div>
                    <strong>自动轮巡</strong>
                    <span>固定每 {schedulerState?.intervalMinutes ?? 60} 分钟 · 每批 {schedulerState?.batchSize ?? 10} 家客户</span>
                  </div>
                  <StatusMark status={schedulerStatus}>
                    {schedulerState ? schedulerRunLabel(schedulerState.lastStatus) : "未读取"}
                  </StatusMark>
                </div>
              </div>

              <div className="settings-scheduler-progress">
                <div>
                  <span>第 {schedulerState?.cycleNumber ?? "—"} 轮</span>
                  <strong>{customerCount > 0 ? `${processedCount} / ${customerCount} 家` : "等待新一轮客户快照"}</strong>
                </div>
                <progress value={customerCount > 0 ? progressPercent : undefined} max="100" aria-label="医院招标轮巡进度">
                  {customerCount > 0 ? `${progressPercent}%` : "等待运行"}
                </progress>
              </div>

              <dl className="settings-facts settings-scheduler-facts">
                <div><dt>最近开始</dt><dd>{formatDate(schedulerState?.lastStartedAt)}</dd></div>
                <div><dt>最近完成</dt><dd>{formatDate(schedulerState?.lastFinishedAt)}</dd></div>
                <div><dt>下次运行</dt><dd>{schedulerState?.enabled ? formatDate(schedulerState?.nextRunAt) : "已停用"}</dd></div>
                <div><dt>最近批次</dt><dd>{schedulerState?.lastBatchCount ?? 0} 家客户</dd></div>
                <div><dt>公告入库</dt><dd>{schedulerState?.lastAcceptedCount ?? 0} 条</dd></div>
                <div><dt>异常记录</dt><dd>{schedulerState?.lastRejectedCount ?? 0} 条</dd></div>
              </dl>
              {schedulerState?.lastError ? <p className="settings-feedback error" role="alert">{schedulerState.lastError}</p> : null}
            </Panel>

            <Panel title="运行控制" meta="固定策略" className="settings-card settings-scheduler-form">
              <div className="settings-schedule-policy">
                <CalendarClock size={22} aria-hidden="true" />
                <div>
                  <strong>固定节奏处理下一批客户</strong>
                  <p>当前为每 {schedulerState?.intervalMinutes ?? 60} 分钟、每批 {schedulerState?.batchSize ?? 10} 家客户；系统按稳定客户序号循环，成功后才推进游标。</p>
                </div>
              </div>
              <div className="settings-button-row settings-scheduler-actions">
                <button
                  className={schedulerState?.enabled ? "ghost-button" : "primary-button"}
                  type="button"
                  onClick={() => { void toggleSchedulerEnabled(); }}
                  disabled={!schedulerState || busy !== "" || backendStatus !== "connected"}
                >
                  <Power size={16} />
                  {busy === "scheduler-toggle" ? "更新中…" : schedulerState?.enabled ? "停用自动轮巡" : "启用自动轮巡"}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => { void runSchedulerNow(); }}
                  disabled={busy !== "" || backendStatus !== "connected" || schedulerState?.lastStatus === "running"}
                >
                  {busy === "scheduler-run" ? <LoaderCircle className="state-spinner" size={16} /> : <Play size={16} />}
                  {busy === "scheduler-run" ? "检测进行中" : "立即检测下一批"}
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => { void refreshScheduler(); }}
                  disabled={busy !== "" || backendStatus !== "connected"}
                >
                  <RefreshCw size={16} /> 刷新状态
                </button>
              </div>
              <p className="settings-inline-note"><Clock3 size={14} aria-hidden="true" />服务重启后会从已保存的轮次、快照和客户游标继续，不会自动跳过失败批次。</p>
            </Panel>

            <Panel title="最近运行记录" meta={`${schedulerRuns.length} 条`} className="settings-card settings-scheduler-runs">
              {schedulerRuns.length ? (
                <div className="settings-run-list">
                  {schedulerRuns.map((run, index) => (
                    <div className="settings-run-item" key={run.id ?? `${run.startedAt ?? "run"}-${index}`}>
                      <span className={`settings-run-dot ${run.status ?? "unknown"}`} aria-hidden="true" />
                      <div>
                        <strong>第 {run.cycleNumber ?? "—"} 轮 · {schedulerRunLabel(run.status)}</strong>
                        <small>{formatDate(run.finishedAt ?? run.startedAt)}</small>
                      </div>
                      <span>{run.batchCount ?? 0} 家 · 入库 {run.acceptedCount ?? 0} · 异常 {run.rejectedCount ?? 0}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="settings-empty-state">暂无运行记录，启用自动轮巡或立即检测下一批后会在此显示。</p>
              )}
            </Panel>
          </div>
          {integrationStatus.error ? <p className="settings-inline-note" role="status">{integrationStatus.error}</p> : null}
        </section>
      ) : null}

      {!loading && section === "bookkeeping-log" ? (
        <section className="settings-focused-section" data-testid="settings-bookkeeping-log-section">
          <div className="settings-grid settings-grid-focused">
            <Panel
              title="最近记账动作"
              meta={bookkeepingLog.loading ? "读取中" : `${bookkeepingLog.items.length} 条 · ${formatDate(bookkeepingLog.updatedAt)}`}
              className="settings-card settings-bookkeeping-log"
            >
              <div className="settings-button-row">
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => setBookkeepingLogReloadToken((value) => value + 1)}
                  disabled={bookkeepingLog.loading || backendStatus !== "connected"}
                >
                  <RefreshCw size={16} /> 刷新
                </button>
              </div>
              {bookkeepingLog.error ? <p className="settings-feedback error" role="alert">{bookkeepingLog.error}</p> : null}
              {bookkeepingLog.items.length ? (
                <div className="settings-run-list" data-testid="bookkeeping-log-list">
                  {bookkeepingLog.items.map((item) => (
                    <div className="settings-run-item" key={item.id}>
                      <span className={`settings-run-dot ${bookkeepingLogTone(item.action)}`} aria-hidden="true" />
                      <div>
                        <strong>{bookkeepingActionLabel(item.action)}</strong>
                        <small>{formatTimeOfDay(item.createdAt)}{bookkeepingEntityShortId(item) ? ` · ${bookkeepingEntityShortId(item)}` : ""}</small>
                      </div>
                      <span>{bookkeepingLogSummary(item) || "—"}</span>
                    </div>
                  ))}
                </div>
              ) : !bookkeepingLog.loading ? (
                <p className="settings-empty-state">还没有记账动作。小小入账、网页修改、打印或导出后会立即出现在这里。</p>
              ) : (
                <p className="settings-empty-state">正在读取记账日志…</p>
              )}
              <p className="settings-inline-note"><Clock3 size={14} aria-hidden="true" />日志来自服务端审计流水，只读展示；每 10 秒自动刷新，可随时对账。</p>
            </Panel>
          </div>
        </section>
      ) : null}

      {!loading && section === "bookkeeping-categories" ? (
        <section className="settings-focused-section" data-testid="settings-bookkeeping-categories-section">
          <div className="settings-grid settings-grid-focused settings-categories-grid">
            <Panel
              title="分类清单"
              meta={categoryState.loading ? "读取中" : `${categoryItems.length} 项 · ${formatDate(categoryState.updatedAt)}`}
              className="settings-card settings-category-manager"
            >
              <div className="settings-category-toolbar">
                <div className="settings-segmented-control" role="tablist" aria-label="记账类型">
                  {[["expense", "支出"], ["income", "收入"]].map(([value, label]) => (
                    <button
                      key={value}
                      className={categoryEntryType === value ? "active" : ""}
                      type="button"
                      role="tab"
                      aria-selected={categoryEntryType === value}
                      onClick={() => {
                        setCategoryEntryType(value);
                        setCategoryEditor(null);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="settings-checkbox-control">
                  <input
                    type="checkbox"
                    checked={categoryShowArchived}
                    onChange={(event) => setCategoryShowArchived(event.target.checked)}
                  />
                  <span>显示已停用</span>
                </label>
                <button
                  className="primary-button"
                  type="button"
                  onClick={beginCreateCategory}
                  disabled={busy !== "" || backendStatus !== "connected"}
                >
                  <Plus size={16} /> 新增分类
                </button>
              </div>
              {categoryState.error ? <p className="settings-feedback error" role="alert">{categoryState.error}</p> : null}
              {categoryItems.length ? (
                <div className="settings-category-list" data-testid="bookkeeping-category-list">
                  {categoryItems.map((item) => (
                    <div className={`settings-category-item ${item.status === "archived" ? "archived" : ""}`} key={item.id}>
                      <div className="settings-category-copy">
                        <div className="settings-category-title-row">
                          <strong>{item.name}</strong>
                          <span className={`settings-category-badge ${item.isSystem ? "system" : "custom"}`}>
                            {item.isSystem ? "系统默认" : "自定义"}
                          </span>
                          {item.status === "archived" ? <span className="settings-category-badge archived">已停用</span> : null}
                        </div>
                        <span>小类：{categorySubcategoryLabel(item)}</span>
                        {(item.aliases ?? []).length ? <span>识别词：{item.aliases.join("、")}</span> : null}
                      </div>
                      <div className="settings-category-actions">
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => beginEditCategory(item)}
                          disabled={busy !== ""}
                        >
                          <Pencil size={15} /> 编辑
                        </button>
                        {item.status === "archived" ? (
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => { void restoreCategory(item); }}
                            disabled={busy !== ""}
                          >
                            <RotateCcw size={15} /> 恢复
                          </button>
                        ) : (
                          <button
                            className="danger-button"
                            type="button"
                            onClick={() => { void archiveCategory(item); }}
                            disabled={item.isSystem || busy !== ""}
                            title={item.isSystem ? "系统默认分类不能停用" : undefined}
                          >
                            <Trash2 size={15} /> 停用
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : !categoryState.loading ? (
                <p className="settings-empty-state">当前类型还没有分类。</p>
              ) : (
                <p className="settings-empty-state">正在读取记账分类…</p>
              )}
              <p className="settings-inline-note"><Tags size={14} aria-hidden="true" />系统默认分类用于保持已有记账识别稳定；自定义分类可随时编辑、停用和恢复。</p>
            </Panel>

            {categoryEditor ? (
              <Panel
                title={categoryEditor.id ? `编辑${categoryEditor.name}` : `新增${categoryEntryTypeLabel(categoryEditor.entryType)}分类`}
                meta={categoryEditor.isSystem ? "系统默认" : "自定义分类"}
                className="settings-card settings-category-editor"
                data-testid="bookkeeping-category-editor"
              >
                <form className="settings-key-form" onSubmit={saveCategory}>
                  <label>
                    <span>分类名称</span>
                    <input
                      value={categoryEditor.name}
                      onChange={(event) => setCategoryEditor((current) => ({ ...current, name: event.target.value }))}
                      disabled={categoryEditor.isSystem}
                      autoFocus
                      aria-label="分类名称"
                    />
                  </label>
                  <label>
                    <span>小类（用逗号分隔，可留空）</span>
                    <input
                      value={categoryEditor.subcategoriesText}
                      onChange={(event) => setCategoryEditor((current) => ({ ...current, subcategoriesText: event.target.value }))}
                      placeholder="例如：早餐、午餐、晚餐"
                      aria-label="分类小类"
                    />
                  </label>
                  <label>
                    <span>识别关键词（用逗号分隔，可留空）</span>
                    <input
                      value={categoryEditor.aliasesText}
                      onChange={(event) => setCategoryEditor((current) => ({ ...current, aliasesText: event.target.value }))}
                      placeholder="例如：办公用品、文具采购"
                      aria-label="分类识别关键词"
                    />
                  </label>
                  <div className="settings-button-row">
                    <button className="primary-button" type="submit" disabled={busy !== ""}>
                      <Save size={16} /> {busy === "category-save" ? "保存中…" : "保存分类"}
                    </button>
                    <button className="ghost-button" type="button" onClick={() => setCategoryEditor(null)} disabled={busy !== ""}>
                      <X size={16} /> 取消
                    </button>
                  </div>
                </form>
                <p className="settings-inline-note">分类名称用于小小记账复核与历史修订；小类用于进一步细分费用。</p>
              </Panel>
            ) : (
              <Panel title="编辑分类" meta="未选择" className="settings-card settings-category-editor settings-category-editor-empty">
                <Tags size={26} aria-hidden="true" />
                <p className="settings-empty-state">选择“编辑”或“新增分类”后，在这里维护分类名称与小类。</p>
              </Panel>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
