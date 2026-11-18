-- 首版世界数据库的初始表结构：部署级、分支级与运行级三类表、索引与约束。
-- 由存储适配器在启动时按编号顺序执行，已执行版本记入 schema_migrations；只追加新迁移，不修改本文件。
-- 分支级表的分支复制列清单由适配器从本迁移推导，运行级数据按 run 归档且从不复制。

-- ===== deployment scope =====
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE worlds (
  world_id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  content_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE branches (
  branch_id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(world_id),
  kind TEXT NOT NULL CHECK (kind IN ('online', 'experiment', 'snapshot', 'sandbox')),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'frozen', 'archived')),
  parent_branch_id TEXT REFERENCES branches(branch_id),
  forked_at_world_seq INTEGER,
  run_id TEXT UNIQUE,
  profile_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE world_aliases (            -- alias 'online' points at exactly one branch
  alias TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(branch_id),
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,      -- sha256 of the bearer token
  principal_id TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE stream_tickets (
  ticket_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE scenario_drafts (          -- console-authored cards; built-in cards come from the content pack
  card_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'withdrawn')),
  content_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (card_id, version)
);

CREATE TABLE run_requests (             -- player "test preset" applications
  request_id TEXT PRIMARY KEY,
  requested_by TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  note TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE config_drafts (            -- console-saved assemblies / model layouts; refs resolve repo files first, then drafts
  kind TEXT NOT NULL CHECK (kind IN ('assembly', 'model-layout', 'profile', 'toolset')),
  config_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, config_id, version)
);

-- ===== branch scope (copied by forkBranch) =====
CREATE TABLE clock (
  branch_id TEXT PRIMARY KEY REFERENCES branches(branch_id),
  world_tick INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('running', 'pausing', 'paused', 'resuming', 'stepping')),
  seconds_per_tick INTEGER NOT NULL,
  run_version INTEGER NOT NULL,         -- incremented on every mode change; used as expectedVersion
  step_target_tick INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE aggregate_state (
  branch_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY (branch_id, aggregate_type, aggregate_id)
);

CREATE TABLE domain_events (
  branch_id TEXT NOT NULL,
  world_seq INTEGER NOT NULL,           -- 1, 2, 3 ... per branch
  event_id TEXT NOT NULL,
  world_tick INTEGER NOT NULL,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  principal_id TEXT NOT NULL,
  causation_ids_json TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  audience_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, world_seq),
  UNIQUE (branch_id, event_id)
);
CREATE INDEX domain_events_type ON domain_events (branch_id, type, world_seq);

CREATE TABLE command_receipts (
  branch_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, principal_id, command_id)
);

CREATE TABLE speech_commits (           -- authority-owned; inserted inside the command savepoint
  branch_id TEXT NOT NULL,
  approved_speech_artifact_ref TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (branch_id, approved_speech_artifact_ref)
);

CREATE TABLE jobs (                     -- tick-driven, synchronous rule/perception jobs
  branch_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,                 -- creation order within the branch: COALESCE(MAX(seq), 0) + 1 at insert
  kind TEXT NOT NULL,
  due_tick INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'done', 'cancelled', 'failed')),
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (branch_id, job_id),
  UNIQUE (branch_id, idempotency_key),
  UNIQUE (branch_id, seq)
);
CREATE INDEX jobs_due ON jobs (branch_id, status, due_tick, seq);

CREATE TABLE consumer_offsets (
  branch_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  last_world_seq INTEGER NOT NULL,
  PRIMARY KEY (branch_id, consumer_id)
);

CREATE TABLE consumer_inbox (
  branch_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, consumer_id, event_id)
);

CREATE TABLE conversation_lines (       -- read projection maintained by game.comms
  branch_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  dialogue_id TEXT NOT NULL,
  speaker_id TEXT NOT NULL,
  audience_json TEXT NOT NULL,
  text TEXT NOT NULL,
  world_tick INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (branch_id, conversation_id, seq)
);

CREATE TABLE agent_activations (        -- quota: at most 20 rows with status 'active' across non-frozen branches
  branch_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'dormant')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, agent_id)
);

CREATE TABLE controller_leases (
  branch_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  controller_kind TEXT NOT NULL CHECK (controller_kind IN ('agent', 'human')),
  controller_principal_id TEXT,         -- console account when human
  controller_epoch INTEGER NOT NULL,
  lease_expires_at TEXT,
  PRIMARY KEY (branch_id, agent_id)
);

CREATE TABLE observations (
  branch_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,               -- gameplay agents only; the player projection is built from ACL, not observations
  observation_seq INTEGER NOT NULL,     -- 1, 2, 3 ... per (branch, agent)
  observation_id TEXT NOT NULL,
  source_event_ids_json TEXT NOT NULL,
  source_observation_ids_json TEXT NOT NULL,
  occurred_at_tick INTEGER NOT NULL,
  sensed_at_tick INTEGER NOT NULL,
  known_at_tick INTEGER NOT NULL,
  channel TEXT NOT NULL,
  epistemic TEXT NOT NULL CHECK (epistemic IN ('witnessed', 'reported', 'inferred')),
  confidence REAL NOT NULL,
  release_policy_id TEXT NOT NULL,
  content_json TEXT NOT NULL,
  PRIMARY KEY (branch_id, agent_id, observation_seq),
  UNIQUE (branch_id, observation_id)
);

CREATE TABLE perception_state (
  branch_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  scanned_through_seq INTEGER NOT NULL,
  state_json TEXT NOT NULL,             -- dedupe keys, last-known projection, aggregation buckets
  PRIMARY KEY (branch_id, agent_id)
);

CREATE TABLE memory_records (           -- append-only row versions => immutable revision views
  branch_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  row_version INTEGER NOT NULL,
  module_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('episodic', 'relation', 'belief', 'prospective', 'core', 'public')),
  tier TEXT NOT NULL,                   -- module-defined, e.g. short | long | core | none
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'expired', 'evicted', 'retracted')),
  epistemic TEXT NOT NULL CHECK (epistemic IN ('verified-event', 'reported-claim', 'inference')),
  release_policy_id TEXT NOT NULL,
  valid_from_tick INTEGER NOT NULL,
  valid_until_tick INTEGER,
  created_revision INTEGER NOT NULL,
  retired_revision INTEGER,             -- NULL while this row version is current
  strength REAL NOT NULL DEFAULT 1,
  salience REAL NOT NULL DEFAULT 0,
  recall_count INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL,
  source_observation_ids_json TEXT NOT NULL,
  content_json TEXT NOT NULL,
  PRIMARY KEY (branch_id, agent_id, memory_id, row_version)
);
CREATE INDEX memory_visible ON memory_records (branch_id, agent_id, created_revision, retired_revision);

CREATE TABLE memory_revisions (
  branch_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  revision INTEGER NOT NULL,            -- 0 is the empty initial revision
  base_revision INTEGER NOT NULL,
  observation_seq_through INTEGER NOT NULL,
  world_seq_through INTEGER NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('init', 'ingest', 'maintenance', 'use', 'import')),
  plan_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, agent_id, revision)
);

CREATE TABLE memory_watermarks (
  branch_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  observation_seq_consumed INTEGER NOT NULL,
  durable_through_seq INTEGER NOT NULL,
  derived_through_seq INTEGER NOT NULL,
  derived_through_tick INTEGER NOT NULL,
  PRIMARY KEY (branch_id, agent_id)
);

CREATE TABLE triggers (                 -- persisted wake-up reasons; merged into turns by the scheduler
  branch_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  priority INTEGER NOT NULL,
  source_ref TEXT NOT NULL,             -- event id, job id or memory id
  created_tick INTEGER NOT NULL,
  dedupe_key TEXT NOT NULL,
  consumed_by_turn_id TEXT,
  PRIMARY KEY (branch_id, trigger_id),
  UNIQUE (branch_id, dedupe_key)
);

CREATE TABLE operations (
  branch_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, agent_id, operation_id),
  UNIQUE (branch_id, command_id)
);

-- ===== run scope (never copied; kept for audit) =====
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(world_id),
  branch_id TEXT NOT NULL UNIQUE REFERENCES branches(branch_id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'audit', 'open-loop', 'closed-loop')),
  status TEXT NOT NULL CHECK (status IN ('created', 'preflight-failed', 'ready', 'running', 'paused', 'completed', 'failed', 'invalid')),
  run_spec_json TEXT NOT NULL,
  manifest_json TEXT,
  manifest_hash TEXT,
  contaminated INTEGER NOT NULL DEFAULT 0,
  evidence_complete INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);

CREATE TABLE turn_runs (
  turn_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_turn_index INTEGER NOT NULL,    -- 1, 2, 3 ... per (branch, agent); used in random seeds instead of turn_id
  status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'waiting', 'deciding', 'executing', 'speaking', 'settling',
                                         'completed', 'failed', 'cancelled', 'budget-exhausted')),
  trigger_ids_json TEXT NOT NULL,
  input_frontier_json TEXT,
  memory_revision INTEGER,
  profile_hash TEXT NOT NULL,
  controller_epoch INTEGER NOT NULL,
  turn_lease_epoch INTEGER NOT NULL,
  lease_expires_at TEXT,
  terminal_reason TEXT,
  effective_json TEXT,                  -- requested/resolved/effective per stage
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX turn_runs_agent ON turn_runs (branch_id, agent_id, status);

CREATE TABLE maintenance_runs (         -- memory maintenance work with the same lease discipline as turns
  maintenance_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'completed', 'failed', 'cancelled')),
  trigger TEXT NOT NULL CHECK (trigger IN ('day-passed', 'importance', 'rebuild')),
  due_tick INTEGER NOT NULL,
  observation_seq_through INTEGER NOT NULL, -- observations covered by this task
  task_json TEXT NOT NULL,              -- 周期整理任务的 planMaintenance 结果（受控 JSON）
  base_revision INTEGER,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE model_attempts (
  attempt_id TEXT PRIMARY KEY,
  llm_call_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  work_ref TEXT NOT NULL,               -- turn id, maintenance id or probe result id
  agent_id TEXT,
  evaluator_id TEXT,
  purpose TEXT NOT NULL,
  model_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'superseded', 'cancelled')),
  is_effective INTEGER NOT NULL DEFAULT 0,
  request_artifact_id TEXT,
  response_artifact_id TEXT,
  usage_json TEXT,
  timings_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE tool_calls (
  tool_call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  provider_call_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('admitted', 'dispatched', 'settled')),
  args_hash TEXT NOT NULL,
  operation_id TEXT,
  command_id TEXT,
  execution_status TEXT CHECK (execution_status IN ('ok', 'error', 'unknown')),
  raw_artifact_id TEXT,
  view_artifact_id TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT,
  kind TEXT NOT NULL,                   -- context | model-request | model-response | tool-raw | tool-view | speech | manifest | export ...
  content_hash TEXT NOT NULL,
  mime TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  storage TEXT NOT NULL CHECK (storage IN ('inline', 'file')),
  body BLOB,                            -- inline when byte_size <= 65536
  file_path TEXT,                       -- data/artifacts/<artifact_id> otherwise
  redaction TEXT NOT NULL CHECK (redaction IN ('raw', 'redacted')),
  redacted_from TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE trace_spans (
  span_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  run_id TEXT,
  branch_id TEXT,
  agent_id TEXT,
  turn_id TEXT,
  module_id TEXT,
  module_version TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
  start_ms REAL NOT NULL,
  end_ms REAL,
  attrs_json TEXT NOT NULL
);
CREATE INDEX trace_spans_trace ON trace_spans (trace_id);
CREATE INDEX trace_spans_turn ON trace_spans (turn_id);

CREATE TABLE lifecycle_events (         -- run/control log; never mixed with domain_events
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  branch_id TEXT,
  type TEXT NOT NULL,                   -- TurnQueued, ControllerChanged, ClockModeChanged, ModuleStarted ...
  subject_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE budget_ledger (
  entry_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT,
  work_ref TEXT NOT NULL,
  purpose TEXT NOT NULL,
  model_id TEXT NOT NULL,
  reserved_input INTEGER NOT NULL,
  reserved_output INTEGER NOT NULL,
  actual_input INTEGER,
  actual_output INTEGER,
  usage_unknown INTEGER NOT NULL DEFAULT 0,
  cost_estimate REAL,
  currency TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE TABLE snapshots (
  snapshot_id TEXT PRIMARY KEY,
  source_branch_id TEXT NOT NULL,
  frozen_branch_id TEXT NOT NULL UNIQUE REFERENCES branches(branch_id),
  world_seq INTEGER NOT NULL,
  world_tick INTEGER NOT NULL,
  label TEXT NOT NULL,
  manifest_hash TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE experiment_results (
  run_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL,
  numerator INTEGER,
  denominator INTEGER,
  details_json TEXT NOT NULL,
  PRIMARY KEY (run_id, metric)
);

CREATE TABLE probe_results (
  probe_result_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  script_id TEXT NOT NULL,
  probe_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  asked_at_tick INTEGER NOT NULL,
  answer_text TEXT,
  decision_json TEXT,
  score_json TEXT,
  valid INTEGER NOT NULL,
  invalid_reason TEXT,
  created_at TEXT NOT NULL
);
