---
name: 通用 Issue 建议模板
about: 按具体问题或任务灵活组织内容，明确类型、字段、标签与关联关系，便于分诊与闭环。
---

<!--
本模板供参考。提单前先结合代码基线与客观证据分析具体问题或任务，充分利用 Issue 页面右侧（Sidebar）的配置栏，详尽、准确地说明背景与目标。

【格式自由度与动态按需原则】
正文栏目格式不是固定的，作者必须根据具体问题与任务实际需求灵活组织：
- 直观微小问题、明确无外部关联或无需说明的选填小节（如复现/证据/设计说明、影响范围、修复建议、相关记录与其他信息补充等），在具体 Issue 中均可按需直接省略不写；
- 核心在于清晰陈述事实证据、当前现状、预期目标与右侧元数据配置，做到对外独立自解。

【Issue 右侧配置规范】
充分利用 Issue 页面右侧配置栏，明确分工各司其职：
1. Type（必选，严格三选一）：
   - Bug：系统漏洞（Vulnerability）、缺陷、异常行为或破坏不变量的故障（An unexpected problem or behavior）。
   - Feature：建议的新功能、新能力提案、新业务规则或需求想法（A request, idea, or new functionality）。
   - Task：除上述两类外的所有具体工作项（A specific piece of work），如架构重构、测试补充、文档维护、工具链与 CI/CD 优化等。
2. Fields（结构化字段，组织统一维护）：
   - Priority（必选）：通过右侧 Fields 下的 Priority 下拉选择 P0 ~ P4 其中一个等级（P0 紧急，P4 择期）。
   - Effort（选填/推荐）：通过右侧 Fields 下的 Effort 字段评估该 Issue 的相对工作量/复杂度（Relative level of effort for completing this issue）。
   - Start / Target date（选填）：按需规划工作起止时间。
3. Labels（必填，维度补充）：
   - 置信度：统一采用带命名空间前缀的 confidence/high、confidence/medium、confidence/low 标明结论实证程度。
   - 领域分类：若跨越多个架构或职能领域，在正文「Issue 信息」中完整列出所有领域；右侧 Labels 至少打一个关联度最大、最核心的领域标签。
   - 证据与特性标签：如 evidence/*、performance、security 等。
   - 【严厉禁令】bug、feature、task 严禁出现在 Labels 中（统一由 Type 标记）；Priority 统一由 Fields.Priority 承载，禁止作为 Labels 维护。
4. Relationships（非必填/选填，关系追溯）：
   - 属于非必填项。若存在与其他 Issue / PR 的阻塞依赖（Blocks / Blocked by）、主任务与子任务（Parent / Sub-issue）或上下文关联（Relates to），建议在右侧 Relationships 中配置追溯关系；独立原子任务无前置依赖时直接留空即可。

【Issue 标题格式建议】
可参考 `<type>(<scope>): <客观可判定的现象或诉求>`，其中 `<type>` 可与右侧 Type 保持意图对应（例如 fix 对应 Bug，feat 对应 Feature，refactor/chore/docs/test 对应 Task）。
例如：
- Bug: `fix(clock): 暂停后游戏时间仍推进一个 tick`
- Feature: `feat(console): 在研究视图新增决策耗时分布图`
- Task: `refactor(authority): 拆分超长的命令网关校验逻辑`

【协作角色职责】
提出 Issue 的 Agent 必须基于已核实的事实填写，并完成右侧 Type、Fields.Priority、Labels 等必填配置；若存在推断需明确标明待验证项。
具备侧边栏权限的提单人直接在右侧配置；若外部贡献者无侧边栏编辑权限，可在正文末尾「相关记录与其他信息补充」中注明建议，由维护者在分类分诊（Triage）时代为同步至 Fields 与 Labels。
维护者依据正文信息与右侧配置进行分类分诊（Triage）与排期。
解决 Issue 的 Agent 在开始工作前，需复核代码基线、结论、改动范围与验证方式，并在评论中记录复核结果。
-->

## Issue 信息

<!-- 【建议填写】注：Priority 与 Effort 通过右侧 Fields 标记；置信度（confidence/*）通过右侧 Labels 标记；类型通过右侧 Type 标记；Relationships 为选填。正文聚焦事实证据与技术上下文，优先级与置信度由侧边栏承载。 -->
1. **代码基线** <!-- 填写发现问题或拟开展任务时的 Git Commit SHA 或正式版本号；涉及性能或行为回归时，需补充对照基线（Commit SHA 或版本）。 -->
2. **证据类型** <!-- 用 evidence/<类型> 标明实际依据，例如 evidence/reproduced（可稳定复现）、evidence/test-failure（测试用例失败）、evidence/ci-failure（CI 构建失败）、evidence/static-analysis（静态分析检出）。 -->
3. **架构领域** <!-- 标明问题所在的架构边界；若跨越多个架构边界，在此处完整写全（例如 realm/server, realm/contracts），右侧 Labels 仅需打一个关联度最大的标签。常见参考：realm/server、realm/client、realm/console、realm/contracts、realm/shared。 -->
4. **职能领域** <!-- 标明直接相关的职责模块；若涉及多个职能模块，在此处完整写全（例如 area/agent, area/authority），右侧 Labels 仅需打一个关联度最大的标签。常见参考：area/agent、area/authority、area/platform、area/transport、area/renderer、area/kernel、area/tooling。 -->
5. **Issue 来源** <!-- 填写发现该问题的具体渠道（如 PR 审查、本地开发、CI 运行等）；若已确认引入点，附上对应的 Commit SHA 或 PR 编号。 -->

<!--
### Issue 类型 (Type) 判定标准

右侧 Type 为必选配置，严格按问题性质三选一，禁止留空：

| 类型 (Type) | 适用场景 | 判定标准与典型示例 |
| --- | --- | --- |
| `Bug` | 漏洞与缺陷 | 系统出现意外错误、漏洞（Vulnerability）、崩溃、逻辑偏差、契约违背或不变量破损。例如状态机死锁、越权访问、命令校验绕过、内存泄漏等。 |
| `Feature` | 新功能建议 | 建议的新功能、新能力提案、新业务规则或需求想法（A request, idea, or new functionality）。例如新增运营视图、支持新的模型接入等。 |
| `Task` | 具体工作项 | 漏洞修复与新功能之外的所有特定工作项（A specific piece of work）。例如架构重构、测试套件补充、CI/CD 维护、文档规范更新等。 |

### Priority 分级依据（供右侧 Fields.Priority 参考）

根据已有证据支持的影响范围、触发频率、交付时效和临时绕过成本定级。同时符合多档时，取证据支持的最高档。

| 级别 | 判定依据 |
| --- | --- |
| `P0` | 需要立即处理。关键数据正在损毁或不可逆丢失；或者主干构建、发布流程、核心业务闭环已被实质性阻塞，且缺少可行的临时绕过方案。 |
| `P1` | 需要优先处理。核心流程在常规场景下严重受损，或近期关键交付面临明确阻塞，但当前仍可通过临时降级或受限使用维持运行。 |
| `P2` | 纳入正常修复排期。非核心流程出现确定的功能或性能退化，或日常工作需要额外规避步骤，但核心业务流程仍能正常运转。 |
| `P3` | 轻微影响。问题局限于界面展示、文案说明、交互提示或易用性瑕疵，不影响功能逻辑与操作闭环。 |
| `P4` | 可择期安排。主要收益是降低后续维护成本、消除技术债务、预防潜在问题或补充信息，例如预防性重构与技术调研。 |

### 置信度分级依据（供右侧 Labels.confidence 参考）

按证据对 Issue 核心结论的支持程度定级。已复现的客观事实与仍待验证的推断根因须分别说明。

| 级别 | 判定依据 |
| --- | --- |
| `confidence/high` | 核心结论具备直接且可独立复核的客观证据。常见依据包括稳定可复现的步骤、确切失败的断言、同条件对照基准测量数据，或指向明确的代码与规范依据。 |
| `confidence/medium` | 已核对的日志、调用链路追踪或数据支持核心判断，但触发边界、代码实际可达性或影响范围等关键前提仍待进一步验证。 |
| `confidence/low` | 目前仅有初步排查线索（如偶发单次异常、未经复核的代码可疑点或静态扫描提示）。现有信息不足以支撑核心结论，需先补充实证。 |

### Effort 相对工作量参考（供右侧 Fields.Effort 参考）

评估完成该 Issue 所需的相对工作量（Relative level of effort for completing this issue），结合影响面、技术难度与验证成本评估。
-->

## 问题与需求概览

<!-- 【建议填写】简要说明背景、触发条件或业务场景：Bug 说明故障现象与核心目标；Feature 说明业务价值与使用场景；Task 说明任务范围与交付目标。 -->

## 实际结果 / 现状

<!-- 【建议填写】Bug：描述当前可客观观测的实际行为、异常现象、报错信息或性能瓶颈；Feature / Task：说明当前的实现空白、既有痛点或系统现状。陈述须区分客观事实与推断。 -->

## 预期结果 / 目标

<!-- 【建议填写】Bug：明确在相同条件下系统应有的正确行为与状态机不变量；Feature / Task：明确交付后的预期能力、API 契约或具体验收标准。 -->

## 复现/证据/设计说明

<!-- 【选填】Bug：提供最小复现步骤、错误日志上下文与相关代码定位；Feature：提供技术方案设计要点、接口契约变更草案；Task：提供重构范围或任务拆解步骤。若直观微小可直接省略本节。 -->

## 影响范围

<!-- 【选填】明确受影响的功能模块、调用方、数据资产或系统版本。若具备相关信息，补充发生频率、兼容性风险及当前可行的临时绕过方案。若无需特别说明可直接省略本节。 -->

## 修复/实现建议与测试

<!-- 【选填】说明已定位的原因分析或拟改动代码范围、预期实施步骤，以及需补充的自动化测试/回归测试用例。若尚未明确方案可直接省略本节。 -->

## 相关记录与其他信息补充

<!-- 【选填】对应右侧 Relationships 配置，补充说明关联的 Issue（如阻塞 Blocks #xxx、被阻塞 Blocked by #xxx、关联 Relates to #xxx）、Pull Request、可访问的技术文档链接、外部前置依赖或交付约束。如果没有关联项或外部依赖，可以不写本节标题（直接省略）。 -->

## Issue 自审清单

<!-- 【选填，作者可自由增删】提单人在提交前核实并勾选以下自审项（亦可按需增删或整节省略）： -->
- [ ] **右侧类型与结构化字段（Type & Fields）**：已在右侧选择 `Type` <!-- Bug / Feature / Task 严格三选一 -->，`Fields.Priority` 已指定等级 <!-- P0 ~ P4 必选 -->，并评估了 `Fields.Effort` <!-- 相对工作量 -->。
- [ ] **右侧标签与关联追溯（Labels & Relationships）**：已配置置信度与主领域标签 <!-- 严禁包含 bug、feature、task -->，存在依赖时已按需配置 `Relationships`。
- [ ] **代码基线与客观证据**：已提供确切的代码基线（Commit SHA 或版本）与实证支撑（复现步骤、报错日志或代码定位），明确区分客观事实与推断。
- [ ] **对外内容独立自解**：描述清晰完整、可独立理解与评审，未引用受众无法访问的内部材料、未公开草稿或开发计划内部编号。
- [ ] **跨领域正文写全**：若问题或诉求跨越多个架构边界（`realm`）或职能模块（`area`），已在「Issue 信息」中完整列出，右侧仅打主关联标签。
- [ ] **预期行为与验收边界明确**：已清晰界定正确预期行为、状态机不变量或交付验收标准，为后续修复实现与自动化测试补充提供明确依据。
