# 存储：SQLite 表结构、分支复制与事务规则

> 状态：实现规范。首版只有一个 SQLite 文件 `data/ai-npc.db`，由 `platform.storage.sqlite` 适配器独占；其他模块只能经 storage port 访问自己拥有的表。逻辑语义（幂等、水位、快照一致性）见 [事件与状态](events-and-state.md)，聚合所有权见 [领域模型](domain-model.md) 第 3 节。

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

本节列出初始迁移的表结构。后续迁移单独追加：0002 增加部署级 `operation_idempotency`，0003 把 `jobs_due` 换成只收录 `scheduled` 行的部分索引 `jobs_status_due_seq`，0004 为 `schema_migrations` 增加 `checksum` 并回填 0001–0003 的已发布内容指纹，0005 为 `turn_runs` 增加逻辑创建 tick `created_tick`。0002 与 0003 的完整语句见 §2.1。

`agent_activations` 保存单个身份的激活状态。目标配额为部署内 15 个活动身份：接入激活事务后，由该事务在同一次提交中统计跨分支的活动身份并拒绝第 16 个。当前迁移只约束单行状态，尚未实施跨分支检查；接入前任何部署都可以超过 15 个活动身份。现状和迁移见 [IMPLEMENTATION-STATUS.md — 身份配额](../IMPLEMENTATION-STATUS.md#31-身份配额)。

```sql
-- ===== deployment scope =====
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
```

### 2.1 后续迁移

```sql
-- 0002_operation-idempotency.sql
-- 部署级表：主键不含 branch_id，不参与分支复制，在线别名切换与重启后仍然有效。
CREATE TABLE IF NOT EXISTS operation_idempotency (
  world_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('pause', 'resume', 'snapshot', 'restore', 'reset')),
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

-- 0003_jobs-scheduled-index.sql
-- 热路径只读最早到期的一条 scheduled job；部分索引避免已完成行留在索引里。
DROP INDEX jobs_due;
CREATE INDEX jobs_status_due_seq ON jobs (branch_id, status, due_tick, seq) WHERE status = 'scheduled';
```

## 3. 分支复制 `forkBranch`

快照、恢复、实验分支和开环沙盒都用同一个操作：把源分支的全部分支级数据拷贝到一个新的 `branch_id`。数据规模很小（序章数千行），整表拷贝足够快，也最不容易出错。

```ts
// all branch-scoped tables, in this order
const BRANCH_TABLES = [
  "clock", "aggregate_state", "domain_events", "command_receipts", "speech_commits", "jobs",
  "consumer_offsets", "consumer_inbox", "conversation_lines", "agent_activations",
  "controller_leases", "observations", "perception_state", "memory_records",
  "memory_revisions", "memory_watermarks", "triggers", "operations",
] as const;

function forkBranch(tx: Tx, src: string, dst: string, kind: BranchKind, runId: string | null): void {
  // 1. insert the branches row: parent = src, forked_at_world_seq = max(world_seq of src)
  // 2. for each table: INSERT INTO t (branch_id, <other columns>) SELECT ?, <other columns> FROM t WHERE branch_id = ?
  // 3. fix-ups in dst:
  //    - clock.mode = 'paused', run_version = run_version + 1
  //    - controller_leases.controller_epoch = controller_epoch + 1 (fences anything issued for src)
  //    - triggers: a trigger consumed by a turn that did not reach 'completed'/'failed'/'budget-exhausted' is released
  //      (consumed_by_turn_id = NULL); triggers consumed by a finished turn are deleted
  //    - agent_activations.status = 'dormant' (the caller re-activates the roster after reserving quota, see the table below)
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
| 灾备备份 | 先 `VACUUM INTO 'data/backups/ai-npc-<UTC时间>.<唯一后缀>.partial'` 写同目录暂存文件，确认非空且 `PRAGMA integrity_check` 返回 `ok` 后把权限收紧为 `0600` 并原子改名为 `ai-npc-<UTC时间>.db`；失败时删除暂存文件；不复制正在写入的数据库文件 |

## 4. 常用查询

```sql
-- memory records visible at revision :R
SELECT * FROM memory_records
WHERE branch_id = :b AND agent_id = :a AND created_revision <= :R
  AND (retired_revision IS NULL OR retired_revision > :R) AND status = 'active';

-- due jobs for tick :T
SELECT * FROM jobs WHERE branch_id = :b AND status = 'scheduled' AND due_tick <= :T ORDER BY due_tick, seq;

-- new events for a consumer
SELECT * FROM domain_events WHERE branch_id = :b AND world_seq > :offset ORDER BY world_seq LIMIT 200;

-- active agent quota across the deployment
SELECT count(*) FROM agent_activations a JOIN branches b ON a.branch_id = b.branch_id
WHERE a.status = 'active' AND b.status IN ('active', 'paused');
```

修改记忆记录（例如强度衰减）时，不能 `UPDATE` 内容列：先把当前行版本的 `retired_revision` 设为新 revision，再插入 `row_version + 1`、`created_revision = 新 revision` 的新行。这样任意旧 revision 都能按上面的查询原样重建。

## 5. 存储验收

- 写入事务中途抛错，状态、事件、job 与 receipt 都不落库。
- 分支级表清单与迁移一致；`forkBranch` 之后，新分支的事件、状态、观察、记忆与源分支在 fork 点逐行相等，时钟为 paused，控制 epoch 已递增。
- 按 revision 重建记忆：在 revision 5 和 revision 9 各查询一次，结果与当时记录的 `plan_hash` 链一致。
- 备份先写入同目录暂存文件并执行完整性校验，通过后才以最终 `.db` 名称发布；`VACUUM INTO` 失败或校验失败时不残留可被当作有效备份的文件。
- `VACUUM INTO` 生成的备份可以被重新打开，`PRAGMA integrity_check` 返回 `ok`。

对白消费：authority 在 `speech.commit` 的 command savepoint 内检查并插入 `speech_commits`，与事件、receipt 一起提交；已有同分支 artifact 消费记录时返回 `speech-not-approved`。相同 commandId 先按 receipt 幂等返回。handler 或 afterCommand 拒绝时回滚消费记录；复制分支时保留记录，防止历史对白重复发布。只读 `approvedSpeech.read` 从持久化批准结果的内存索引同步读取；若 artifact 在文件中，宿主须在开启事务前装载并校验，事务内不做文件 I/O。
