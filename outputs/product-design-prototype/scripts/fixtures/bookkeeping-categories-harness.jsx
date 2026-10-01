import { createRoot } from "react-dom/client";
import { Bell, FileText, Mic, Sparkles } from "lucide-react";

import { navItems } from "../../src/data/salesWorkbenchData.js";
import { SystemSettingsPage } from "../../src/features/settings/SystemSettingsPage.jsx";
import "../../src/styles/global.css";

const categories = [
  { id: "transport", entryType: "expense", name: "交通", status: "active", isSystem: true, subcategories: ["火车", "路桥费", "打车", "代驾", "停车"], aliases: [], version: 1 },
  { id: "lodging", entryType: "expense", name: "住宿费", status: "active", isSystem: true, subcategories: [], aliases: [], version: 1 },
  { id: "other", entryType: "expense", name: "其他", status: "active", isSystem: true, subcategories: [], aliases: [], version: 1 },
  { id: "hospitality", entryType: "expense", name: "招待/礼品", status: "active", isSystem: true, subcategories: [], aliases: [], version: 1 },
  { id: "vehicle", entryType: "expense", name: "汽车维修", status: "active", isSystem: true, subcategories: ["维修", "保养"], aliases: [], version: 1 },
  { id: "meal", entryType: "expense", name: "餐饮", status: "active", isSystem: true, subcategories: ["早餐", "午餐", "晚餐"], aliases: [], version: 1 },
];

let nextId = 1;
window.__categoryFixtureWrites = [];
window.confirm = (message) => {
  window.__categoryFixtureConfirmation = message;
  return true;
};

const apiClient = {
  isEnabled: true,
  async listBookkeepingCategories() {
    return categories.map((item) => ({ ...item, subcategories: [...item.subcategories], aliases: [...item.aliases] }));
  },
  async createBookkeepingCategory(payload) {
    const item = { ...payload, id: `custom-${nextId++}`, status: "active", isSystem: false, version: 1 };
    categories.push(item);
    window.__categoryFixtureWrites.push({ kind: "create", item: { ...item } });
    return item;
  },
  async updateBookkeepingCategory(id, payload) {
    const item = categories.find((category) => category.id === id);
    if (!item) throw new Error("分类不存在");
    Object.assign(item, payload, { version: item.version + 1 });
    window.__categoryFixtureWrites.push({ kind: "update", id, payload: { ...payload } });
    return item;
  },
  async deleteBookkeepingCategory(id) {
    const item = categories.find((category) => category.id === id);
    if (!item) throw new Error("分类不存在");
    item.status = "archived";
    item.version += 1;
    window.__categoryFixtureWrites.push({ kind: "archive", id });
    return item;
  },
};

function CategoryHarness() {
  return (
    <div className="app-shell category-preview-harness">
      <div className="product-window">
        <header className="topbar">
          <div className="brand-area">
            <span className="brand-mark brand-logo-mark">
              <picture>
                <source media="(max-width: 430px)" srcSet="/sent-zhixing-icon.png" />
                <img src="/sent-zhixing-transparent-logo.png" alt="森特智行" />
              </picture>
            </span>
          </div>
          <div className="top-actions">
            <span className="api-status connected">在线</span>
            <button className="ghost-button topbar-mobile-hidden" type="button"><FileText size={16} />周报</button>
            <button className="ghost-button topbar-mobile-hidden" type="button"><Mic size={16} />快速记录</button>
            <button className="icon-button topbar-notifications" type="button" aria-label="通知中心，62 条未读">
              <Bell size={18} /><span className="notification-count">62</span>
            </button>
            <button className="avatar-button" type="button" aria-label="继振">继</button>
          </div>
        </header>
        <div className="workspace">
          <aside className="sidebar">
            <div className="nav-kicker">工作区</div>
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} className={`nav-item ${item.id === "settings" ? "active" : ""}`} type="button" aria-current={item.id === "settings" ? "page" : undefined}>
                  <Icon size={18} /><span>{item.label}</span>
                  {item.id === "notifications" ? <span className="nav-item-count">62</span> : null}
                </button>
              );
            })}
            <div className="sidebar-foot">
              <div className="sidebar-foot-title"><Sparkles size={14} />AI 同步引擎</div>
              <div className="sidebar-foot-desc">服务状态 · 在线</div>
            </div>
          </aside>
          <main className="content">
            <div className="category-preview-breadcrumb"><span>系统配置</span><span aria-hidden="true">›</span><strong>记账分类</strong><time>2026/10/1 星期四</time></div>
            <SystemSettingsPage apiClient={apiClient} backendStatus="connected" section="bookkeeping-categories" role="admin" />
          </main>
        </div>
      </div>
    </div>
  );
}

createRoot(document.querySelector("#root")).render(<CategoryHarness />);
