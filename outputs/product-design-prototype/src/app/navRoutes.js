// Navigation wiring between sidebar ids and route pages. Kept in a plain
// module (no JSX imports) so routes.test.js can assert the maps stay
// consistent — the v0.7.1 bookkeeping-log page shipped unreachable because
// these maps lived inside App.jsx without coverage.

export const ROUTE_BY_ACTIVE = Object.freeze({
  overview: Object.freeze({ page: "overview", mode: "index" }),
  quick: Object.freeze({ page: "quick-records", mode: "new" }),
  customer: Object.freeze({ page: "customers", mode: "list" }),
  "hospital-tenders": Object.freeze({ page: "hospital-tenders", mode: "index" }),
  opportunity: Object.freeze({ page: "opportunities", mode: "list" }),
  actions: Object.freeze({ page: "actions", mode: "list" }),
  risk: Object.freeze({ page: "risks", mode: "list" }),
  kanban: Object.freeze({ page: "kanban", mode: "index" }),
  itinerary: Object.freeze({ page: "itineraries", mode: "list" }),
  expense: Object.freeze({ page: "travel-expenses", mode: "index" }),
  weekly: Object.freeze({ page: "weekly-reports", mode: "index" }),
  knowledge: Object.freeze({ page: "knowledge", mode: "list" }),
  settings: Object.freeze({ page: "settings/config", mode: "index" }),
  "settings-users": Object.freeze({ page: "settings/users", mode: "index" }),
  weixin: Object.freeze({ page: "settings/weixin", mode: "index" }),
  "settings-notifications": Object.freeze({ page: "settings/notifications", mode: "index" }),
  "settings-tender-schedule": Object.freeze({ page: "settings/tender-schedule", mode: "index" }),
  "settings-bookkeeping-log": Object.freeze({ page: "settings/bookkeeping-log", mode: "index" }),
  solution: Object.freeze({ page: "solutions", mode: "list" }),
});

export const ACTIVE_BY_ROUTE_PAGE = Object.freeze({
  overview: "overview",
  "quick-records": "quick",
  customers: "customer",
  "hospital-tenders": "hospital-tenders",
  opportunities: "opportunity",
  actions: "actions",
  risks: "risk",
  kanban: "kanban",
  itineraries: "itinerary",
  "travel-expenses": "expense",
  "weekly-reports": "weekly",
  knowledge: "knowledge",
  "settings/config": "settings",
  "settings/users": "settings-users",
  "settings/weixin": "weixin",
  "settings/notifications": "settings-notifications",
  "settings/tender-schedule": "settings-tender-schedule",
  "settings/bookkeeping-log": "settings-bookkeeping-log",
  solutions: "solution",
});

export const PARENT_NAV_BY_ACTIVE = Object.freeze({
  "hospital-tenders": "customer",
  actions: "opportunity",
  risk: "opportunity",
  kanban: "opportunity",
  weixin: "settings",
  "settings-users": "settings",
  "settings-notifications": "settings",
  "settings-tender-schedule": "settings",
  "settings-bookkeeping-log": "settings",
});

export const SETTINGS_SECTION_BY_ACTIVE = Object.freeze({
  settings: "security",
  "settings-notifications": "notifications",
  "settings-tender-schedule": "tender-schedule",
  "settings-bookkeeping-log": "bookkeeping-log",
});
