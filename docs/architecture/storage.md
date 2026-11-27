# 存储：SQLite 表结构、分支复制与事务规则

> 状态：实现规范。首版只有一个 SQLite 文件 `data/world-prism.db`，由 `platform.storage.sqlite` 适配器独占；其他模块只能经 storage port 访问自己拥有的表。逻辑语义（幂等、水位、快照一致性）见 [事件与状态](events-and-state.md)，聚合所有权见 [领域模型](domain-model.md) 第 3 节。

## 1. 连接与事务规则

- 使用 Node 内置 `node:sqlite` 的 `DatabaseSync`。启动时执行：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

- 整个进程只有一个写连接。所有写操作都经过适配器的 `transact(fn)`：`BEGIN IMMEDIATE` → 同步执行 `fn` → `COMMIT`，`fn` 抛错则 `ROLLBACK`。**事务内禁止 `await`**：模型调用、等待、网络 I/O 一律放在事务外。`DatabaseSync` 是同步的，只要不在事务里 await，写入就天然串行。
- 读操作可以用同一连接，也可以另开只读连接（`readOnly: true`）给控制台查询用。
- JSON 字段一律存为 `TEXT`，写入前用规范 JSON 序列化；读出后用 Zod 校验。
- 时间：`*_at` 列存 ISO-8601 UTC 字符串（来自宿主时钟端口）；游戏时间只用 `*_tick` 整数列。
- 迁移：`modules/server/platform/storage/sqlite/migrations/NNNN_<name>.sql` 按编号顺序在启动时执行，已执行的版本与内容校验和记入 `schema_migrations`；迁移只追加，不修改已发布的迁移文件。启动时逐版本比对校验和，文件缺失或内容漂移都会以 `invalid-state` 拒绝启动并指出版本。

## 2. 表结构（`0001_init.sql` 与后续迁移）

分为三类：部署级（不随分支复制）、分支级（`branch_id` 为主键第一列，分支复制时整体拷贝）、运行级（按 `run_id` 归档，不复制）。

本节展示经后续迁移演进后的核心表结构（其中 `rule_failures`、`clock_stop_requests`、`trace_spans.started_at` 分别由 0006、0007、0013 追加，初始迁移 `0001_init.sql` 原建的 `conversation_lines` 已由 0010 移除）。完整迁移链为 0001–0020：0002 增加部署级 `operation_idempotency`，0003 把 `jobs_due` 换成只收录 `scheduled` 行的部分索引 `jobs_status_due_seq`，0004 为 `schema_migrations` 增加 `checksum` 并回填 0001–0003 指纹，0005 为 `turn_runs` 增加 `created_tick`，0006 新增 `rule_failures`，0007 新增 `clock_stop_requests`，0008 重建 `operation_idempotency` 加入 `'step'` 种类，0009–0013 补充预算日界、移除 `conversation_lines`、物化通信索引聚合（`conversation-line`、`conversation-membership`、`message-delivery` 并重写 `knowledge-grant` 键格式）、新增 `budget_ledger_unsettled` 部分索引及 `trace_spans.started_at` 与调试审计索引，0014–0020 见下文。0002 与 0003 的语句见 §2.1。

0016 为 Agent 热路径补索引，只新增索引、不改表结构：

| 索引 | 表与列 | 用途 |
|---|---|---|
| `triggers_pending` | `triggers (branch_id)`，`WHERE consumed_by_turn_id IS NULL` | 调度器读取未消费触发；索引只覆盖活跃集，不随已消费历史增长 |
| `turn_runs_active` | `turn_runs (branch_id, lease_expires_at)`，`WHERE status IN (...)` | 重启取消与租约过期恢复只扫非终态行，过滤条件与代码的非终态集合逐字一致 |
| `maintenance_runs_due` | `maintenance_runs (branch_id, due_tick, created_at, maintenance_id)` | 整理队列按分支取到期候选并排序 |
| `maintenance_runs_run_agent_due` | `maintenance_runs (run_id, agent_id, due_tick)` | turn 就绪检查在等待循环里按运行与角色读整理水位 |
| `maintenance_runs_task` | `maintenance_runs (branch_id, agent_id, trigger, due_tick)` | 入队与 `hasTask` 的任务去重查询 |

部分索引的过滤条件必须与代码查询逐字一致，否则优化器不会采用。额外一条约束：SQLite 只在谓词里看到字面量时才信任部分索引的成立条件，绑定参数会让 `turn_runs_active` 退化成全量索引扫描；因此非终态状态词由 `agent-runtime` 内联成字面量拼进 SQL，`tests/integration/agent-hot-path-indexes.test.ts` 直接对生产语句断言查询计划。

0017 为 `observations` 增加表达式部分索引 `observations_day_passed (branch_id, agent_id, known_at_tick DESC, observation_seq DESC)`，过滤条件为 `json_extract(content_json, '$.eventType') = 'DayPassed'`。取最近一次 `DayPassed` 的查询原先要按分支与角色把全部观察读进内存再逐行解码 JSON，成本随会话增长；该索引让过滤、排序与 `LIMIT 1` 都在索引内完成。

0018 为 `tool_calls` 新增覆盖索引 `tool_calls_turn_tool (run_id, turn_id, tool_id)` 与 `tool_calls_attempt_call (run_id, turn_id, attempt_id, provider_call_id, created_at)`，让配额计数与按调用 ID 查找首行不再仅靠 `(run_id, turn_id)` 前缀扫表回表。

0019 为 `domain_events` 增加表达式索引 `domain_events_dialogue (branch_id, type, CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.dialogueId') END, world_seq)`。会话读取要按一批对白 ID 找回各自的提交事件序号，原查询只能靠 `domain_events_type` 收窄到 `(branch_id, type)`，再把该分支全部 `DialogueSubmitted` 逐行解析 `payload_json` 比对 `dialogueId`，成本随对白事件数线性增长；把 `dialogueId` 提升为索引列后，按对白查找与取最大 `world_seq` 都在索引内完成。索引列先做 `json_valid` 守卫再取值：表达式索引对每一行求值，缺少守卫时非法 JSON 文本会让写入与建索引失败。表达式必须与查询写法逐字一致，`tests/integration/dialogue-event-index.test.ts` 按生产查询形状断言查询计划命中该索引。这条查询由 authority 的 `latestEventSeqsByPayload` 提供，宿主不拼接事件 SQL；可按取值查找的（事件类型，载荷字段）登记在 `indexedEventPayloadKeys`，字段名受契约载荷类型约束，新增登记必须配套表达式相同的索引。

0020 为 `trace_spans` 增加索引 `trace_spans_started_at (started_at)`，供保留期清理按截止时间分批定位过期跨度，见[第 6 节](#6-数据保留与轮转)。

`agent_activations` 保存单个身份的激活状态，表迁移负责行级约束。开局、恢复和独立名册激活均在各自事务内统计活动或暂停分支上的活动身份，并按 [部署级身份配额](../00-scope-and-invariants.md#5-验收与诚实性) 拒绝超额激活。配额不足时，本次已写入的激活行随事务或命令保存点回滚。经命令网关拒绝时，外层事务仍会提交拒绝回执。接入范围见 [IMPLEMENTATION-STATUS.md — 身份配额](../IMPLEMENTATION-STATUS.md#31-身份配额)。

```sql
-- ===== 部署级作用域 =====
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
-- 0004 为 schema_migrations 增加 checksum TEXT NOT NULL，并回填已发布迁移的内容指纹。

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

CREATE TABLE config_drafts (            -- 控制台保存的装配与模型布局；引用先解析仓库文件，再解析草稿
  kind TEXT NOT NULL CHECK (kind IN ('assembly', 'model-layout', 'profile', 'toolset')),
  config_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, config_id, version)
);

-- ===== 分支级作用域（由 forkBranch 复制） =====
CREATE TABLE clock (
  branch_id TEXT PRIMARY KEY REFERENCES branches(branch_id),
  world_tick INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('running', 'pausing', 'paused', 'resuming', 'stepping')),
  seconds_per_tick INTEGER NOT NULL,
  run_version INTEGER NOT NULL,         -- 每次模式变更时递增，用作 expectedVersion
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
-- 0019 为按对白 ID 取提交序号补表达式索引；索引列先做 json_valid 守卫，避免非法 JSON 让求值失败。
CREATE INDEX domain_events_dialogue ON domain_events
  (branch_id, type,
   CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.dialogueId') END,
   world_seq);

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

CREATE TABLE rule_failures (             -- 有界重试与死信记录；成功路径删除对应行
  branch_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('job', 'event', 'clock-step', 'worker')),
  subject_id TEXT NOT NULL,             -- jobId / 消费者 ID / 步骤 ID / tick-worker
  detail TEXT NOT NULL,                 -- 事件 ID、tick 或空字符串
  attempts INTEGER NOT NULL,
  reason_code TEXT NOT NULL,            -- 领域错误码或 plugin-failed
  last_error TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('retrying', 'failed')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, phase, subject_id, detail)
);
CREATE INDEX rule_failures_status_updated ON rule_failures (branch_id, status, updated_at);

CREATE TABLE clock_stop_requests (       -- 终局停止点：与业务结果同事务提交，重启后补做暂停
  branch_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_at_tick INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, request_id)
);

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

CREATE TABLE agent_activations (
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

-- ===== 运行级作用域（从不复制，仅保留用于审计） =====
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
  task_json TEXT NOT NULL,              -- MaintenanceTask returned by planMaintenance (memory.md §11.1)
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

CREATE TABLE trace_spans (              -- 观测跨度；唯一可按保留期裁剪的表，见第 6 节
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
  started_at TEXT,                      -- 墙上时钟开始时间；start_ms 仅用于单调时长
  attrs_json TEXT NOT NULL
);
CREATE INDEX trace_spans_trace ON trace_spans (trace_id);
CREATE INDEX trace_spans_turn ON trace_spans (turn_id);
-- 0020 为保留期清理按截止时间定位过期跨度补索引。
CREATE INDEX trace_spans_started_at ON trace_spans (started_at);

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
```

L6 公共编年史以 `agent_id = '~public'` 在分支内保存单份记录。公共行使用分支公共版本，不能与某个 Agent 的局部 `revision` 比较。每个记忆 revision 持久保存当时的 `public_revision`；读取时只合并该边界可见的活动公共版本，检索同时按查询 `worldTick` 过滤有效时间。之后发布的公共行不会改变旧视图。公共行提交在同一事务内校验记录种类、公开策略、所有来源观察及来源事件键，并按分支和规范化事件键去重。引用其他 Agent 的公共来源时，只接受冻结公共视图中已绑定且确实为公开观察的来源。

### 2.1 后续迁移

```sql
-- 迁移 0002_operation-idempotency.sql
-- 部署级表：主键不含 branch_id，不参与分支复制，在线别名切换与重启后仍然有效。
CREATE TABLE IF NOT EXISTS operation_idempotency (
  world_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('pause', 'resume', 'snapshot', 'restore', 'reset')), -- 0008 重建此表加入 'step'
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  result_json TEXT,
  error_code TEXT,
  error_retryable INTEGER NOT NULL DEFAULT 0,
  error_safe_message TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (world_id, principal_id, operation_id)
);

CREATE INDEX IF NOT EXISTS operation_idempotency_kind
  ON operation_idempotency (world_id, operation_kind, created_at);

-- 迁移 0003_jobs-scheduled-index.sql
-- 热路径只读最早到期的一条 scheduled job；部分索引避免已完成行留在索引里。
DROP INDEX jobs_due;
CREATE INDEX jobs_status_due_seq ON jobs (branch_id, status, due_tick, seq) WHERE status = 'scheduled';
```

模型预算迁移在 `budget_ledger` 中增加 `world_day`，让角色的每日额度与尝试归属关联。迁移为运行、角色与日期、工作引用建立账本索引，并按工作或状态索引尝试记录。已有记录保留原键。

记忆版本边界迁移 `0014_memory-revision-frontiers.sql` 为 `memory_revisions` 增加非负整数 `public_revision` 和 `derived_through_seq`，默认均为 0。前者固定公共行的可见范围，后者保存该 revision 已完成整理的观察水位；反思返回空数组、结果全部丢弃或看法被淘汰均不会丢失水位。旧 revision 使用零公共边界，不反推不同 Agent 的历史发布顺序。

run 控制幂等迁移 `0015_run-control-idempotency.sql` 新增部署级 `run_control_idempotency`：按 `(world_id, principal_id, operation_id, operation_kind)` 唯一保存启动/停止的首次结果，操作重放时直接返回原 `run_id` 与状态。主键包含 `world_id`，同一 operationId 在不同世界互不冲突；表不参与分支复制。

维护任务的 `task_json` 保存模型名额裁决 `modelQuotaGranted` 和实际调用日期 `modelCallDays`。配额裁决计入已租用、失败和已完成任务；模型池每次实际尝试发送前通过宿主注入的 `beforeAttempt` 在事务中占用执行日的名额（包括内部重试），失败和晚到结果仍计入。部分整理保留已提交规则变更，任务记为 `failed` 并绑定已提交 revision；重启或后续领取可重试；`rulesApplied` 保证已提交规则段不会重复执行，`failureAttempts` 最多允许三次实际失败。配额等待通过 `retryAfterTick` 延期，不消耗失败次数。模型工作预算按维护任务 ID 与租约代次隔离，单租约最多两次实际模型尝试，内部重试和冲突重算共享同一工作预算。纯规则任务不解析模型挂载。成功前不推进派生水位。

## 3. 分支复制 `forkBranch`

快照、恢复、实验分支和开环沙盒都用同一个操作：把源分支的全部分支级数据拷贝到一个新的 `branch_id`。数据规模很小（序章数千行），整表拷贝足够快，也最不容易出错。

```ts
// 所有分支级表（共 19 张），按以下顺序复制。
const BRANCH_TABLES = [
  "clock", "aggregate_state", "domain_events", "command_receipts", "speech_commits", "jobs",
  "rule_failures", "clock_stop_requests",
  "consumer_offsets", "consumer_inbox", "agent_activations",
  "controller_leases", "observations", "perception_state", "memory_records",
  "memory_revisions", "memory_watermarks", "triggers", "operations",
] as const;

function forkBranch(tx: Tx, src: string, dst: string, kind: BranchKind, runId: string | null): void {
  // 1. 插入 branches 行：parent = src，forked_at_world_seq = src 的最大 world_seq。
  // 2. 逐表执行 INSERT INTO t (branch_id, <other columns>) SELECT ?, <other columns> FROM t WHERE branch_id = ?。
  // 3. 在 dst 中修正：
  //    - clock.mode 设为 'paused'，run_version 递增 1。
  //    - controller_leases.controller_epoch = controller_epoch + 1（使所有针对 src 签发的控制失效）。
  //    - 被未达到 completed、failed 或 budget-exhausted 的 turn 消费的 trigger 重新释放；
  //      即 consumed_by_turn_id = NULL；已完成 turn 消费的 trigger 删除。
  //    - agent_activations.status = 'dormant'（调用方预留配额后再激活名册，见下表）。
}
```

列清单由迁移文件推导，适配器可按推导结果缓存为常量后执行 `INSERT ... SELECT`；分支级表清单必须排除登记分支本身的 `branches` 表（它的主键列同样叫 `branch_id`），并由测试断言该清单与迁移中所有分支内数据表一致，防止新增表漏拷。

新分支的 `branches` 行：

| kind | status | run_id |
|---|---|---|
| `snapshot` | `frozen` | null |
| `online` | `active` | 新建的 live run（沿用原 RunSpec 与 seed） |
| `experiment` | `active` | 该实验 run |
| `sandbox` | `active`，探针结束后改为 `archived` | null（探针结果记在所属实验 run 下） |

| 操作 | 实现 |
|---|---|
| 快照 | 先按 [运营](../platform/operations.md) 第 3 节静默源分支，再 `forkBranch(src, snap, 'snapshot')`，新分支 `status = 'frozen'`，写 `snapshots` 行 |
| 从快照恢复在线世界 | `forkBranch(snap, new, 'online')` → 预检 → 在同一事务中：先将旧在线分支设为 archived、其激活状态置为 dormant，再按名册预留配额并把新分支名册内 Agent 置为 active，最后切换 `world_aliases('online')`（配额不足则整个事务回滚，旧分支与别名保持不变） |
| 创建实验 run | 冷启动：新建空分支（时钟 paused、tick 0），由运行器以 `player-1` 身份提交 `campaign.start`；从快照：`forkBranch(snap, exp, 'experiment', runId)`，再按名册激活。每个 run 一个分支 |
| 开环探针沙盒 | `forkBranch(checkpointSnap, sandbox, 'sandbox')`，只激活被提问的 Agent（计入配额）；探针结束后释放配额、分支设为 archived，不再写入 |
| 灾备备份 | 在 `data/backups/` 下创建权限 `0700` 的 `world-prism-<UTC时间>[-<label>].<唯一后缀>.partial` 暂存目录并 `VACUUM INTO` 其中；确认非空且 `PRAGMA integrity_check` 返回 `ok` 后把文件权限收紧为 `0600`，再用硬链接独占发布为 `world-prism-<UTC时间>.db`（同名已存在时追加序号）；发布后按数量保留最近 20 份并清理更旧备份；失败时删除暂存目录；不复制正在写入的数据库文件 |

快照行的 `world_tick` 与 `world_seq` 是源分支在复制时刻的检查点，恢复预检再用同样的来源核对冻结分支是否仍与快照行一致。存档模块不直接读取这两类事实所在的表，两项查询都由宿主组合根在绑定存档端口时注入：`world_tick` 取宿主以时钟端口 `GameClockPort.readInTransaction` 提供的分支 tick 查询，`world_seq` 取 authority 的分支事件前沿查询 `branchEventFrontier`（该分支 `domain_events` 的最大 `world_seq`，没有事件时为 0）。两者都在存档操作所在的同一存储事务内读取。它们不经存档模块的 `requires` 解析，存档模块描述符只依赖 `platform.storage`，模块目录摘要与已冻结 run 的 manifest 不因此变化。

## 4. 常用查询

```sql
-- revision :R 可见的记忆记录
SELECT * FROM memory_records
WHERE branch_id = :b AND agent_id = :a AND created_revision <= :R
  AND (retired_revision IS NULL OR retired_revision > :R) AND status = 'active';

-- tick :T 到期的 job
SELECT * FROM jobs WHERE branch_id = :b AND status = 'scheduled' AND due_tick <= :T ORDER BY due_tick, seq;

-- 消费者尚未处理的新事件
SELECT * FROM domain_events WHERE branch_id = :b AND world_seq > :offset ORDER BY world_seq LIMIT 200;

-- 部署范围的活动 Agent 配额
SELECT count(*) FROM agent_activations a JOIN branches b ON a.branch_id = b.branch_id
WHERE a.status = 'active' AND b.status IN ('active', 'paused');
```

修改记忆记录（例如强度衰减）时，不能 `UPDATE` 内容列：先把当前行版本的 `retired_revision` 设为新 revision，再插入 `row_version + 1`、`created_revision = 新 revision` 的新行。这样任意旧 revision 都能按上面的查询原样重建。

`agent-runtime` 读取 revision 视图（含公共编年史）时直接执行上面这条可见性查询，提交记忆计划时只按 `retired_revision IS NULL` 取当前行版本，两者都由 `memory_visible` 索引在 SQLite 内过滤，不把某个主体的全部历史行版本读进内存。历史行版本按设计只追加不清理，旧 revision 的重建依赖它们。

观测 provider `platform.observability.sqlite` 只直接读写自己拥有的 `trace_spans`，生命周期审计经 module-sdk 的 `insertLifecycleAuditEvent` 写入。控制台时间线、Agent 列表、检查器、turn、记忆、观察、分支对比与调试队列需要的其他数据，经 module-sdk 声明的数据源端口 `ObservabilitySources` 读取，由各表的所有者在自己一侧把列与 JSON 路径解码为端口声明的类型化记录：

| 数据 | 提供方 | 查询 |
|---|---|---|
| `domain_events`、`command_receipts`、`branches` 的世界与 run 归属 | authority | `listTimelineEvents`、`listEventsAfter`、`latestEventSeq`、`readCommandReceipt`、`readBranch` |
| `turn_runs`、`triggers`、`tool_calls`，以及模型池按 turn 证据写入的 `model_attempts` | agent-runtime | `listTurnRuns`、`readTurnRun`、`listTurnTriggerKinds`、`countTurnToolCalls`、`listTurnModelUsages`、`listTurnModelAttempts`、`listTurnToolCalls`、`readSchedulerQueue`、`listStartedModelAttemptTimes` |
| `agent_activations`、`controller_leases`、`perception_state`、`memory_watermarks`、`memory_records`、`observations`、`maintenance_runs` | agent-runtime | `listAgentRuntimeStates`、`readPerceptionRevision`、`readMemoryWatermark`、`listMemoryRecordVersions`、`listObservationPage`、`listPendingMaintenance` |
| `lifecycle_events`、`artifacts` | module-sdk | `listLifecycleTimeline`、`latestLifecycleEventByOperation`、`readArtifactBody`（端口顶层的 `artifactBody`，不在 `read` 的存储快照内：超过内联上限的正文存放在文件中，须在事务外读取） |
| `runs.manifest_json` 中冻结的名册 | 宿主 | `rosterAgentKindsOf` |

角色位置经世界模块只读端口取得，调试触发的创建 tick 取自时钟 provider。宿主在 `apps/server/src/host/observability-sources.ts` 组合上述查询并绑定到观测 provider；调试唤醒是端口上唯一的写入，由宿主在一个事务内经 agent-runtime 登记调试触发、标记 run 受污染并写审计。时间线的类型、主体与节点筛选以及 limit 都在所有者的 SQL 内完成，按 operationId 查找调试审计的表达式与 0013 的 `lifecycle_debug_operation` 索引一致。表结构或 JSON 嵌套调整只需改所有者一侧的解码与测试：`tests/integration/observability-source-events.test.ts` 与 `observability-source-runtime.test.ts` 锁定列到字段的映射，其中 `turn_runs` 的列清单与观测记录字段逐一对照，名册读取以 `buildRunManifest` 冻结的 manifest 为准；替换观测实现不需要了解这些表的物理结构。

## 5. 存储验收

- 写入事务中途抛错，状态、事件、job 与 receipt 都不落库。
- 分支级表清单与迁移一致；`forkBranch` 之后，新分支的事件、状态、观察、记忆与源分支在 fork 点逐行相等，时钟为 paused，控制 epoch 已递增。
- 按 revision 重建记忆：在 revision 5 和 revision 9 各查询一次，结果与当时记录的 `plan_hash` 链一致。
- 备份先写入 `0700` 暂存目录并执行完整性校验，通过后以硬链接独占发布为最终 `.db`；`VACUUM INTO` 失败或校验失败时不残留可被当作有效备份的文件。- 成功发布后只保留最近 20 份备份，旧备份按文件名时间戳删除。
- `VACUUM INTO` 生成的备份可以被重新打开，`PRAGMA integrity_check` 返回 `ok`。
- 未配置保留天数时不创建清理定时器、不删除任何行；配置后只删除可轮转表中早于截止时间的行，每批删除与清理记录在同一事务提交（第 6 节）。

对白消费：authority 在 `speech.commit` 的 command savepoint 内检查并插入 `speech_commits`，与事件、receipt 一起提交；已有同分支 artifact 消费记录时返回 `speech-not-approved`。相同 commandId 先按 receipt 幂等返回。handler 或 afterCommand 拒绝时回滚消费记录；复制分支时保留记录，防止历史对白重复发布。只读 `approvedSpeech.read` 从持久化批准结果的内存索引同步读取。`speech` artifact 始终内联存储：turn 取消在命令事务内用 SQL 读取其正文判断回复是否已发布，事务内不做文件 I/O。

## 6. 数据保留与轮转

默认永久保留全部数据：没有配置保留天数时，存储适配器不创建清理定时器，任何表都不会被删除行。只有观测数据允许配置轮转；事实、审计与实验证据不在可轮转清单内，配置 schema 直接拒绝这些表名。

### 6.1 保留分类

| 类别 | 表 | 依据 |
|---|---|---|
| 可轮转 | `trace_spans` | 观测跨度，只承载耗时、阶段属性与 trace 关联。turn 阶段跨度的属性与 `turn_runs.effective_json` 中的阶段记录是同一份内容；模型尝试跨度的用量、耗时与 artifact 引用同样记在 `model_attempts`；HTTP 跨度只有路由与状态码 |
| 世界事实与分支状态 | `worlds`、`branches`、`world_aliases`、`clock`、`aggregate_state`、`domain_events`、`speech_commits`、`jobs`、`rule_failures`、`clock_stop_requests`、`consumer_offsets`、`consumer_inbox`、`agent_activations`、`controller_leases`、`observations`、`perception_state`、`triggers`、`operations`、`snapshots` | 世界权威记录，以及恢复、分支复制与消费幂等所需的状态；`domain_events` 是事件的事实来源，`consumer_inbox` 是消费者幂等的依据 |
| 记忆 | `memory_records`、`memory_revisions`、`memory_watermarks` | 旧 revision 的重建依赖全部历史行版本（第 4 节） |
| 审计与幂等 | `command_receipts`、`lifecycle_events`、`operation_idempotency`、`run_control_idempotency`、`schema_migrations` | 命令与运营操作的幂等重放、访问与脱敏审计、迁移校验 |
| 实验证据档案 | `runs`、`turn_runs`、`maintenance_runs`、`model_attempts`、`tool_calls`、`artifacts`、`budget_ledger`、`experiment_results`、`probe_results` | 冻结 manifest、决策与调用证据、费用与评估结果；评估报告、run 导出与 turn 重放 hash 校验直接读取 |
| 会话、草稿与申请 | `sessions`、`stream_tickets`、`scenario_drafts`、`run_requests`、`config_drafts` | 控制状态，过期与撤销由各自所有者处理，不属于观测数据 |

`modules/server/platform/storage/sqlite/tests/retention.test.ts` 断言每张迁移表恰好属于上表一类，且可轮转清单不含事实、审计与证据表；新增迁移表时必须同时登记分类。

`trace_spans` 的全部读取方及跨度被裁剪后的行为：

| 读取方 | 裁剪后的行为 |
|---|---|
| 观测 provider 的 turn 详情（`GET /console/turns/{turnId}`） | 阶段、决定、对白、模型尝试与工具调用分别来自 `turn_runs`、`artifacts`、`model_attempts`、`tool_calls`，保持不变；`traceId` 由跨度反查，跨度被裁剪后为 `null` |
| 观测 provider 的 trace 树与宿主的分支归属检查（`GET /console/traces/{traceId}`） | 跨度已全部裁剪的 trace 返回 `not-found`；跨越截止时间的 trace 只剩截止之后的跨度 |
| HTTP 错误响应的 `traceId` 回落 | 响应仍按请求生成 `traceId`；超过保留期后，对应的 `http.request` 跨度不再可查 |

评估报告、run 导出、turn 重放 hash 校验、运营幂等日志、证据完整性标记 `runs.evidence_complete` 与分支复制都不读取 `trace_spans`；它是运行级表，不随分支复制。`tests/integration/storage-retention-readers.test.ts` 在裁剪后核对 turn 详情、trace 树与调试唤醒重放。

`lifecycle_events` 不可轮转。`DebugWakeRequested` 是调试唤醒幂等重放的依据：同一 operationId 重放时，宿主经 `latestLifecycleEventByOperation` 取回首次请求核对原因与发起人，记录缺失会以 `invalid-state` 拒绝重放。`ArtifactViewed`、`ModelCredentialRedacted` 与 `OperationAttemptFailed` 分别是原文访问、凭据脱敏与可重试失败的审计。这张表只在控制、失败与审计事件发生时写入，不随 turn 数增长，轮转收益有限。

### 6.2 配置

保留天数是存储适配器配置的可选键 `retentionDays`，键只能是可轮转表：

```yaml
retentionDays:
  trace_spans: 30     # 1–36500 的整数天；省略表示永久保留
```

`retentionDays` 没有默认值，模块描述符的 `defaults` 也不含它。未配置时解析出的模块配置不含该键，仓库内三个装配的模块配置摘要、装配摘要与模块目录摘要都与引入该键之前一致，已冻结 manifest 的在线 run 照常恢复。

取值由宿主从部署环境变量 `WORLD_PRISM_TRACE_SPANS_RETENTION_DAYS` 读取（正整数天，留空表示永久保留），与数据目录一样作为部署期覆盖并入存储适配器配置，不写进装配文件，也不进入冻结 manifest（[技术栈 — 环境变量](../delivery/tech-stack.md#5-环境变量)）。保留期是运维参数，不改变实验组合；启用或调整后，已有在线 run 按原 manifest 恢复，不需要迁移。

### 6.3 执行

- 存储模块在 `start` 打开数据库后，若任一表配置了保留天数，立即排入第一轮清理，此后每轮结束再隔 1 小时排下一轮，轮次不会重叠。第一轮异步执行，积压的过期行不阻塞宿主继续启动。`dispose` 先停止调度再关闭连接，进行中的一轮在下一批之前停止。
- 截止时间为本轮开始时刻减去保留天数，`started_at` 早于截止时间的跨度视为过期。`started_at` 为 `NULL` 的早期跨度（0013 之前写入，或写入时没有宿主时钟）没有可判定的年龄，一律保留。
- 每批最多删除 500 行，每批是一个独立的 `BEGIN IMMEDIATE` 短事务，批与批之间让出事件循环，排队的请求与其他写事务在两批之间执行。清理只经存储端口的 `transact` 发起，不会出现在其他组件的事务内。0020 的 `trace_spans_started_at` 索引让每批按截止时间直接定位，不重复扫描未过期的行。
- 单轮失败只记错误日志，已提交的批次保留，下一轮照常执行。

### 6.4 清理记录

一张表在一轮中只要删除了行，就留下一条 `lifecycle_events` 记录：`type = 'StorageRetentionPruned'`，`subject_id` 为表名，`run_id` 与 `branch_id` 为 `NULL`，`created_at` 为本轮开始时刻，载荷为 `{ retentionDays, cutoff, deletedRows }`。第一批删除与插入记录同事务提交，后续每批删除与改写累计行数同事务提交，因此进程在两批之间退出时，记录的行数仍与已提交的删除一致，不会出现没有记录的删除。记录所在的 `lifecycle_events` 不可轮转，清理历史不会被后续清理删除。每轮同时输出一条 `存储保留期清理完成` 信息日志。

清理记录属于部署级，不出现在按分支读取的控制台时间线中；按 `type` 查询 `lifecycle_events` 可列出全部清理历史。

### 6.5 文件体积

SQLite 删除行后不缩小数据库文件：被释放的页进入空闲列表，供之后的写入复用。启用轮转后主库文件在一个保留周期后趋于稳定，而不是立即变小。`VACUUM INTO` 生成的备份（第 3 节）只写入在用页，不含空闲页。需要缩小主库文件时，停服后手动执行 `VACUUM`；适配器不会自动执行，因为它会重写整个文件，并在执行期间独占写锁。
