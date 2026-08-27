import { X } from "lucide-react";

export function ModuleSubnav({
  label,
  items = [],
  activeId,
  onNavigate,
  contextLabel = "",
  onClearContext,
}) {
  if (!items.length) return null;

  return (
    <nav className="module-subnav" aria-label={`${label}子功能`} data-testid={`module-subnav-${label}`}>
      <div className="module-subnav-heading">
        <span>{label}</span>
        {contextLabel ? (
          <span className="module-subnav-context" role="status">
            <strong>{contextLabel}</strong>
            {onClearContext ? (
              <button type="button" onClick={onClearContext} aria-label={`清除${contextLabel}筛选，查看全部`}>
                <X size={14} aria-hidden="true" />
                查看全部
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="module-subnav-list">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = item.id === activeId;
          return (
            <button
              className={`module-subnav-item ${isActive ? "active" : ""}`}
              type="button"
              key={item.id}
              data-testid={`subnav-${item.id}`}
              aria-current={isActive ? "page" : undefined}
              onClick={() => onNavigate?.(item.id)}
            >
              {Icon ? <Icon size={17} aria-hidden="true" /> : null}
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
