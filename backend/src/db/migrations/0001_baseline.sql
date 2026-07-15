CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT,
  type TEXT,
  level TEXT,
  owner TEXT,
  contact TEXT,
  relation INTEGER DEFAULT 0,
  stakeholders TEXT NOT NULL DEFAULT '[]',
  decision_chain TEXT NOT NULL DEFAULT '[]',
  history_projects TEXT NOT NULL DEFAULT '[]',
  infrastructure TEXT NOT NULL DEFAULT '[]',
  sync_preview TEXT NOT NULL DEFAULT '[]',
  budget TEXT,
  summary TEXT,
  needs TEXT NOT NULL DEFAULT '[]',
  risks TEXT NOT NULL DEFAULT '[]',
  opportunities TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  customer TEXT,
  stage TEXT,
  amount TEXT,
  owner TEXT,
  probability INTEGER DEFAULT 0,
  days INTEGER DEFAULT 0,
  requirements TEXT NOT NULL DEFAULT '[]',
  competitors TEXT NOT NULL DEFAULT '[]',
  solution_direction TEXT NOT NULL DEFAULT '[]',
  source_record TEXT,
  risk TEXT,
  next TEXT,
  tone TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quick_records (
  id TEXT PRIMARY KEY,
  raw_content TEXT NOT NULL,
  occurred_at TEXT,
  source_channel TEXT,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  opportunity_id TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'recorded',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_insights (
  id TEXT PRIMARY KEY,
  quick_record_id TEXT NOT NULL REFERENCES quick_records(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'mock',
  confidence INTEGER NOT NULL DEFAULT 70,
  analysis_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS manual_confirmations (
  id TEXT PRIMARY KEY,
  quick_record_id TEXT NOT NULL REFERENCES quick_records(id) ON DELETE CASCADE,
  target TEXT NOT NULL CHECK (target IN ('customer', 'opportunity', 'weekly')),
  confirmed_by TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (quick_record_id, target)
);

CREATE TABLE IF NOT EXISTS weekly_reports (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  content TEXT NOT NULL,
  source_refs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS solution_drafts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  artifact_type TEXT NOT NULL DEFAULT 'solution_framework',
  title TEXT NOT NULL,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  opportunity_id TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  content TEXT NOT NULL,
  source_refs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated',
  content TEXT NOT NULL,
  source_refs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS action_items (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  opportunity_id TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  customer TEXT,
  reason TEXT,
  due TEXT,
  assignee TEXT,
  priority TEXT NOT NULL DEFAULT '中',
  status TEXT NOT NULL DEFAULT 'pending',
  source_record_id TEXT UNIQUE REFERENCES quick_records(id) ON DELETE SET NULL,
  tone TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS risk_items (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  opportunity_id TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  target TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 60,
  severity TEXT NOT NULL DEFAULT '中',
  status TEXT NOT NULL DEFAULT 'open',
  evidence TEXT NOT NULL,
  action TEXT NOT NULL,
  assignee TEXT,
  due TEXT,
  source_type TEXT NOT NULL DEFAULT 'opportunity',
  source_id TEXT,
  tone TEXT NOT NULL DEFAULT 'amber',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS knowledge_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  content TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  actor TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_opportunities_customer_id ON opportunities(customer_id);
CREATE INDEX IF NOT EXISTS idx_quick_records_status ON quick_records(status);
CREATE INDEX IF NOT EXISTS idx_ai_insights_quick_record_id ON ai_insights(quick_record_id);
CREATE INDEX IF NOT EXISTS idx_manual_confirmations_target ON manual_confirmations(target);
CREATE INDEX IF NOT EXISTS idx_weekly_reports_period ON weekly_reports(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_solution_drafts_customer_id ON solution_drafts(customer_id);
CREATE INDEX IF NOT EXISTS idx_solution_drafts_opportunity_id ON solution_drafts(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_type ON ai_suggestions(type);
CREATE INDEX IF NOT EXISTS idx_action_items_status ON action_items(status);
CREATE INDEX IF NOT EXISTS idx_action_items_source_record_id ON action_items(source_record_id);
CREATE INDEX IF NOT EXISTS idx_risk_items_status ON risk_items(status);
CREATE INDEX IF NOT EXISTS idx_risk_items_opportunity_id ON risk_items(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_risk_items_source ON risk_items(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_items_category ON knowledge_items(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_items_updated_at ON knowledge_items(updated_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
