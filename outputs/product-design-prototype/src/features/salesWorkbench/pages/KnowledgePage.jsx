import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { InfoList, ManualConfirmBox, Panel } from "../../../components/primitives.jsx";
import { useToast } from "../../../components/toast.jsx";
import {
  ConfirmDialog,
  FormField,
  arrayFromText,
  generateBusinessSuggestion,
  joinedList,
  textFromArray,
} from "./shared.jsx";

function knowledgeToForm(item) {
  return {
    id: item?.id ?? "",
    title: item?.title ?? "",
    category: item?.category ?? "销售材料",
    tags: textFromArray(item?.tags),
    summary: item?.summary ?? "",
    content: item?.content ?? "",
    source: item?.source ?? "销售知识库",
  };
}

function knowledgeFromForm(form, isNew) {
  return {
    ...(isNew ? {} : { id: form.id }),
    title: form.title.trim(),
    category: form.category.trim(),
    tags: arrayFromText(form.tags),
    summary: form.summary.trim(),
    content: form.content.trim(),
    source: form.source.trim(),
  };
}

function KnowledgeEditor({ selected, initialMode = "edit", onSaveKnowledge, onSaved, onCancel, backendStatus }) {
  const [mode, setMode] = useState(initialMode);
  const [form, setForm] = useState(() => (initialMode === "new" ? knowledgeToForm(null) : knowledgeToForm(selected)));
  const [saveStatus, setSaveStatus] = useState("就绪");
  const isNew = mode === "new";

  useEffect(() => {
    if (mode === "edit") setForm(knowledgeToForm(selected));
  }, [selected, mode]);

  useEffect(() => {
    setMode(initialMode);
    setForm(initialMode === "new" ? knowledgeToForm(null) : knowledgeToForm(selected));
    setSaveStatus("就绪");
  }, [initialMode, selected]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    if (!form.title.trim()) {
      setSaveStatus("知识标题不能为空");
      return;
    }
    setSaveStatus("保存中");
    try {
      const saved = await onSaveKnowledge(knowledgeFromForm(form, isNew));
      setMode("edit");
      setForm(knowledgeToForm(saved));
      onSaved?.(saved);
      setSaveStatus("已保存到知识库");
    } catch (error) {
      setSaveStatus(error.message || "保存失败");
    }
  }

  return (
    <form className="editor-panel" data-testid="knowledge-editor" onSubmit={submit}>
      <div className="editor-head">
        <div>
          <span className="eyebrow">知识维护</span>
          <strong>{isNew ? "新增销售知识" : "编辑当前知识"}</strong>
        </div>
        <div className="editor-actions">
          <button className="ghost-button" type="button" data-testid="knowledge-cancel-edit" onClick={() => {
            setForm(isNew ? knowledgeToForm(null) : knowledgeToForm(selected));
            setSaveStatus("就绪");
            onCancel?.();
          }}>
            <ChevronLeft size={16} />
            {isNew ? "取消新增" : "取消修改"}
          </button>
          <button className="primary-button" type="submit">
            <Save size={16} />
            {isNew ? "创建知识" : "保存知识"}
          </button>
        </div>
      </div>
      <div className="editor-grid">
        <FormField label="标题">
          <input value={form.title} onChange={(event) => update("title", event.target.value)} />
        </FormField>
        <FormField label="分类">
          <input value={form.category} onChange={(event) => update("category", event.target.value)} />
        </FormField>
        <FormField label="标签">
          <input value={form.tags} onChange={(event) => update("tags", event.target.value)} placeholder="用逗号或换行分隔" />
        </FormField>
        <FormField label="来源">
          <input value={form.source} onChange={(event) => update("source", event.target.value)} />
        </FormField>
      </div>
      <FormField label="摘要">
        <textarea value={form.summary} onChange={(event) => update("summary", event.target.value)} />
      </FormField>
      <FormField label="正文 / 引用口径">
        <textarea value={form.content} onChange={(event) => update("content", event.target.value)} />
      </FormField>
      <div className="editor-status">{saveStatus}</div>
    </form>
  );
}

export function KnowledgePage({
  items = [],
  selected,
  onSelect,
  viewMode = "list",
  setViewMode,
  onSaveKnowledge,
  onDeleteKnowledge,
  onSearchKnowledge,
  onCiteKnowledge,
  customer,
  opportunity,
  apiClient,
  backendStatus,
}) {
  const [searchText, setSearchText] = useState("");
  const [visibleItems, setVisibleItems] = useState(items);
  const [searchStatus, setSearchStatus] = useState("按客户、场景或标签检索销售材料。");
  const [citationStatus, setCitationStatus] = useState("选择知识材料后，可生成带来源引用的方案或周报草稿。");
  const [citingTarget, setCitingTarget] = useState(null);
  const toast = useToast();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const current = selected ?? visibleItems[0] ?? null;

  useEffect(() => {
    setVisibleItems(items);
  }, [items]);

  function changeSearchText(value) {
    setSearchText(value);
    // 清空关键词即时还原全量列表，无需再点检索。
    if (!value.trim()) {
      setVisibleItems(items);
      setSearchStatus("按客户、场景或标签检索销售材料。");
    }
  }

  async function submitSearch(event) {
    event.preventDefault();
    if (!searchText.trim()) {
      setVisibleItems(items);
      setSearchStatus("已还原全部材料");
      return;
    }
    setSearchStatus("检索中");
    try {
      const tags = arrayFromText(searchText).filter((item) => item.length <= 12);
      const results = await onSearchKnowledge({ query: searchText, tags });
      setVisibleItems(results);
      if (results[0]) onSelect(results[0].id);
      setSearchStatus(`已找到 ${results.length} 条可引用材料`);
    } catch {
      setSearchStatus("检索失败，请稍后重试或更换关键词。");
    }
  }

  async function citeKnowledge(target) {
    if (!current?.id || !onCiteKnowledge) {
      setCitationStatus("当前没有可引用的知识材料。");
      return;
    }
    const targetLabel = target === "weekly" ? "周报" : "方案";
    setCitingTarget(target);
    setCitationStatus(`正在引用到${targetLabel}草稿，并保留来源`);
    try {
      await onCiteKnowledge(target, current);
      setCitationStatus(`已引用到${targetLabel}草稿，正在打开目标页面。`);
      toast({ tone: "success", title: `已引用到${targetLabel}草稿`, description: current.title });
    } catch (error) {
      setCitationStatus(error.message || `引用到${targetLabel}失败，请稍后重试。`);
    } finally {
      setCitingTarget(null);
    }
  }

  function openDetail(item) {
    onSelect(item.id);
    setViewMode?.("detail");
  }

  const isCreateView = viewMode === "create";
  const isEditView = viewMode === "edit";

  function requestDeleteCurrentKnowledge() {
    if (!current?.id || !onDeleteKnowledge) return;
    setDeleteError("");
    setDeleteDialogOpen(true);
  }

  async function confirmDeleteCurrentKnowledge() {
    if (!current?.id || !onDeleteKnowledge || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const deletedTitle = current.title;
      await onDeleteKnowledge(current.id);
      setDeleteDialogOpen(false);
      setViewMode?.("list");
      toast({ tone: "success", title: "知识材料已删除", description: deletedTitle });
    } catch (error) {
      setDeleteError(error.message || "删除知识失败，请稍后重试。");
    } finally {
      setDeleteBusy(false);
    }
  }

  if (viewMode === "list") {
    return (
      <section className="knowledge-list-view" data-testid="knowledge-list-view">
        <Panel
          title="知识列表"
          meta={`${visibleItems.length} 条`}
          className="list-panel knowledge-list-panel"
          action={(
            <button
              className="primary-button"
              type="button"
              data-testid="knowledge-create-detail"
              onClick={() => setViewMode?.("create")}
            >
              <Plus size={16} />
              新增知识
            </button>
          )}
        >
          <form className="knowledge-search" data-testid="knowledge-search" onSubmit={submitSearch}>
            <label className="search-box compact">
              <Search size={16} />
              <input
                aria-label="搜索知识库材料"
                value={searchText}
                onChange={(event) => changeSearchText(event.target.value)}
                placeholder="搜索移动云、双活、调研模板"
              />
            </label>
            <button className="ghost-button" type="submit">
              <Search size={15} />
              检索
            </button>
          </form>
          <p className="list-hint">{searchStatus}</p>
          <div className="list-stack">
            {visibleItems.map((item) => (
              <article
                className={`list-button customer-list-row ${current?.id === item.id ? "selected" : ""}`}
                key={item.id}
              >
                <button className="list-row-main" type="button" onClick={() => onSelect(item.id)}>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.category} / {(item.tags ?? []).slice(0, 2).join("、") || item.source || "知识材料"}</small>
                  </span>
                  <b className="pill tone-teal">已入库</b>
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  data-testid="knowledge-open-detail"
                  onClick={() => openDetail(item)}
                >
                  查看详情
                  <ChevronRight size={15} />
                </button>
              </article>
            ))}
            {visibleItems.length === 0 ? (
              <p className="empty-list">
                {items.length === 0 ? "暂无知识材料，可点击“新增知识”开始录入。" : "没有匹配材料，请调整关键词。"}
              </p>
            ) : null}
          </div>
        </Panel>
      </section>
    );
  }

  return (
    <section className="knowledge-detail-view detail-scroll-view" data-testid="knowledge-detail-view">
      <div className="subview-actions sticky-subview-toolbar">
        <button className="ghost-button" type="button" onClick={() => setViewMode?.("list")}>
          <ChevronLeft size={16} />
          返回列表
        </button>
        {!isCreateView ? (
          <div className="detail-toolbar-actions">
            <button
              className={isEditView ? "ghost-button disabled" : "ghost-button"}
              disabled={isEditView}
              type="button"
              data-testid="knowledge-edit-detail"
              onClick={() => setViewMode?.("edit")}
            >
              <Pencil size={15} />
              修改
            </button>
            <button
              className="ghost-button danger"
              type="button"
              data-testid="knowledge-delete-detail"
              onClick={requestDeleteCurrentKnowledge}
            >
              <Trash2 size={15} />
              删除
            </button>
          </div>
        ) : null}
      </div>
      <section className="detail-surface">
        {(isCreateView || isEditView) ? (
          <KnowledgeEditor
            selected={isCreateView ? null : current}
            initialMode={isCreateView ? "new" : "edit"}
            onSaveKnowledge={onSaveKnowledge}
            onSaved={(saved) => {
              onSelect(saved.id);
              setViewMode?.("detail");
            }}
            onCancel={() => setViewMode?.(isCreateView ? "list" : "detail")}
            backendStatus={backendStatus}
          />
        ) : null}
        {!isCreateView && !isEditView && (
          <>
        <div className="tag-row">
          {(current.tags ?? []).map((tag) => (
            <span className="pill" key={tag}>{tag}</span>
          ))}
        </div>
        <section className="citation-panel" data-testid="knowledge-citation-actions">
          <div>
            <span className="eyebrow">引用到业务汇报</span>
            <strong>{customer?.name ?? "当前客户"} / {opportunity?.name ?? "当前商机"}</strong>
            <p>{citationStatus}</p>
          </div>
          <div className="citation-actions">
            <button
              className="primary-button"
              type="button"
              disabled={citingTarget !== null}
              onClick={() => citeKnowledge("weekly")}
            >
              <FileText size={16} />
              {citingTarget === "weekly" ? "生成中" : "引用到周报"}
            </button>
          </div>
        </section>
        <Panel title="引用口径" meta={current.source ?? "知识库"}>
          <div className="insight">{current.content ?? current.summary}</div>
        </Panel>
        <Panel title="引用场景" meta="销售使用建议">
          <InfoList
            items={["客户现场答疑", "方案大纲引用", "领导汇报材料", "竞品应对话术"]}
            tone="teal"
          />
        </Panel>
        <ManualConfirmBox
          title="生成知识引用建议"
          desc="引用知识库材料前需要人工确认客户场景，避免把不匹配的案例写进业务材料。"
          onGenerate={() =>
            generateBusinessSuggestion(apiClient, backendStatus, {
              type: "knowledge_talk",
              title: "生成知识引用建议",
              context: {
                knowledgeId: current.id,
                knowledge: current.title,
                category: current.category,
                tags: joinedList(current.tags),
                summary: current.summary,
                content: current.content,
                source: current.source,
              },
            })
          }
        />
          </>
        )}
      </section>
      <ConfirmDialog
        open={deleteDialogOpen}
        title="确认删除知识材料"
        description={`“${current?.title ?? "当前知识材料"}”将从知识列表中移除，此操作不能撤销。`}
        busy={deleteBusy}
        errorMessage={deleteError}
        onCancel={() => {
          if (deleteBusy) return;
          setDeleteError("");
          setDeleteDialogOpen(false);
        }}
        onConfirm={confirmDeleteCurrentKnowledge}
        testIdPrefix="knowledge-delete"
      />
    </section>
  );
}
