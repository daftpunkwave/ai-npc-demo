# 灰港纪事：美术与表现资源方向

> 本文是 2964 灰港世界资产包的设计说明。2026-11-19 用户明确要求为游戏生产有背景特色的美术资源，覆盖原规范“首版不含美术资源、场景只用矢量图元”的初始范围；本包按用户要求交付，同时保留矢量/无画面兜底，保证确定性测试与规则实验不依赖美术文件。

## 1. 风格

- 时间与地点：2964 年，轨道战争结束约六百年；灰港是中继网络、水闸、果园、迁徙隘口与战前档案交汇的温带港区。
- 视觉母题：湿冷雾、氧化铜、旧混凝土、钠灯琥珀、红灯笼、纸与铁锈。
- 画法：编辑性矢量插画，强调层叠剪影、雾、反射、灯光与叙事细节；不使用纯几何色块占位。
- 禁用：现代霓虹赛博朋克、饱和卡通、写实照片、可读品牌/文字水印、与内容包冲突的地标。

## 2. 资源清单

| 资产 | 路径 | 关联 |
|---|---|---|
| 灰港中继站 | `assets/world/grayharbor-relay.svg` | `grayharbor` |
| 旧堤水闸 | `assets/world/old-watergate.svg` | `watergate` |
| 灰痕果园 | `assets/world/ash-orchard.svg` | `orchard` |
| 迁徙隘口 | `assets/world/migration-pass.svg` | `pass` |
| 战前档案库 | `assets/world/archive-vault.svg` | `archive` |
| 降落锚区 | `assets/world/landing-anchor.svg` | `anchor` |
| 砾火同盟 | `assets/factions/ember-compact.svg` | `human-independent` |
| 地生共约 | `assets/factions/earthborn-pact.svg` | `human-earth-alliance` |
| 止戈议团 | `assets/factions/ceasefire-circle.svg` | `human-pacifist` |
| 远星协进会 | `assets/factions/far-star-assembly.svg` | `human-alien-accord` |
| 灰港公社 | `assets/factions/grayharbor-commune.svg` | `human-neutral` |
| 巡裔 | `assets/factions/wandering-kin.svg` | `species-fauna` |
| 根庭 | `assets/factions/root-court.svg` | `species-flora` |
| 泊星者 | `assets/factions/starfarers.svg` | `species-extraterrestrial` |

机器可读清单见 `assets/manifest.json`。地点卡的 PNG 预览在 `assets/previews/`，仅用于评审与文档展示；运行时以 SVG 为准。

## 3. 使用规则

- 场景卡用于开局选择、地点详情、剧情卡与加载页；派系徽记用于开局卡、HUD 与档案。
- 资产 URL 必须来自内容包/manifest 的校验结果，不接受模型或玩家提供的任意地址。
- 缺图或资产校验失败时，`client.scene-renderer.pixi` 回退到可点击的等距矢量图元，不能清空地图或让节点不可选；`client.scene-renderer.null` 只用于无画面与确定性测试。
- 替换 renderer 不得改变世界状态、授权投影或命令目标。

## 4. 技术规格

- 画布：地点卡 800×450（16:9）；徽记 256×256。
- 格式：SVG 1.1，含标题/描述、`role="img"`；无脚本、无外部字体、无远端引用。
- 颜色：以青灰、铜、琥珀为主；派系色只用于徽记与 UI 点缀，不覆盖场景主色。
- 可访问性：每个 SVG 有 `<title>` 与 `<desc>`；对比度不依赖细线。
- 版本：资产随内容包版本冻结；修改构图或语义视为新资产版本。

## 5. 已知限制

- 当前包为手工矢量插画，没有摄影级 matte painting 或角色立绘；环境缺少可用的图像生成额度，未伪造“已完成写实美术”。
- 尚无客户端 `client.scene-renderer.pixi` 接线；资源先作为内容资产与设计基准交付。
- 徽记含少量中文名称，需确认目标字体可渲染；若字体缺失，以图形符号为主。

## 6. 冲突记录

- `docs/00-scope-and-invariants.md` 原“首版不含美术资源”：按用户 2026-11-19 明确要求改为“首版不含声音；美术资源见本资产包”。
- `docs/architecture/client-and-rendering.md` 原“首版不使用美术资源”：改为“默认使用世界资产包，矢量图元作为兜底”。
- `docs/references/sources-and-decisions.md` 原“场景只用矢量图元绘制”：改为“场景默认使用版本化资产包，矢量兜底保留”。
