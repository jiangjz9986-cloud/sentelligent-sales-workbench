import {
  BellRing,
  BookOpen,
  BriefcaseBusiness,
  CalendarClock,
  ChevronRight,
  FileText,
  PanelLeft,
  Settings,
  ShieldAlert,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { moduleSubnavItems } from "../data/salesWorkbenchData.js";

const GROUPS = [
  {
    id: "customer",
    label: "客户画像",
    items: [
      { id: "customer", label: "客户档案", icon: UsersRound },
      { id: "hospital-tenders", label: "招标监测", icon: BellRing, badgeKey: "tenderHigh" },
    ],
  },
  {
    id: "opportunity",
    label: "商机",
    items: moduleSubnavItems.opportunity,
  },
  {
    id: "assistant",
    label: "AI 助手",
    items: [{ id: "assistant-chat", label: "AI 对话", icon: Sparkles }],
  },
  {
    id: "weekly",
    label: "周报与汇报",
    items: [{ id: "weekly", label: "周报与汇报", icon: FileText }],
  },
  {
    id: "knowledge",
    label: "知识库",
    items: [{ id: "knowledge", label: "知识库", icon: BookOpen }],
  },
  {
    id: "settings",
    label: "系统配置",
    items: moduleSubnavItems.settings,
  },
];

export function MobileMoreDrawer({
  open,
  onClose,
  onNavigate,
  onMoreSubnav,
  onOpenAssistant,
  authRole = "member",
  badges = {},
}) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  function handleItemClick(item, parentId) {
    if (parentId === "assistant") {
      onOpenAssistant?.();
      onClose();
      return;
    }
    if (parentId === "customer" || parentId === "opportunity") {
      onMoreSubnav(item.id);
      onClose();
      return;
    }
    if (parentId === "settings") {
      if (authRole !== "admin" && item.id !== "settings") {
        onNavigate(item.id);
      } else if (item.id === "settings" && authRole !== "admin") {
        onNavigate("settings");
      } else {
        onNavigate(item.id);
      }
      onClose();
      return;
    }
    onNavigate(item.id);
    onClose();
  }

  return (
    <div className="mobile-more-overlay" data-testid="mobile-more-overlay" onClick={onClose}>
      <div
        className="mobile-more-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="更多导航"
        data-testid="mobile-more-drawer"
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        {GROUPS.map((group) => {
          const items = group.id === "settings"
            ? group.items.filter((item) => authRole === "admin" || item.id === "settings")
            : group.items;
          return (
            <section key={group.id} className="mobile-more-group">
              <h3>{group.label}</h3>
              <ul>
                {items.map((item) => {
                  const Icon = item.icon ?? PanelLeft;
                  const badgeCount = item.badgeKey ? Number(badges[item.badgeKey] ?? 0) : 0;
                  const label = group.id === "settings" && item.id === "settings" && authRole !== "admin"
                    ? "安全设置"
                    : item.label;
                  return (
                    <li key={item.id}>
                      <button
                        className="mobile-more-item"
                        type="button"
                        data-testid={`mobile-more-${item.id}`}
                        onClick={() => handleItemClick(item, group.id)}
                      >
                        <Icon size={18} />
                        <span>{label}</span>
                        {badgeCount > 0 ? <span className="mobile-nav-badge" /> : null}
                        <ChevronRight size={16} aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
