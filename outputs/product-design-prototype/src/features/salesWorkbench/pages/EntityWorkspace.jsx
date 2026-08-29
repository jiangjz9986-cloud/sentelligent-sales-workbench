import {
  ChevronLeft,
  ChevronRight,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Panel } from "../../../components/primitives.jsx";
import { useToast } from "../../../components/toast.jsx";
import { ConfirmDialog } from "./shared.jsx";

function filterItems(items, searchText, fields) {
  const cleanSearch = searchText.trim().toLowerCase();
  if (!cleanSearch) return items;
  return items.filter((item) =>
    fields.some((field) => String(item[field] ?? "").toLowerCase().includes(cleanSearch)),
  );
}

export function EntityWorkspace({
  items,
  selected,
  activeRowId,
  onSelect,
  viewMode,
  setViewMode,
  config,
  onDelete,
  renderDetail,
}) {
  const toast = useToast();
  const [searchText, setSearchText] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const isCreateView = viewMode === "create";
  const isEditView = viewMode === "edit";
  const visibleItems = config.skipLocalSearch
    ? items
    : filterItems(items, searchText, config.searchFields ?? []);

  function openDetail(item) {
    onSelect(item.id);
    setViewMode?.("detail");
  }

  function requestDelete() {
    if (!selected?.id || !onDelete) return;
    setDeleteError("");
    setDeleteDialogOpen(true);
  }

  async function confirmDelete() {
    if (!selected?.id || !onDelete || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const deletedLabel = config.deleteDialog.entityName(selected);
      await onDelete(selected.id);
      setDeleteDialogOpen(false);
      setViewMode?.("list");
      toast({
        tone: "success",
        title: config.deleteDialog.successTitle,
        description: deletedLabel,
      });
    } catch (error) {
      setDeleteError(error.message || config.deleteDialog.errorMessage);
    } finally {
      setDeleteBusy(false);
    }
  }

  const detailTestId = isCreateView && config.detailCreateViewTestId
    ? config.detailCreateViewTestId
    : config.detailViewTestId;
  const listRowClassSuffix = config.listRowClassName ? ` ${config.listRowClassName}` : "";

  if (viewMode === "list") {
    return (
      <section className={config.listViewClassName} data-testid={config.listViewTestId}>
        <Panel
          title={config.panelTitle}
          meta={config.listMeta(visibleItems.length, items.length)}
          className={config.listPanelClassName}
          action={config.createAction ? (
            <button
              className="primary-button"
              type="button"
              data-testid={config.createAction.testId}
              onClick={() => setViewMode?.("create")}
            >
              {config.createAction.icon}
              {config.createAction.label}
            </button>
          ) : null}
        >
          {config.renderSearch ? config.renderSearch() : (
            <label className="search-box page-search">
              <Search size={16} />
              <input
                aria-label={config.searchAriaLabel}
                data-testid={config.searchTestId}
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder={config.searchPlaceholder}
              />
            </label>
          )}
          <div className="list-stack">
            {visibleItems.map((item) => (
              <article
                className={`list-button customer-list-row${listRowClassSuffix} ${activeRowId === item.id ? "selected" : ""}`}
                key={item.id}
              >
                <button className="list-row-main" type="button" onClick={() => onSelect(item.id)}>
                  <span>
                    <strong>{config.rowPrimary(item)}</strong>
                    <small>{config.rowSecondary(item)}</small>
                  </span>
                  {config.renderRowBadge ? config.renderRowBadge(item) : null}
                </button>
                {config.renderRowActions ? config.renderRowActions(item) : (
                  <button
                    className="ghost-button"
                    type="button"
                    data-testid={config.openDetailTestId}
                    onClick={() => openDetail(item)}
                  >
                    查看详情
                    <ChevronRight size={15} />
                  </button>
                )}
              </article>
            ))}
            {visibleItems.length === 0 ? (
              <p className="empty-list">
                {items.length === 0 ? config.emptyNoItems : config.emptyNoMatch}
              </p>
            ) : null}
          </div>
        </Panel>
      </section>
    );
  }

  return (
    <section className={config.detailViewClassName} data-testid={detailTestId}>
      <div className="subview-actions sticky-subview-toolbar">
        <button className="ghost-button" type="button" onClick={() => setViewMode?.("list")}>
          <ChevronLeft size={16} />
          返回列表
        </button>
        {config.hideToolbarOnCreate && isCreateView ? null : (
          <div className="detail-toolbar-actions">
            {config.showEditButton !== false ? (
              <button
                className={isEditView ? "ghost-button disabled" : "ghost-button"}
                disabled={isEditView}
                type="button"
                data-testid={config.editDetailTestId}
                onClick={() => setViewMode?.("edit")}
              >
                <Pencil size={15} />
                修改
              </button>
            ) : null}
            {onDelete ? (
              <button
                className="ghost-button danger"
                type="button"
                data-testid={config.deleteDetailTestId}
                onClick={requestDelete}
              >
                <Trash2 size={15} />
                删除
              </button>
            ) : null}
          </div>
        )}
      </div>
      <section className="detail-surface">
        {renderDetail({ viewMode, isCreateView, isEditView, selected })}
      </section>
      {onDelete ? (
        <ConfirmDialog
          open={deleteDialogOpen}
          title={config.deleteDialog.title}
          description={config.deleteDialog.description(selected)}
          busy={deleteBusy}
          errorMessage={deleteError}
          onCancel={() => {
            if (deleteBusy) return;
            setDeleteError("");
            setDeleteDialogOpen(false);
          }}
          onConfirm={confirmDelete}
          testIdPrefix={config.deleteDialog.testIdPrefix}
        />
      ) : null}
    </section>
  );
}
