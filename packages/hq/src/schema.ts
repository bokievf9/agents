/** HQ schema. Times are epoch ms. The core ApprovalQueue owns `approvals`, `trust` and `decisions`. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  dept TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('director','head','worker')),
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  boss_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  trust_level INTEGER NOT NULL DEFAULT 0,
  bot TEXT,
  budget_usd_month REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  dept TEXT NOT NULL,
  assignee_id TEXT,
  creator TEXT NOT NULL CHECK (creator IN ('owner','director','head','routine')),
  parent_id INTEGER,
  status TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox','assigned','running','review','approval','done','blocked','rejected')),
  priority INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER,
  result TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '',
  routine_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_dept_status ON tasks (dept, status);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent_id);
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT,
  body TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task_id);
CREATE TABLE IF NOT EXISTS task_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  approval_id INTEGER,
  dept TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','asked','executed','rejected','failed')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  cron TEXT NOT NULL,
  dept TEXT NOT NULL,
  assignee_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 0,
  overlap TEXT NOT NULL DEFAULT 'skip' CHECK (overlap IN ('skip','allow')),
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  last_task_id INTEGER
);
CREATE TABLE IF NOT EXISTS heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered')),
  wakes INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS heartbeats_due ON heartbeats (status, due_at);
CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  agent_id TEXT NOT NULL,
  dept TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS costs_dept_at ON costs (dept, at);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  action TEXT NOT NULL,
  object_type TEXT,
  object_id TEXT,
  detail TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
