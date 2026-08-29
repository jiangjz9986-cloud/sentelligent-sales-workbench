import { Command, MapPinned, Mic, PanelLeft, ReceiptText } from "lucide-react";
import { useState } from "react";
import { MobileMoreDrawer } from "./MobileMoreDrawer.jsx";

const NAV_ITEMS = [
  { id: "overview", label: "总览", icon: Command, badgeKey: "overviewTodos" },
  { id: "itinerary", label: "行程", icon: MapPinned },
  { id: "expense", label: "差旅", icon: ReceiptText },
  { id: "more", label: "更多", icon: PanelLeft, badgeKey: "badgeMore" },
];

export function MobileShell({
  activeParent,
  badges = {},
  onNavigate,
  onMoreSubnav,
  onQuickRecord,
  authRole,
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      <button
        className="mobile-fab-quick-record"
        type="button"
        data-testid="mobile-fab-quick-record"
        aria-label="快速记录"
        onClick={onQuickRecord}
      >
        <Mic size={24} />
      </button>
      <nav className="mobile-shell-nav" aria-label="移动端主导航">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const badgeCount = item.badgeKey ? Number(badges[item.badgeKey] ?? 0) : 0;
          const isActive = item.id !== "more" && activeParent === item.id;
          return (
            <button
              key={item.id}
              className={`mobile-shell-nav-item ${isActive ? "active" : ""}`}
              type="button"
              data-testid={`mobile-nav-${item.id}`}
              aria-label={item.label}
              aria-current={isActive ? "page" : undefined}
              onClick={() => {
                if (item.id === "more") {
                  setDrawerOpen(true);
                  return;
                }
                onNavigate(item.id);
              }}
            >
              <Icon size={20} />
              <span>{item.label}</span>
              {badgeCount > 0 ? (
                <span className="mobile-nav-badge" aria-label={`${badgeCount} 条更新`} />
              ) : null}
            </button>
          );
        })}
      </nav>
      <MobileMoreDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onNavigate={(nextActive) => {
          setDrawerOpen(false);
          onNavigate(nextActive);
        }}
        onMoreSubnav={onMoreSubnav}
        authRole={authRole}
        badges={badges}
      />
    </>
  );
}
