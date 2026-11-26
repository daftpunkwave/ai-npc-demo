# gamedev

游戏开发技能包。入口是 `SKILL.md`，它是路由层：先按项目指纹识别引擎，再按任务挑出最少的几个具体技能去读。79 个具体技能按分类平铺在本目录下。

## 结构

```text
gamedev/
├── SKILL.md          路由入口，先读这个
├── README.md         本索引
├── agents/           Agent 元数据
├── references/       路由表、引擎识别、自定义引擎的细则
├── godot/            Godot 专有技能
├── unity/            Unity 专有技能
├── unreal/           Unreal 专有技能
├── ebitengine/       Ebitengine 专有技能
├── web-engines/      Phaser、PixiJS、three.js
├── other-engines/    Bevy、pygame、LÖVE、Defold、Roblox
├── disciplines/      跨引擎通用技法，与引擎技能搭配使用
├── genres/           品类模板，负责结构，不重讲引擎 API
└── workflows/        原型、Game Jam、发行、设计文档
```

每个具体技能是 `<分类>/<技能名>/SKILL.md`，同级可能带 `references/`、`scripts/`、`assets/`。

## 使用方式

1. 读 `SKILL.md`，确定引擎与任务类别。
2. 按本索引挑出最少的技能组合：引擎技能 + 需要的 discipline + 最多一个 genre + 需要的 workflow。
3. 只读选中技能的 `SKILL.md`，需要更深细节时再读它的 `references/`。

责任划分：引擎技能负责 API 与语法，discipline 负责可移植的概念与算法，genre 负责结构与粘合，三者不互相重复。

## Godot（16）

| 技能 | 用途 |
|---|---|
| `godot-gdscript` | GDScript 2.0：静态类型、`@export`/`@onready`、`await` 协程、3.x 代码迁移 |
| `godot-csharp` | Godot 里的 C#/.NET：分部节点类、`[Export]`/`[Signal]`、信号即事件、与 GDScript 互调 |
| `godot-nodes-scenes` | 场景树：可复用 `.tscn`、`instantiate()`、autoload，附带 `res://` 路径与 uid 检查器 |
| `godot-signals-groups` | 信号与节点组：类型化信号、Callable 连接、事件总线、`call_group` 广播 |
| `godot-2d-movement` | `CharacterBody2D` 平台跳跃与俯视角八向移动、斜坡、单向平台 |
| `godot-3d-essentials` | 3D 场景搭建：Camera3D、灯光、WorldEnvironment、StandardMaterial3D、GridMap |
| `godot-physics` | 2D/3D 物理：Body 与 Area 类型、碰撞层与掩码、Area 信号、射线查询、Jolt |
| `godot-tilemap` | `TileMapLayer`/`TileSet`：图集源、数据层、地形自动拼接、运行时 `set_cell` |
| `godot-ui-control` | `Control` 节点：锚点、容器、Theme/StyleBox、焦点邻居、拉伸设置 |
| `godot-animation` | `AnimationPlayer`、`AnimationTree` 状态机、`AnimatedSprite2D`、`Tween` |
| `godot-shaders` | Godot 着色语言：`canvas_item`/`spatial`/粒子着色器、内置变量、无头编译检查 |
| `godot-resources` | 自定义 `Resource` 数据：`class_name`、`.tres`、共享引用与 `duplicate_deep()` |
| `godot-audio` | 音频 API：`AudioStreamPlayer` 2D/3D、总线布局、音量与静音、循环导入、节拍同步 |
| `godot-multiplayer` | 高层多人：ENet 主机与加入、`@rpc`、`MultiplayerSpawner`/`MultiplayerSynchronizer` |
| `godot-export` | 导出：模板、各平台 `export_presets.cfg`、命令行导出、Web 的 COOP/COEP 响应头 |
| `godot-gdscript-headless-testing` | 用 `godot --headless` 跑 GDScript 测试，失败返回非零退出码，可接 CI |

## Unity（9）

| 技能 | 用途 |
|---|---|
| `unity-csharp-scripting` | 玩法脚本：`MonoBehaviour` 生命周期、序列化、`.meta`/GUID 纪律、命令行测试 |
| `unity-input-system` | Input System：`.inputactions`、动作映射、`PlayerInput`、控制方案 |
| `unity-physics` | 2D 与 3D 物理：Rigidbody/Rigidbody2D、力与速度、层碰撞矩阵、射线 |
| `unity-animation` | Animator：状态与过渡、混合树、Avatar Mask 分层、根运动、人形 IK |
| `unity-scriptableobjects` | `ScriptableObject`：配置资产、共享运行时变量、事件通道 |
| `unity-tilemap-2d` | 2D 瓦片：Tile Palette、Tilemap Collider 2D 配 Composite Collider、Rule Tile |
| `unity-navmesh` | AI Navigation：`NavMeshSurface` 烘焙、`NavMeshAgent`、`NavMeshLink`、运行时重烘焙 |
| `unity-build-pipeline` | 构建：Build Profiles、IL2CPP 与 Mono、托管代码裁剪、脚本化构建、Addressables、CI |
| `unity-build-size` | 包体过大：读 Build Report、未压缩贴图、glTFast 模型、PCM 音频、各平台瘦身手段 |

## Unreal（6）

| 技能 | 用途 |
|---|---|
| `unreal-blueprints` | 蓝图：Blueprint Class 与关卡蓝图、事件图、Cast、接口、事件分发器 |
| `unreal-cpp-gameplay` | C++ 玩法：UCLASS/UPROPERTY 反射、Gameplay Framework、GC 安全指针、Build.cs |
| `unreal-enhanced-input` | Enhanced Input：Input Action、Mapping Context、`ETriggerEvent` 绑定、可重映射按键 |
| `unreal-behavior-trees` | NPC AI：行为树、黑板、EQS、StateTree、Observer Aborts、C++ BTTask |
| `unreal-niagara` | Niagara 特效：系统、发射器、User 参数、生成与边界、GPU 与 CPU 模拟 |
| `unreal-packaging` | 打包：Shipping 构建、cook、pak/IoStore、`RunUAT BuildCookRun`、读 UAT 与 cook 日志 |

## Ebitengine（1）

| 技能 | 用途 |
|---|---|
| `ebitengine-game` | Go 2D 游戏：主循环、输入、像素画缩放、文字、音频、桌面/WASM/移动端构建 |

## Web 引擎（6）

| 技能 | 用途 |
|---|---|
| `phaser-core` | Phaser 4（兼容 3.90）：Game 配置、Scene 生命周期、加载器、场景切换、3 升 4 迁移 |
| `phaser-arcade-physics` | Arcade Physics：刚体、速度、重力、collider 与 overlap、分组、子弹池 |
| `pixijs-rendering` | PixiJS v8：异步初始化、Assets、Container/Sprite 场景图、指针拖拽、v7 升 v8 |
| `threejs-scene-setup` | three.js 场景：import map、相机、渲染器、`setAnimationLoop`、缩放、OrbitControls |
| `threejs-gltf-loading` | glTF/GLB：GLTFLoader、DRACO/Meshopt/KTX2 解码器、`AnimationMixer` 交叉淡入、克隆骨架 |
| `threejs-materials-lighting` | 材质与光照：标准/物理/无光照材质、灯光、阴影、HDR 环境、色调映射 |

## 其他引擎（12）

| 技能 | 用途 |
|---|---|
| `bevy-ecs` | Bevy 0.20：组件、`Query`/`Commands` 系统、调度、States、观察者、无头测试 |
| `pygame-core` | pygame-ce：事件-更新-绘制循环、delta time、Surface/Rect、精灵组、无头测试 |
| `love2d-core` | LÖVE 11：回调、`conf.lua`、固定步长、像素画清晰缩放、`love.filesystem` 存档 |
| `defold-core` | Defold：collection、游戏对象、输入焦点、`msg.post`、工厂、collection proxy、Bob 构建 |
| `roblox-luau` | Luau：服务、Instance、Script/LocalScript/ModuleScript、`task` 库、类型标注、静态检查 |
| `roblox-datastores` | `DataStoreService`：进入加载、离开与 `BindToClose` 保存、`UpdateAsync`、会话锁、排行榜 |
| `roblox-ui` | `ScreenGui`/`PlayerGui`：`UDim2` 缩放、布局、安全区、StyleSheet、手柄选中、触屏控件 |
| `roblox-networking` | 网络与反作弊：Remote 契约、服务端权威、限流、命中校验、复制 |
| `roblox-characters` | 角色：`CharacterAdded` 生命周期、`Humanoid`、R6/R15/自定义骨架、重生、Tool |
| `roblox-physics` | 物理与空间查询：装配体、约束、碰撞组、`Raycast`/`Shapecast`、网络所有权 |
| `roblox-studio-workflow` | 安全修改已有 place 或 Rojo 工程：定位事实来源，用对应测试模式或 Studio MCP 证明改动 |
| `roblox-simulator-economy` | 模拟器/放置游戏经济：升级成本曲线、每秒收益、转生节奏、大数字、开蛋概率 |

## 跨引擎技法（15）

| 技能 | 用途 |
|---|---|
| `create-game-assets` | 统一美术风格：风格指南、精灵、像素画、图集、图标、贴图，含质检与授权记录 |
| `game-ai` | 敌人与 NPC AI 选型（FSM、行为树、效用、GOAP）、感知、转向、A* 寻路 |
| `ai-behavior-trees-utility-ai` | 与引擎无关的行为树与效用 AI 代码：黑板、响应式组合节点、装饰器、响应曲线 |
| `procedural-gen` | 过程生成：带种子随机、地牢布局、波函数坍缩、噪声地形、掉落表 |
| `dialogue-systems` | 分支对话：Ink、Yarn Spinner 或 JSON 图，含选项、条件、变量、本地化 ID |
| `save-systems` | 存档：序列化什么、槽位与自动存档、原子写入、带版本迁移 |
| `audio-design` | 音频设计：总线布局、分贝音量、响度、对白闪避、自适应音乐、音效变化 |
| `shader-programming` | 效果原理：溶解、描边、菲涅尔边缘、后处理，GLSL 与 HLSL 对照 |
| `physics-tuning` | 物理调校：固定步长与插值、CCD 防穿透、阻尼、求解迭代、层矩阵 |
| `level-design` | 关卡设计：玩家度量、钥匙与能力门禁（含卡死检查）、灰盒、节奏 |
| `input-systems` | 输入架构：命名动作、摇杆死区、按键缓冲、带冲突检查的重绑定 |
| `game-feel` | 手感：基于冲击量的屏幕震动、顿帧、缓动、挤压拉伸、击退 |
| `game-ui-ux` | HUD 与菜单规则：锚点、缩放、安全区、手柄焦点、事件驱动 HUD、无障碍下限 |
| `camera-systems` | 摄像机：带死区与前瞻的 2D 跟随、第三人称环绕、第一人称视角、分屏 |
| `performance-optimization` | 先测量再优化：区分 CPU 与 GPU 瓶颈，再选最大收益项（绘制调用、对象池、GC 尖峰） |

## 品类（9）

| 技能 | 用途 |
|---|---|
| `platformer` | 平台跳跃：土狼时间、跳跃缓冲、可变跳跃高度、下落重力、蹬墙、检查点 |
| `roguelike` | 局内流程、永久死亡、元进度、种子与每日挑战、回合顺序、视野 |
| `rpg` | 属性与修正栈、经验曲线、伤害公式、物品与装备、任务 |
| `fps-shooter` | 第一人称射击：射线与投射物、击杀耗时、伤害衰减、后坐力、ADS 灵敏度 |
| `tower-defense` | 塔防：路径与迷宫、波次节奏、索敌优先级、护甲与飞行克制、金币经济 |
| `card-game` | 卡牌与构筑：卡牌即数据配单一效果解释器、牌区、触发栈、可控洗牌 |
| `visual-novel` | 视觉小说：路线与结局、随处存档、回顾、只跳已读、打字机文本 |
| `survival-crafting` | 生存建造：采集、配方与科技树、负重、腐坏、需求、基地建造 |
| `puzzle` | 解谜：三消连锁、推箱子、唯一解网格、精确撤销、求解器校验关卡 |

## 流程（5）

| 技能 | 用途 |
|---|---|
| `prototype-fast` | 一小时出可玩原型回答一个问题，灰盒加调试 HUD，最后决定保留、砍掉还是调参 |
| `game-jam` | Game Jam：读规则、按剩余时间收敛范围、维护砍单清单、提交前验证构建 |
| `steam-publish` | Steam 发行：depot、`app_build` 脚本、steamcmd 上传、测试分支、SetLive、商店审核 |
| `itch-publish` | itch.io 发行：`butler push` 到频道、平台标记、HTML5 构建、`--userversion`、CI 上传 |
| `game-docs` | 设计文档：一页 GDD 加功能索引与逐条说明，用链接与状态检查器保证与代码一致 |
