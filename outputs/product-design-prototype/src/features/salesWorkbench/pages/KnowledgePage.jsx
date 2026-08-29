import {
  ChevronLeft,
  FileText,
  Plus,
  Save,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { InfoList, ManualConfirmBox, Panel } from "../../../components/primitives.jsx";
import { useToast } from "../../../components/toast.jsx";
import { useNavigation } from "../../../app/useWorkbenchNavigation.jsx";
import { useWorkbenchActions } from "../../../app/useWorkbenchHandlers.jsx";
import { useWorkbenchData } from "../../../app/useWorkbenchData.jsx";
import {
  FormField,
  arrayFromText,
  generateBusinessSuggestion,
  joinedList,
  textFromArray,
} from "./shared.jsx";
import { EntityWorkspace } from "./EntityWorkspace.jsx";

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

function KnowledgeEditor({ selected, initialMode = "edit", onSaveKnowledge, onSaved, onCancel }) {
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

const knowledgeConfigBase = {
  listViewTestId: "knowledge-list-view",
  detailViewTestId: "knowledge-detail-view",
  listViewClassName: "knowledge-list-view",
  detailViewClassName: "knowledge-detail-view detail-scroll-view",
  listPanelClassName: "list-panel knowledge-list-panel",
  panelTitle: "知识列表",
  listMeta: (visible) => `${visible} 条`,
  skipLocalSearch: true,
  openDetailTestId: "knowledge-open-detail",
  editDetailTestId: "knowledge-edit-detail",
  deleteDetailTestId: "knowledge-delete-detail",
  createAction: {
    testId: "knowledge-create-detail",
    label: "新增知识",
    icon: <Plus size={16} />,
  },
  emptyNoItems: "暂无知识材料，可点击“新增知识”开始录入。",
  emptyNoMatch: "没有匹配材料，请调整关键词。",
  rowPrimary: (item) => item.title,
  rowSecondary: (item) => `${item.category} / ${(item.tags ?? []).slice(0, 2).join("、") || item.source || "知识材料"}`,
  renderRowBadge: () => <b className="pill tone-teal">已入库</b>,
  deleteDialog: {
    title: "确认删除知识材料",
    description: (selected) => `“${selected?.title ?? "当前知识材料"}”将从知识列表中移除，此操作不能撤销。`,
    entityName: (selected) => selected.title,
    testIdPrefix: "knowledge-delete",
    successTitle: "知识材料已删除",
    errorMessage: "删除知识失败，请稍后重试。",
  },
};

function KnowledgeDetailBody({
  selected,
  viewMode,
  setViewMode,
  onSelect,
  onSaveKnowledge,
  customer,
  opportunity,
  apiClient,
  backendStatus,
  onCiteKnowledge,
}) {
  const isCreateView = viewMode === "create";
  const isEditView = viewMode === "edit";
  const toast = useToast();
  const [citationStatus, setCitationStatus] = useState("选择知识材料后，可生成带来源引用的方案或周报草稿。");
  const [citingTarget, setCitingTarget] = useState(null);

  async function citeKnowledge(target) {
    if (!selected?.id || !onCiteKnowledge) {
      setCitationStatus("当前没有可引用的知识材料。");
      return;
    }
    const targetLabel = target === "weekly" ? "周报" : "方案";
    setCitingTarget(target);
    setCitationStatus(`正在引用到${targetLabel}草稿，并保留来源`);
    try {
      await onCiteKnowledge(target, selected);
      setCitationStatus(`已引用到${targetLabel}草稿，正在打开目标页面。`);
      toast({ tone: "success", title: `已引用到${targetLabel}草稿`, description: selected.title });
    } catch (error) {
      setCitationStatus(error.message || `引用到${targetLabel}失败，请稍后重试。`);
    } finally {
      setCitingTarget(null);
    }
  }

  if (isCreateView || isEditView) {
    return (
      <KnowledgeEditor
        selected={isCreateView ? null : selected}
        initialMode={isCreateView ? "new" : "edit"}
        onSaveKnowledge={onSaveKnowledge}
        onSaved={(saved) => {
          onSelect(saved.id);
          setViewMode?.("detail");
        }}
        onCancel={() => setViewMode?.(isCreateView ? "list" : "detail")}
      />
    );
  }

  return (
    <>
      <div className="tag-row">
        {(selected.tags ?? []).map((tag) => (
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
      <Panel title="引用口径" meta={selected.source ?? "知识库"}>
        <div className="insight">{selected.content ?? selected.summary}</div>
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
              knowledgeId: selected.id,
              knowledge: selected.title,
              category: selected.category,
              tags: joinedList(selected.tags),
              summary: selected.summary,
              content: selected.content,
              source: selected.source,
            },
          })
        }
      />
    </>
  );
}

export function KnowledgePage({
  items = [],
  selected,
  onSelect,
  viewMode = "list",
  setViewMode,
}) {
  const { apiClient, backendStatus, workbenchCustomers, workbenchOpportunities } = useWorkbenchData();
  const { selectedCustomerId, selectedOpportunityId } = useNavigation();
  const {
    handleSaveKnowledge,
    handleDeleteKnowledge,
    handleSearchKnowledge,
    handleCiteKnowledge,
  } = useWorkbenchActions();
  const [searchText, setSearchText] = useState("");
  const [visibleItems, setVisibleItems] = useState(items);
  const [searchStatus, setSearchStatus] = useState("按客户、场景或标签检索销售材料。");
  const current = selected ?? visibleItems[0] ?? null;
  const customer = workbenchCustomers.find((item) => item.id === selectedCustomerId) ?? null;
  const opportunity = workbenchOpportunities.find((item) => item.id === selectedOpportunityId) ?? null;

  useEffect(() => {
    setVisibleItems(items);
  }, [items]);

  function changeSearchText(value) {
    setSearchText(value);
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
      const results = await handleSearchKnowledge({ query: searchText, tags });
      setVisibleItems(results);
      if (results[0]) onSelect(results[0].id);
      setSearchStatus(`已找到 ${results.length} 条可引用材料`);
    } catch {
      setSearchStatus("检索失败，请稍后重试或更换关键词。");
    }
  }

  const config = useMemo(() => ({
    ...knowledgeConfigBase,
    renderSearch: () => (
      <>
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
      </>
    ),
  }), [searchText, searchStatus, items]);

  return (
    <EntityWorkspace
      items={visibleItems}
      selected={current}
      activeRowId={current?.id}
      onSelect={onSelect}
      viewMode={viewMode}
      setViewMode={setViewMode}
      config={config}
      onDelete={handleDeleteKnowledge}
      renderDetail={({ viewMode: mode }) => (
        <KnowledgeDetailBody
          selected={current}
          viewMode={mode}
          setViewMode={setViewMode}
          onSelect={onSelect}
          onSaveKnowledge={handleSaveKnowledge}
          customer={customer}
          opportunity={opportunity}
          apiClient={apiClient}
          backendStatus={backendStatus}
          onCiteKnowledge={handleCiteKnowledge}
        />
      )}
    />
  );
}
