import { LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// 头像账号菜单：常驻显示"我是谁"（displayName + account），登出从一击变两击，
// 菜单本身即误触缓冲，后续改密/用户管理入口在此挂点。

export function AvatarMenu({ initial, displayName, account, onLogout }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="avatar-menu-wrap" ref={containerRef}>
      <button
        className="avatar avatar-button"
        type="button"
        ref={triggerRef}
        data-testid="avatar-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`账号菜单：${displayName ?? account ?? ""}`}
        title={displayName ?? account ?? ""}
        onClick={() => setOpen((current) => !current)}
      >
        {initial}
      </button>
      {open ? (
        <div className="avatar-menu" role="menu" data-testid="avatar-menu">
          <div className="avatar-menu-identity">
            <strong>{displayName ?? account}</strong>
            {account && account !== displayName ? <small>{account}</small> : null}
          </div>
          <button
            className="avatar-menu-item danger"
            type="button"
            role="menuitem"
            data-testid="avatar-menu-logout"
            onClick={onLogout}
          >
            <LogOut size={15} />
            退出登录
          </button>
        </div>
      ) : null}
    </div>
  );
}
