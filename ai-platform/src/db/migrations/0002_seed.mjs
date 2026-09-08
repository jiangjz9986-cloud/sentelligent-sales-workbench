import { randomUUID } from "node:crypto";

export const version = "0002";

const now = "2026-09-07T00:00:00.000Z";

const agents = [
  ["weekly", "销售周报", "销售周报生成与证据整理", ["weekly.generate"]],
  ["quick-record", "快速记录", "销售快速记录结构化分析", ["quick-record.analyze"]],
  ["suggestion", "业务建议", "手工业务建议生成", ["suggestion.generate"]],
  ["customer-temperature", "客户温度", "拜访后客户关系温度建议", ["customer.temperature"]],
  ["sales-decision", "销售决策", "商机和客户销售诊断", ["sales-decision.analyze"]],
  ["itinerary", "行程增强", "行程和拜访安排增强", ["itinerary.enhance"]],
  ["assistant", "全局助手", "已登记助手意图和受限工具编排", ["assistant.execute"]],
  ["proactive", "主动分析", "后台主动分析和建议", ["proactive.analyze"]],
  ["payment-proof", "付款凭证", "付款凭证识别候选", ["payment-proof.recognize"]],
  ["invoice", "发票识别", "发票识别候选", ["invoice.recognize"]],
  ["bookkeeping", "记账提取", "记账候选提取", ["bookkeeping.extract"]],
  ["asr", "语音转写", "语音转写", ["asr.transcribe"]],
];

function insertIgnore(db, sql, params) {
  db.prepare(sql).run(params);
}

export function apply(db) {
  const providerId = "provider-mock";
  const modelId = "model-mock-standard-v1";
  insertIgnore(db, `
    INSERT INTO providers (id, name, kind, enabled, config_json, created_at, updated_at)
    VALUES ($id, '本地模拟供应商', 'mock', 1, '{}', $now, $now)
  `, { $id: providerId, $now: now });
  insertIgnore(db, `
    INSERT INTO models (id, provider_id, name, capabilities_json, enabled, created_at, updated_at)
    VALUES ($id, $providerId, 'mock-standard-v1', $capabilities, 1, $now, $now)
  `, {
    $id: modelId,
    $providerId: providerId,
    $capabilities: JSON.stringify({ text: true, vision: true, audio: true, external: false }),
    $now: now,
  });
  insertIgnore(db, `
    INSERT INTO price_versions (
      id, model_id, version, currency, input_micro_per_1k, output_micro_per_1k,
      cached_input_micro_per_1k, audio_micro_per_minute, image_micro_per_page,
      function_fee_micro, effective_from, created_at
    ) VALUES ($id, $modelId, 'mock-zero-v1', 'USD', 0, 0, 0, 0, 0, 0, $now, $now)
  `, { $id: "price-mock-zero-v1", $modelId: modelId, $now: now });

  insertIgnore(db, `
    INSERT INTO standards (id, slug, name, description, lifecycle, created_at, updated_at)
    VALUES ('standard-grounding', 'grounding', '事实与证据规范', '区分事实、推断、未知和建议，并保留来源引用。', 'active', $now, $now)
  `, { $now: now });
  insertIgnore(db, `
    INSERT INTO standard_versions (id, standard_id, version, content, rules_json, created_by, created_at)
    VALUES ('standard-grounding-v1', 'standard-grounding', '1.0.0', $content, $rules, 'system-seed', $now)
  `, {
    $content: "只使用服务端提供的 owner-scoped 事实；不得编造身份、金额、日期或实体关系；模型输出不能直接写回业务档案。",
    $rules: JSON.stringify({ requireSourceRefs: true, requireUnknowns: true, forbidDirectWrite: true }),
    $now: now,
  });

  for (const [slug, name, description, taskTypes] of agents) {
    const agentId = `agent-${slug}`;
    const agentVersionId = `${agentId}-v1`;
    insertIgnore(db, `
      INSERT INTO agents (id, slug, name, description, lifecycle, created_at, updated_at)
      VALUES ($id, $slug, $name, $description, 'active', $now, $now)
    `, { $id: agentId, $slug: slug, $name: name, $description: description, $now: now });
    insertIgnore(db, `
      INSERT INTO agent_versions (
        id, agent_id, version, task_types_json, system_prompt, instructions_json,
        tools_json, model_policy_json, input_schema_json, output_schema_json,
        standard_ids_json, limits_json, created_by, created_at
      ) VALUES ($id, $agentId, '1.0.0', $taskTypes, $prompt, $instructions,
        '[]', $modelPolicy, $inputSchema, $outputSchema, $standards, $limits, 'system-seed', $now)
    `, {
      $id: agentVersionId,
      $agentId: agentId,
      $taskTypes: JSON.stringify(taskTypes),
      $prompt: `你是森特智行的${name}Agent。只基于服务端业务快照输出结构化结果，${description}。`,
      $instructions: JSON.stringify({ factsFirst: true, noDirectWrite: true }),
      $modelPolicy: JSON.stringify({ providerId, modelId, externalAllowed: false }),
      $inputSchema: JSON.stringify({ type: "object" }),
      $outputSchema: JSON.stringify({ type: "object", required: ["facts", "inferences", "unknowns", "sourceRefs"] }),
      $standards: JSON.stringify(["standard-grounding-v1"]),
      $limits: JSON.stringify({ maxTokens: 3200, timeoutMs: 30_000, maxSteps: 8 }),
      $now: now,
    });
    insertIgnore(db, `
      INSERT INTO agent_releases (id, agent_id, agent_version_id, status, published_by, published_at)
      VALUES ($id, $agentId, $agentVersionId, 'active', 'system-seed', $now)
    `, { $id: `${agentVersionId}-release`, $agentId: agentId, $agentVersionId: agentVersionId, $now: now });
  }

  insertIgnore(db, `
    INSERT INTO budget_policies (
      id, scope_type, scope_key, period, currency, amount_micro, call_limit,
      warning_percent, enabled, created_at, updated_at
    ) VALUES ('budget-global-daily', 'global', '__global__', 'daily', 'USD', 1000000000, 500, 80, 1, $now, $now)
  `, { $now: now });
  insertIgnore(db, `
    INSERT INTO schedules (
      id, slug, name, task_type, feature, interval_seconds, enabled,
      input_template_json, created_at, updated_at
    ) VALUES ('schedule-proactive', 'proactive-default', '主动分析（默认关闭）', 'proactive.analyze', 'proactive-assistant', 3600, 0, '{}', $now, $now)
  `, { $now: now });
}
