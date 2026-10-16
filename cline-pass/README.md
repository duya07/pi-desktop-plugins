# 🔌 Cline Pass 本地网关 · PI-Desktop 插件

[![version: 1.0.0](https://img.shields.io/badge/version-1.0.0-blue)](./manifest.json) [![license: MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/duya07/pi-desktop-plugins/blob/main/LICENSE) [![PI-Desktop](https://img.shields.io/badge/PI--Desktop-0.19.1-compatible-lightgrey)](https://github.com/vastsa/PI-Desktop) [![gateway: 127.0.0.1:41593](https://img.shields.io/badge/gateway-127.0.0.1:41593-orange)](#端口)

> 把 DSH 的 `dsh-cline-pass` 0.2.5-p3 移植到 PI-Desktop。保留内核，换掉外层接法 —— 插件自带只监听本机的 OpenAI 兼容网关，**你自己那个** provider 的每一次请求都落进同一条路径（插件自己不声明 provider，见下文「生成配置与生效路径」）。

| 维度 | 说明 |
| --- | --- |
| **这是什么** | 本地网关 `127.0.0.1:41593` + 账号池与轮转 / 冷却 + 通道枚举与校验 + pin / exclude + failover + 流式空闲超时 + 思考档位映射 |
| **怎么看** | 面板六页：账号池 / 模型与通道 / 导入与参数 / 请求历史 / 用量 / 设置 · 官方额度窗口（5 小时 / 本周 / 本月）· 10 个 `cline_pass_*` agent 工具 |
| **接哪里** | Cline Pass（`api.cline.bot`）· 面板生成的配置 → 你自己的 provider → 本机网关 |

---

PI-Desktop 的插件只能**声明式**注册 provider（`contributes.providers`），请求由宿主自己发出 —— 插件拿不到请求路径。
所以这里保留 DSH 内核、换掉外层的接法：插件自带一个**只监听本机**的 OpenAI 兼容网关，再由面板**生成一份配置**，
你在 设置 → 模型配置 →「从其他工具导入」里把它导入成**你自己的** provider（baseUrl 就指向这个网关）；
宿主发的每个请求都会落进网关，网关照旧做通道枚举与校验、pin / exclude、failover、账号池与冷却、流式空闲超时、思考档位映射。

```text
PI-Desktop ──POST http://127.0.0.1:41593/v1/chat/completions──▶ 本插件网关 ──▶ Cline Pass (api.cline.bot)
```

---

## 🧭 目录与导读

> **用法 → 功能 → 参考 → 证据** —— 按这条线阅读最顺。

| 序号 | 章节 | 一句话小结 |
| --- | --- | --- |
| 1 | 🚀 加载与首次使用 | 从加载插件到首通的 6 步 |
| 2 | 🧩 生成配置与生效路径 | 为什么不声明 provider、模型 id 前缀如何避免撞名 |
| 3 | 📊 用量账本 | 每个请求落一行 `usage.jsonl` 的窗口汇总 |
| 4 | 💳 官方额度 | 官方 `usage-limits` 三窗口的已用 % 与倒计时 |
| 5 | 🤖 Agent 工具 | 10 个 `cline_pass_*` 工具一览 |
| 6 | 🖥️ 面板动作 | `skill.setEnabled` 通道与超时预算 |
| 7 | 🔒 数据与隐私 | 配置、日志、账本落在哪个文件 |
| 8 | 🔌 端口 | 单一常量 `GATEWAY_PORT` 与本机校验 |
| 9 | 📜 宿主契约 | 0.19.1 硬约束与本插件对照表 |
| 10 | 🔄 与 DSH 版的差异 | 接法、档位、密钥、面板桥、额度缓存 |
| 11 | 🛠️ 本轮修复 | 39 条变更记录（按主题分组，编号与顺序不变） |
| 12 | ✅ 自测 | `57/57`、`45`、`68` 等断言与命令 |
| 13 | 🧪 验证状态 | 已验证 / 未验证 / 待实测 的逐条证据 |
| 14 | 📦 来源 | DSH 0.2.5-p3 MIT 移植说明 |

---

## 🚀 加载与首次使用（6 步走通）

> 小结：加载 → 打开面板 → 给 key → 生成配置并导入 → 摸通道 → 选对 provider。

### 第 1 步 · 加载

- 插件页 → **Load development plugin** → 指向本目录（`<本仓库>\cline-pass`）。保存文件即热重载。
- 权限清单：`agent.tool.register`（高危，需显式批准）、`background.service`、`ui.panel`、`notify`、`models.list`、`fs.read` + `fs.write`（面板「写入文件」用：`fs.read` 是 `pi.fs.requestDirectory()` 实际校验的那一条，`fs.write` 被 `root: "userSelected"` 限制在**你亲手选的那个目录**，代码只写 `models.json` 一个文件名）。
- 若之后改了 `permissions`，先移除再重新加载（开发插件的权限以首次批准为上限，宿主会拒绝热重载）。

### 第 2 步 · 打开面板

- 命令面板里 `Cline Pass：打开管理面板`（命令 id `cline-pass.open`），或插件页的面板。

### 第 3 步 · 给 key（密钥全部由本插件管，宿主侧不用填）

| 方式 | 说明 |
| --- | --- |
| 内联账号 | 面板「账号池」里加内联账号（key 写进插件数据目录的 `config.json`）：可放多个，轮转 + 失败冷却。表里每行都有**编辑**：改账号名 / 显示名 / 换 key（**key 留空 = 不改动**）/ 停用启用 |
| 宿主侧占位 | 插件**不声明任何 provider**（`contributes.providers` 已删），模型选择器里不会再出现插件那一行；真正被使用的是下一节导入出来的那个 provider —— 它在每个请求上带一个占位 bearer（`pi-desktop-no-auth`），插件把它当成「宿主没有 key」忽略，绝不会拿它去请求 Cline |
| 向前兼容 | 若哪天宿主真的发来一把 key（非占位串），插件仍会把它当 `host` 账号在当次请求里使用，不落盘 |
| 已移除 | 没有「读环境变量」那种账号：宿主给插件进程的是**最小环境**（`PATH`/`TEMP`/`HOME` 一类 + `PI_PLUGIN_ID`），取不到你自己设的变量，所以这个来源已去掉（传 `source=env` 会被明确拒绝） |

### 第 4 步 · 接进模型选择器（生成配置 → 从其他工具导入）

> 为什么要绕这一下：插件 provider 行（本插件以前声明的那种）有两条硬限制 —— ① 宿主只维护它认识的 7 个字段，`availableForSubagents` 会被**丢弃**（2026-10-13 对照实验：manifest 里写上它、同时把一个宿主必看的 `maxTokens` 改成 384001，停用→启用后行确实被重写、对照值进去了，而这个字段 5 个模型**全缺**）；② 插件行在设置页**没有编辑入口**。所以插件模型永远进不了委派目录 —— 这也是本插件现在**干脆不声明 provider** 的原因；而**你自己的** provider 没有这两条限制。

插件**不声明任何 provider**，得把模型导入成**你自己的** provider —— 只有这种 provider 能在设置页里编辑、能勾「可供 AI 自动调度」（子代理能不能用它，就看这一勾）：

1. 面板「导入与参数」→ **生成配置** → **写入文件**：第一次会弹系统目录选择器，选 `C:\Users\<你>\.pi\agent`（目录不存在就先建一个）。插件只往这个目录写一个 `models.json`，不读、不删别的文件。不想授权写盘就点「复制」，自己存成同一个路径 —— 这个路径是「从其他工具导入」会扫描的来源之一（`pi`）。
2. 设置 → 模型配置 → **从其他工具导入** → **扫描** → 勾选「Cline Pass（本地网关）」→ **导入所选**。
3. 导入后在那张模型卡里勾上 **「可供 AI 自动调度」**。
4. 之后调参数直接改设置页那张卡（理由见下一节）；`models.json` 留着或删掉都行（留着下次扫描还能看到）。

> [!TIP]
> 目录选择器是模态窗口，请在 30 秒内选完（宿主对一次面板调用只等 30 秒）。万一面板提示超时，**直接再点一次「写入文件」** —— 目录已经记住，这一次是秒写。插件重载后需要重新选一次目录。

### 第 5 步 · 摸通道

- 面板依次点 **Probe**（判定路由管线并从路由层错误里抓该模型的完整通道列表）→ **Validate**（逐通道 pin 一遍，判定依据是响应自报的 `finalProvider`，不是 HTTP 200）→ 需要时 **Pin / Exclude**。

### 第 6 步 · 用起来

- 模型选择器里选 **baseUrl 是 `http://127.0.0.1:41593/v1` 的那个 provider**（也就是上一节导入出来的那个）下的模型。注意和自建的 `api.cline.bot` provider 区分开：导入进来的模型 id 带 `cline-pass-local/` 前缀、直连那条是 `cline-pass/`，**不会再同名**（见下文「认准 baseUrl」）；但选 provider 时仍要认准 baseUrl。

---

## 🧩 生成配置与生效路径

> 小结：面板参数只写 `config.json`，再翻译成你要导入的 JSON；导入后在设置页那张卡里改。

- 插件**不声明任何 provider**（`contributes.providers` 与 `provider.register` 权限都已删除），所以模型选择器里不会再有插件那一行。面板里的模型参数写进插件数据目录的 `config.json`（`modelSettings`），再由一个面板动作把它们翻译成**你要导入的那份 JSON**。

| 配置来源 | 说明 |
| --- | --- |
| 面板可改 | 面板「模型参数（写进生成的配置）」可改 `registered`（= 是否写进生成的配置）/ `contextWindow` / `maxTokens` / `supportsImages` / `thinkingLevels` / `defaultThinkingLevel`；保存只提交改动过的字段，**不需要重载插件** |
| 默认值 | 取自 **models.dev**：`<安装目录>\resources\models.dev\api.json` 里 `cline-pass` provider 下的模型（窗口 `limit.context`、输出上限 `limit.output`、图片 `modalities.input`、档位 `reasoning_options`）。仓库里的 `tools/sync-catalog.mjs` 就是刷新这张表的脚本：默认读本机快照，`--remote` 直连 models.dev，不加 `--write` 只报告差异 |
| 宿主限制 | 生成配置里写死的 `limit` 会被宿主当成**用户值**，models.dev 补全不会覆盖它。但 **`pi` 格式没有"自定义档位阶"字段**：0.20.1 的 `bindingFromPiModel` 只要看到 `reasoning: true` 就**硬编码** `thinkingLevels: ["off","low","medium","high"]` + 默认 `medium`（`out/main/index.js:2238` 附近），所以导入后的档位是宿主通用那套，**不是**上面表里的 models.dev 梯子。要按 models.dev 的梯子来（例如某个模型应是 `off/low/high/max` 而不是 `off/low/medium/high`），就在 设置 → 模型配置 那张模型卡里手改档位 —— 那里可以改（`SettingsPage` 的档位 chips 会写回 `thinkingLevels` / `defaultThinkingLevel`） |
| 宿主专有 | 「宿主专有能力」（思考协议 / PDF / 自动调度 / 联网搜索 / 生图）插件写不进生成配置：导入之后到设置页里改，其中**「可供 AI 自动调度」就是 `availableForSubagents`** |
| 前缀设计 | **生成的模型 id 带 `cline-pass-local/` 前缀**（`cline-pass/<模型>` → `cline-pass-local/<模型>`）：这是故意的，原因见下面 WARNING 的「子代理侧更隐蔽」—— 撞的是模型 id，不是 provider 名字。网关两种拼写都认，旧配置照旧可用 |

> [!IMPORTANT]
> **生效路径（实测）**：`importConfigPayload()` 从 `src/protocol.js` 的 `GATEWAY_BASE_URL` 取网关地址（`http://127.0.0.1:41593/v1`），生成的 JSON 固定包含：`api: "chat_completions"`、`apiKey: "pi-desktop-no-auth"`（占位串，网关忽略它、改用你自己的账号池）、每个模型一个 `limit`（窗口 / 输出）、`reasoning: true`、图片模型带 `input: ["text","image"]`。导入器对**已存在**的 provider（判重规则：同 baseUrl + apiStyle，或同 vendorKey + apiStyle，且密钥一致）会**跳过**，所以「生成配置 → 导入」主要用于**第一次**接上；之后调参数请直接改 设置 → 模型配置 里那张卡（它现在是你的 provider，能改）。

> [!WARNING]
> **认准 baseUrl（实测踩过）**：模型选择器按「provider + 模型」区分，同一个模型 id 可以挂在多个 provider 下。2026-10-13 本机实测：某个模型 id（形如 `cline-pass/<模型>`）同时出现在**自建的 `api.cline.bot` provider** 与本插件网关的 provider 下，而日常会话走的是前者 —— 于是插件网关侧 0 会话、账本为空，pin / failover / 账号池 / 额度这些功能**看不到那部分流量**。想用上它们，就选 baseUrl 为 `http://127.0.0.1:41593/v1` 的那个 provider。
> **子代理侧更隐蔽（2026-10-13 实测，别踩）**：委派目录的 key 是 `<vendorKey>/<模型 id>`，而用户自建的 provider 的 `vendorKey` 都是 `custom`，于是**两个 provider 的同名模型会撞成同一个 key**。实测：`custom/cline-pass/<模型>` 被宿主判为可用，但那一次子代理请求**根本没进网关**（网关 `historySize = 0`、账本没有新行、宿主日志里也没有）—— 它被直连 `api.cline.bot` 的那条接走了。对照组：只在网关 provider 里存在的 `cline-pass/<另一个模型>`（且未勾「可供 AI 自动调度」）被宿主**直接拒绝** —— `Model "custom/cline-pass/<另一个模型>" is not available for delegation. Available: …` → 说明门禁确实生效，而撞名的那条是另一个 provider。想让子代理只走网关：把旧直连 provider 里**同名**模型的「可供 AI 自动调度」取消勾选（或直接停用它），再勾上网关 provider 的模型；否则子代理会悄悄走直连那条，账号池 / pin / failover / 账本全都看不到这部分流量。
> **插件侧的根治办法见下一节**：生成配置里的模型 id 带 `cline-pass-local/` 前缀，撞名就不存在了；上面这条「取消勾选」只是零代码的临时办法。

---

## 📊 用量账本（本地网关侧的流量统计）

> 小结：网关只统计经过本网关的请求，与官方额度是两个口径。

- 宿主不会告诉插件一次会话花了多少，网关能看到的是**每次响应最后那帧的 `usage`**（含 token 与成本明细），于是每个请求落一行到 `<数据目录>\usage.jsonl`。

| 能力 | 说明 |
| --- | --- |
| 汇总 | 面板「用量」按 1 / 7 / 30 天或全部汇总：请求数、失败数、输入 / 输出 token、成本（只统计上游真给了成本的请求，`costKnown` 形如 `3/10`）、平均耗时，并给出按模型 / 按通道 / 按天分组与最近明细 |
| 成本 | 上游没给成本的请求显示「—」，不按单价估算 |
| 工具 | `cline_pass_usage` 工具给 agent 同一份数据（`days` / `limit` / `model`），`usageClear` 清空账本 |

---

## 💳 官方额度（Cline 订阅窗口）

> 小结：与本地账本并列的第二块，直接读 Cline 官方的 `usage-limits`。

- 接口：Cline 自己的 `GET {baseUrl}/users/me/plan/usage-limits`，返回 `{success, data:{limits:[{type:'five_hour'|'weekly'|'monthly', percentUsed, resetsAt}]}}`；同一族还有 `GET /users/me`（profile）与 `GET /users/{id}/usages/daily?startDate=&endDate=`（按天用量）。路径与形态对照 DSH `dsh-cline-pass` 0.2.5-p3 的 `lib/cline.js`（`USAGE_LIMITS_PATH` / `PROFILE_PATH` / `PLAN_PATH`）逐字核对；卡片本身对照同一版本的 `lib/client.js` 里 `UsageCard` + `usageColor` + `countdown` 逐条复刻。

| 规则 | 说明 |
| --- | --- |
| 已用百分比 | **显示「已用」百分比**（`percentUsed` 取整并夹到 0..100），条长就是已用比例，配色沿用原版 `usageColor`：≥90% 红、≥70% 橙、其余绿。窗口按 `five_hour` / `weekly` / `monthly` = 5 小时 / 本周 / 本月 排序，多出来的按上游 `type` 附在后面 |
| 翻页 | **账号池一次只看一个账号**：标题是 `官方额度 · N 个账号`（单账号则是 `官方额度 · 账号 <名字>`），名字行给 `‹ 名字 [当前] 第 i / n 个 ›`；翻页纯本地 —— 一次读取已经把整个池读回来了，箭头不发请求。「当前」只在该账号是单选模式的 active 账号时出现（轮询模式下每个请求都在换，标了就是假话） |
| host 过滤 | **`host` 账号不列在这里**（和「账号池」表一致）：它只在宿主真发来一把 key 时才存在，而那把 key 只活在当次请求的内存里 —— 面板这座桥拿不到它，列出来永远只能是一行「读不到」，所以直接不列；标题里的账号数也只数内联账号。真有一个账号读不到时，行内是一句短中文（`暂时读不到官方额度。密钥被官方拒绝了（HTTP 401）。` / `连不上官方接口。` / `这个账号现在没有密钥。` …），网关与上游的英文原文挂在 `title` 上（鼠标停一下能看全），灰字不上色；整个池读不到时只有一句 `暂时读不到官方额度。`，重试就是标题行那个「刷新」按钮，不再另给一个 |
| 重复 key | **同一个 key 填在两个账号上时明说**：`duplicateNames()` 按真实 key 分组（key 本身不返回、不记日志），撞车的账号在翻页行显示掩码（`.quota-key`，和「账号池」是同一列信息）并补一句灰字「这个账号和另一个账号用的是同一个 key（同一个 Cline 账号），所以两边数字一样 —— 到「账号池」把 key 改成各自的。」（有意偏差：DSH 原版既不显示掩码也不提示重复；少了这条，「名字对、数字不对」就变成一个谜。） |
| 缺失值 | **缺失值不编造**：官方没给某个窗口的 `percentUsed` 就显示 `—`、进度条不写 `aria-valuenow`、提示条写「官方没有返回这一档的百分比」；解析层也不把缺失补成 0（`Number(null)` 就是 0，这条踩过）。原版假设这个值一定有，这里沿用它「一定有」的显示路径，缺值时降级显示而不是撒谎 |
| 倒计时 | 倒计时按原版算法**从 `resetsAt` 现算**（`3 天 2 小时后重置` / `5 小时 10 分钟后重置` / `42 分钟后重置`），不认上游算好的文本，省得两边对不上 |
| 口径差异 | 两个口径不要混：本地账本只统计**经过本网关**的请求，官方额度包含该账号在别处用掉的量，对不上是正常的 |
| 工具 | `cline_pass_quota` 工具给 agent 同一份数据（`refresh` 绕过 60 秒缓存）；`status` 里也带缓存里的最近一次读数 |

---

## 🤖 Agent 工具（10 个）

> 小结：状态、模型、探测、校验、试发、pin、账号、历史、用量、额度各一个。

| 工具 | 用途 |
| --- | --- |
| `cline_pass_status` | 状态：端口 / 账号池冷却 / pin / 并发 / 最近一次额度读数 |
| `cline_pass_models` | 模型参数与已探测通道 |
| `cline_pass_probe` | 探测通道列表 |
| `cline_pass_validate` | 逐通道校验 |
| `cline_pass_test` | 按 pin / exclude 真发一次并给轨迹 |
| `cline_pass_pin` | 写 / 清 pin |
| `cline_pass_accounts` | list / add / update / remove / mode / test / resetCooldowns；`update` 支持改名 `renameTo`、改显示名、换 key、启停 |
| `cline_pass_history` | 最近请求 |
| `cline_pass_usage` | 用量账本汇总 |
| `cline_pass_quota` | 官方额度窗口 |

---

## 🖥️ 面板动作

> 小结：面板统一走 `skill.setEnabled` 通道，超时预算与工具不同。

- 宿主的面板桥只转发 `skill.*` 通道，所以面板统一走 `skill.setEnabled` + `payload.action`（与官方 `pi.todo` 同形）：`status` `probe` `validate` `test` `pin` `clearPin` `accounts` `history` `setConfig` `reloadConfig` `restartGateway` `setModel`（写模型参数到插件配置，不再碰 manifest）`generateConfig`（生成要导入的 JSON，不落盘）`writeConfig`（把它写到用户选的目录里的 `models.json`）`usage` `usageClear` `quota`。
- `status` 除网关状态外还带 `host`（宿主清单比对结果，即「宿主侧同步状态」那一行的原始数据）。
- 宿主对**一次面板调用**只等 30 秒（`PLUGIN_PANEL_TIMEOUT_MS`），所以面板侧的超时是 25 秒；probe / validate / test 这类重活给的是同一预算，超时会说清原因并建议改用 agent 工具（110 秒）。插件进程抛错时宿主可能不回传异常，面板因此自带超时与错误提示。

---

## 🔒 数据与隐私

> 小结：内联 key 只落 `config.json`，日志与账本可轮转，宿主看不到你的 key。

| 内容 | 位置 |
| --- | --- |
| 配置 / 账号 / pin | `%USERPROFILE%\.pi-desktop\plugins\data\io.github.duya07.cline-pass\config.json`（写入 0600；Windows 上权限位可能被忽略，文件仍在用户目录内） |
| 插件日志 | 同目录 `gateway.log`（上限 512 KB，超出即清空重写），同时打到 stderr，宿主 `plugin.log` 里带 `[cline-pass]` 前缀 |
| 用量账本 | 同目录 `usage.jsonl`（超过 2 MB 轮转为 `usage.1.jsonl`）：模型 / 通道 / 账号 / token / 成本 / 耗时，不含任何请求正文 |
| manifest 备份 | 同目录 `manifest.backup.json`（面板改参数前的上一版 manifest） |

- 内联账号的 key 只写进插件数据目录的 `config.json`（宿主看不到）；宿主若发来一把真实 bearer，只在当次请求的内存里用、不写盘。面板与工具只回显掩码提示（`maskKey`），日志不打印 key。
- 上游流量只发往面板里配置的 `baseUrl`（默认 `https://api.cline.bot/api/v1`）。传输层用 Node 全局 `fetch`；宿主对 `pi.net.*` 的出口域名白名单不在这条路径上。
- 请求历史只记模型 / 命中通道 / 账号名 / 状态 / 耗时 / token / 备注。

---

## 🔌 端口

> 小结：单一常量改一处，全链路跟着走。

- `41593` 现在是 `src/protocol.js` 里的单一常量 `GATEWAY_PORT` / `GATEWAY_BASE_URL`（原先写在 manifest 的 provider baseUrl 里；provider 声明删掉后就挪到代码里了）；所以**改端口只改这一个常量**（网关监听、生成配置里的 baseUrl、面板显示都跟着它走）。
- 端口被占用时：插件不会静默降级 —— 日志里 `gateway did not start`，面板顶部显示启动错误，并弹一次通知。
- 网关只监听 `127.0.0.1`，且校验 `Host` 头：非本机来源直接 403。

---

## 📜 宿主契约（按 PI-Desktop 0.19.1 核对）

> 官方开发说明随应用一起发布：`<安装目录>\resources\skills\plugin-development.md`。与本插件相关的硬约束与实际做法：

| 宿主约束（实现里核实） | 本插件 |
| --- | --- |
| 面板调用 30 秒（`PLUGIN_PANEL_TIMEOUT_MS`）、agent 工具 110 秒（`PLUGIN_TOOL_TIMEOUT_MS`）、命令 30 秒 | 面板 25 秒 / 工具 100 秒的预算，超时给出可读原因，已完成的请求仍留在历史里 |
| 面板桥只转发 `skill.list/read/create/update/remove/setEnabled` | 面板用 `skill.setEnabled` + `payload.action` |
| 面板桥另有固定通道（`app.getAppearance` 等），主题变化推 `appearance:changed` | 面板首帧预绘主题、订阅 `appearance:changed`，并把 body 真实配色回写给标题栏胶囊 |
| `<meta name="pi-plugin-chrome" content="v2">` 表示插件自己留出 46px 标题栏（只有 legacy 才由宿主补） | 声明 v2 并自留 `var(--pi-plugin-titlebar-height, 46px)` |
| 插件进程只继承最小环境（`PATH`/`TEMP`/`HOME`/… + `PI_PLUGIN_ID`、`NODE_ENV`） | 不提供读环境变量的账号来源 |
| onLoad 15 秒、其余 hook 5 秒；onLoad 抛错会让整个加载回滚 | 端口被占用只记录 + 弹通知，不抛错 |
| `PluginCheck` 校验清单与打包规则，但不校验渲染期字段形态 | 另加形态守卫测试（见下） |
| 模型选择器只列 `enabled && (hasSecret \|\| authKind === "none")` 的 provider；空 `models` 只在 `(authKind ?? "api_key") === "api_key"` 且有 `baseUrl` 时才合法 | 插件**不声明 provider**（这两条约束都不再适用）；用户导入的 provider 带占位 bearer `pi-desktop-no-auth`，网关忽略它、改用自己的账号池 |
| `fs.write` 是高危权限；`fs.write.root: "userSelected"` 时 scope 由用户选目录决定，句柄只活在插件进程内；`pi.fs.requestDirectory()` 断言的是 **`fs.read`** 权限 | manifest 同时声明 `fs.read`（**不给任何 `fs.read` 规则**，不放开可读路径）与 `fs.write`；代码只写一个字面量文件名 `models.json`，不读不删其它文件 |
| 插件模型的 manifest 字段只有 7 个会被 host-core 落库：`id` / `name`(→`alias`) / `contextWindow` / `maxTokens` / `supportsImages` / `thinkingLevels` / `defaultThinkingLevel` | 面板只给这 7 个开关；`thinkingProtocol` / `supportsDocuments` / `availableForSubagents` / `nativeWebSearch` / 来源标记 / 生图这些宿主专有字段写不进生成配置，导入之后到设置页那张卡里改 |
| 插件 provider 行只在宿主启动 / 安装 / 启用时同步一次，开发热重载**不**刷新 | 插件现在**不声明 provider**，参数改动走生成配置、**不需要重载**；只有增删声明本身才与宿主交互一次 |
| 委派（子代理）目录只收 `binding.availableForSubagents === true` 的模型（`if (!binding.availableForSubagents) continue;`），而插件 provider 拿不到这个字段 | 这正是本插件改成「生成配置 → 从其他工具导入」的原因：只有**你自己的** provider 能在设置页勾上它 |
| `pi.models.list()` 需要 `models.list` 权限；**扩大 `permissions` 不会随热重载生效**，宿主必须显式重新加载（开发说明原话：热重载不会授予你没批准过的权限） | 面板的「宿主侧同步状态」行靠它；未授予时降级成灰字说明，不假装成功 |

---

## 🔄 与 DSH 版的差异

> 小结：同一内核，不同外层接法。

|  | DSH | 这里 |
| --- | --- | --- |
| 接法 | LLM adapter 直接挂进请求链 | 面板生成配置 → 你自建 provider → 本机网关（`src/gateway.js`）承载同一条请求路径 |
| 思考档位 | DSH 词表 | PI 词表（`off/minimal/low/medium/high/xhigh/max`）；宿主发 `reasoning_effort`，`off` → 删掉该字段 |
| 密钥 | DSH 配置 | 插件数据目录 `config.json`（内联账号，可多个轮转）；插件**不声明 provider**，宿主侧没有密钥可填 |
| 面板桥 | DSH 面板通道 | `skill.setEnabled` + `payload.action` |
| 官方额度 | 面板直接读 | 同一接口、同一显示口径（已用 % + `usageColor` 三档 + ‹ › 翻页 + 灰字错误），多一层按账号逐读与 60 秒缓存，缺百分比降级显示而不是补 0 |

`src/protocol.js`、`src/engine.js`、`src/catalog.js` 与账号池（`src/config.js`）按 DSH 0.2.5-p3 的 `lib/*.js` 逐字对照改写为 CommonJS。

---

## 🛠️ 本轮修复（对照文档 / 宿主实现后改动，39 条）

> 本节逐条记录对照开发说明与宿主实现之后的每处改动：根因、修法，以及如何验证。编号与先后顺序保持不变，按主题分组便于检索。

### A 组 · 宿主契约与加载稳定性（1–5）

1. **`contributes.services[].label` 由 `{en, zh-CN}` 改为字符串**：宿主只校验 `service.id`，渲染时把 `label` 当文本，对象直接进 React children → 整页崩（minified error #31）。这是加载时把应用弄崩的那一处。
2. **`contributes.providers[].category` / `.description` 由对象改为字符串**：校验器两种形态都收，但渲染侧 `providerDisplayName` 是直接当 React child 用的，而 21 个已装/内置 manifest 里没有第二个插件声明过 provider—— 对象形态在真机上从未被走过，不再赌它。
3. **去掉读环境变量的账号来源**：插件进程是最小环境，这个功能本来就不可能工作。
4. **面板与工具加上时间预算**：面板原先写 90s/300s，远超宿主 30 秒的面板上限。
5. **补 `appearance:changed` 订阅**：换主题时无需重开面板。

### B 组 · 网关内核与模型目录（6–8）

6. **非流式一律可回退流式拼装**：上游 `api.cline.bot` 对 `stream:false` 回 500 `{"error":"empty response content"}`（真机实测），`engine.collectCompletion()` 把同一条请求改成流式并拼回一个 JSON 响应，`reasoning` / `tool_calls` / `usage` / `provider` 都保留。
7. **日志噪声**：宿主把插件 stderr 一律记成 `level:"error"`，所以 `createLogger` 只在失败时写 stderr，进度只进 `gateway.log`。
8. **模型参数表按 Cline 官方目录重写**：14 个 `cline-pass/*` 的上下文 / 输出 / 图片 / 档位逐条对照；档位按模型收敛，`qwen3.8-max` 标 `fallback`（官方目录里这个条目用的就是它自己的兜底常量）。

### C 组 · 面板交互与持久化（9–10）

9. **面板即时反馈**：动作点击后同一个 tick 里锁按钮 + 顶部 busy 条 + 秒数计时，任何终局路径都会解锁并留一行日志。
10. **`modelSettings` + manifest 回写**：参数 / 注册项写进 `config.json`，再回写本插件的 `manifest.json`（写前备份到数据目录）。

### D 组 · 用量与额度体系（11–14）

11. **用量账本**：每个请求落一行 `usage.jsonl`，面板与 `cline_pass_usage` 工具给出窗口汇总与明细。
12. **新增 `cline_pass_usage` 工具并锁住声明**：`manifest.json` 的 `contributes.agentTools` 与 `main.js` 的 `TOOL_NAMES` 有守卫测试逐项对齐 —— 这条正是测试先抓出来的（manifest 漏声明时宿主不会暴露该工具）。
13. **官方额度**：移植 DSH 的 `usage-limits` 读取（`src/cline.js` + `src/quota.js` + 网关 `ops.quota` + 面板卡片 + `cline_pass_quota`），并把「缺失百分比」这条规则贯穿三层（解析 / 归一化 / 渲染）：三处都先判 `null`/`""` 再转数字，因为 `Number(null)` 是 0，否则缺值的窗口会被画成「剩余 0%」并标红。回归测试先红后绿（测试、渲染断言各加一条）。
14. **额度卡片按原版重做（用户截图纠正后）**：第一版卡片自作主张显示「剩余」、错误标红、账号叠着排；实际原版（`dsh-cline-pass/lib/client.js` 的 `UsageCard` + `usageColor` + `countdown`）是 **显示已用 %**（≥90 红 / ≥70 橙 / 其余绿）、账号池 `‹ 名字 [当前] 第 i / n 个 ›` 一次一个、读不到用**灰字**。已整块复刻（含 `已用` 的 aria 与 tooltip、倒计时从 `resetsAt` 现算、单账号不给箭头），并新增 53 条渲染断言（`test/render-quota.cjs`）锁住这套口径，随后又按独立评审的原版对照修掉 6 处偏差。

### E 组 · 账号体系与额度卡修复（15–17）

15. **重复 key 检测（真机踩到）**：两个内联账号填了同一个 key（掩码逐字相同、weekly `resetsAt` 只差 250 ms）时，面板会把同一个账号的额度显示在两个名字下 —— 用户就是拿这个来报「额度也不对」的。现在 `src/config.js` 的 `duplicateNames()` 按**真实 key** 分组（key 永不返回、永不记日志），`ops.quota` 与「账号池」数据都带 `duplicate` 布尔（「账号池」里撞车的行会挂一个「同一个 key」小标）；额度卡的翻页行显示掩码，撞车时补一句灰字说明。不是解析错，也不是语义错。
16. **账号池可编辑、`host` 不再占一行**：`update` 现在支持改名（`renameTo`：查重、拒绝改 `host`、single 模式的 active 账号跟着改）；面板每行加「编辑」，把该账号载入上方表单（账号名 / 显示名 / 换 key，**key 留空 = 不改动**），按钮变「保存」并出现「取消」。`host` 那行不再列在表里 —— 它的 key 只在请求内存里，读不到也改不了，留着纯噪音；改由顶部提示说明它还在不在。报头也从「账号 N」（含 host）改成「内联账号 N + host」，与表里一致。
17. **额度卡也过滤 `host`、错误只说中文**（用户第二次纠正：「你这里还留着呢 不全面一点」）：上一轮只把 host 从「账号池」表里拿掉了，额度卡还把它当第 1 / 3 个账号列着，后面拖着一长串英文。现在 `ops.quota` 的每行都带 `source`（网关两条返回路径 + `quota.js` 透传），渲染层 `quotaAccounts()` 过滤掉 `host`（标题只数内联账号）、`quotaHiddenHosts()` 让「只有 host」和「一个账号都没有」说不同的话、`quotaErrorText()` 把网关/上游的英文压成一句短中文（原文留在 `title`）。渲染断言 53 → 63 条，网关测试补 `source` 断言（45/45）。真机核对（拿插件自己的网关对着真实数据目录跑一次 `ops.quota({ refresh: true })`）：3 行、host 行标 `source:"host"`、面板会只列 2 个内联账号。顺带确认用户在面板里改 key 生效了：两行掩码已不同（掩码只回前 6 + 后 4 位，形如 `sk_aaa***1111`），`duplicate:false`，读数各自独立（21/36/18% 与 0/100/84%）。

### F 组 · Provider 与模型卡演进（18–20）

18. **整条 provider 从模型选择器里消失（真机+宿主代码定位）**：用户截图 `Cline Pass（本地网关）` 那一行挂着「尚未设置 API 密钥」，而模型列表里根本选不到。根因不是面板也不是网关照，而是**宿主的选择器门槛**：`SettingsPage` 的徽章条件是 `!hasSecret && authKind !== "none"`，模型选择器（`ComposerPermissionPicker` / `listReadyPluginModels`）只列 `enabled && (hasSecret || authKind === "none")` 的 provider —— 插件把 key 存在自己的 `config.json` 里、宿主 `secret_ref` 永远是 NULL，于是 5 个模型虽然已经落进 `providers.config_json`，却整条被过滤掉。修法：provider 声明改成 `authKind: "none"`，同时插件把宿主发来的占位 bearer（`pi-desktop-no-auth`）当成「没有 key」忽略，不再拿它去请求 Cline。测试先红后绿（回退 `keyFor` 那一行时该用例报 `actual: 200, expected: 502`，证明它真的在守这条路径）。
19. **模型卡按宿主「模型设置」页对齐，并说清哪些字段插件根本声明不了**：官方那屏的 13 个字段里，**插件 provider 只有 7 个会被 host-core 落库**（`id` / `name`→`alias` / `contextWindow` / `maxTokens` / `supportsImages` / `thinkingLevels` / `defaultThinkingLevel`）—— 实测宿主库里我们这行的 `config_json.models[0]` 恰好就是这 7 个键，且 `name` 被改写成 `alias`。所以面板模型卡补齐了官方那套交互（上下文窗口预设 `128k/256k/312k/500k/1M`、最大输出预设 `4k/8k/16k/32k/128k`、7 个思考等级 chips、默认档位下拉含 `omit`）、并把 `thinkingProtocol` / `supportsDocuments` / `availableForSubagents` / `nativeWebSearch` / 生图这些**宿主专有**字段放成只读说明，不给假开关。
20. **模型卡按官方那屏重做**（前端由 Kimi K3 实现，我复核）：单列「左标签 + 右控件」；上下文窗口与最大输出各配一套预设 chips（`128k/256k/312k/500k/1M`、`4k/8k/16k/32k/128k`，点 chip 填值并高亮）；7 个思考等级做成 chips；新增「显示名（别名）」；默认档位下拉补 `omit`；宿主专有的 5 项（思考协议 / PDF / 自动调度 / 联网搜索 / 生图）单独成块且**只读**。
    - 用户报的「默认档位点不开」根因：`refreshLevelChoices()` 在卡片挂进 DOM **之前**就从**卡片根节点**查复选框 → 查到 0 个 → 选项为空且 `disabled = true`。改成从本地 `.levels` 容器读，并用新断言器回归锁死。
    - **Kimi 的实现里有两处是死的，我在后端补上了**：`patch.name`（别名）与 `defaultThinkingLevel: "omit"` 原本会被 `sanitizeSettings` 丢掉（白名单只认那几个键，`effectiveModels` 还要求默认档位必须在 `thinkingLevels` 里）—— 现在两者都保留（别名 trim + 截断 60 字符，`published.name` 供对照），并补了单测（先红后绿）。
    - 新增 `test/render-model-card.cjs`：60 条断言跑在假 DOM 上（从 `renderer/index.html` 现抽模型卡整块），并对实现副本注入 **6 处故障 —— 全部转红**（候选改回根节点查找 → 20 条失败；chip 不再高亮；`off` 校验被跳过；别名写成 `patch.alias` …），证明断言不空转。

### G 组 · 工程收尾与流式回退（21–23）

21. **命名规范化与仓库收尾**：插件目录 `pi.cline-pass` → `cline-pass`（`git mv`；插件 id 与数据目录仍走 `io.github.duya07.cline-pass`，未变），全目录 `pi.cline-pass` 引用清零（13 个文件 20 处：JSDoc 模块名、stderr 前缀、health 载荷的 `plugin` 值、工具描述、README 路径）；根 README 把 `pi.transcript-doctor` 标为**已废弃**（宿主 v0.19.1 已修复）、`cline-pass` 行与徽章换成新目录名、TIP 里「宿主侧填密钥」改成 `authKind: "none"` 的正确说法；GitHub 仓库描述补了一句。
22. **账号「测试」按钮的假失败（用户真机报的 `empty response content`）**：上游 `api.cline.bot` 拒绝一切**非流式**请求（HTTP 500 + `empty response content`，同一个请求改流式发就正常），而这条「非流式被拒 → 改流式拼装」的回退原本只内联在 `attemptChat` 里；面板的「测试」按钮（`testAccount`）与 `probe` 直接调 `chatCompletion`，于是拿到一次假红。现在抽出 `completionWithStreamFallback({ baseURL, apiKey, body, signal, timeoutMs })`（返回 `{ result, payload, failed, note }`），三条路径共用；`harvest` **有意不动** —— 它要的正是 `__probe__` 那次 400 的错误正文（通道列表），走回退反而会把列表弄丢。
23. **独立评审又抓到两条真缺陷（同一处改动，都已修）**：① `probe` 的失败分支漏了可选链：`failed` 现在也可能只由「非 2xx」成立，而空体 / 非 JSON 的失败体经 `unwrapEnvelope(null)` 会变成 `null`，`payload.error` 直接 TypeError（前置代理的 502/504 HTML 页正是这情形），面板只会看到一条没有理由的失败；② 拼装体把 **planner** 的路由（`choices[0].delta.provider_metadata.gateway.routing.finalProvider`）平铺进了**根级 `provider`**，而根级 `provider` 恰恰是 **direct** 的标记 —— 真机上每次调用都走回退，于是 planner 被报成 direct、`pinnable` 与通道落错桶。修法：拼装时按管线还原形状（planner 保留嵌套 `provider_metadata`，只有 direct 才写根级 `provider`），失败文本改成 `errorText(payload?.error) || result.text.slice(0, 200) || 「HTTP <status>」` 三级兜底（同一个坑也补在「测试」按钮上）。新增 4 条用例，其中 3 条先红；「测试」按钮那条另用变异验证（去掉兜底 → `actual: '' expected: 'HTTP 500'`）。

### H 组 · 同步状态与样式（24–25）

24. **面板新增「宿主侧同步状态」行 —— 让「选择器里看不到模型」不再靠猜**：宿主是不是真的把本插件的模型同步进了它自己的库，以前在面板里完全看不出来。现在面板 `status` 载荷多一个 `host = { ok, synced, total, missing[], error }`，来源是 `pi.models.list()`：宿主只返回「已启用且就绪」的 provider 的模型，所以「0 条」只能说「不在选择器里」，不能说清是没同步还是没就绪 —— 文案因此不猜原因。为此新增权限 `models.list`（宿主白名单里确有这个名字），而**扩大 `permissions` 是热重载的唯一例外**：宿主必须显式重新加载才会授予，所以重载前这行显示灰字「读不到宿主模型清单」。面板还区分了「一条模型都没注册」（你自己的选择，别怪宿主）与「注册了但宿主没同步」两种状态。
25. **模型卡的复选框不再是蓝色大方块**：根因是全局 `input{ min-height:30px; padding:6px 9px; background:var(--card); border:1px solid var(--line) }` 把 16px 的复选框撑成了带边框的大方块。修法是给 `input[type="checkbox"]` 一条更具体的选择器，把尺寸/内边距/背景/边框按回原生（保留 `accent-color`、`:focus-visible` 轮廓、`:disabled` 透明度），并把模型卡的竖向节奏、hint 行高、chips 尺寸对齐。**复核时抓到同一次编辑的连带损伤**：`.quota-pos` / `.quota-key` / `.field-control input[type=text|number]{width:100%}` 这三条**与复选框无关**的规则被一起删掉了（额度翻页行和模型卡的别名/数值输入都靠它们），已原样恢复；判据是**行集合比对**而不是 `git diff` —— 后者会把新插入块前后的一行标成 delete+add 的配对假象，只看 diff 会误判。脚本块除新增的 `renderHostSync` 外逐字节未变，用**规范化行尾后**的哈希核对（`git show` 给 LF、工作树是 CRLF，直接比会假报不一致）。

### I 组 · 生成配置与分发重构（26–30）

26. **变体 ①：插件不再自动注册模型（用户拍板）**：两条硬限制逼出来的（见上文第 4 步 NOTE）—— 插件 provider 拿不到 `availableForSubagents`，也无法在设置页编辑。改法：`contributes.providers[0].models` 置空（空 `models` 只在 `(authKind ?? "api_key") === "api_key"` 且有 `baseUrl` 时合法，所以同时删掉 `authKind: "none"`）；面板新增 `generateConfig` 动作产出要导入的 JSON（`api: "chat_completions"`、`apiKey: "pi-desktop-no-auth"`、每模型一个 `limit`）；`setModel` 只写 `config.json`、**不再重写 manifest**，因此改参数不再需要重载插件；`registered` 的语义变成"写进生成的配置"。
27. **数值来源换成 models.dev（用户拍板）**：`src/catalog.js` 的 14 条按 PI-Desktop 自带的 `resources/models.dev/api.json` 重算（窗口 `limit.context` / 输出 `limit.output` / 图片 `modalities.input` / 档位 `reasoning_options`，`none` 折进宿主的 `off`），13 条变化 —— 例如 `deepseek-v4.1-flash` 输出上限 943718 → **384000**、`glm-5.3` 与 `kimi-k3` → **131072**、`deepseek-v4-pro` 档位 `high/xhigh` → **`high/max`**；`qwen3.8-max` 原来被标"兜底默认值"，models.dev 里其实有它 → 标记去掉。刷新脚本 `tools/sync-catalog.mjs`（默认读本机快照，`--remote` 走网络，`--write` 才落盘，幂等）。落地时踩过一次自己写的坑：合并时 `...rest` 把 current 的派生字段又铺回去，报告"1 处变化"却写回旧值 —— 已修。
28. **面板补齐（前端由 Kimi K3 实现，我复核并补文案）**：新增「生成配置（导入到模型配置）」卡片（按钮 / 只读 JSON / 复制 / 四步说明）；模型卡与「宿主侧同步状态」行全面改文案（旧措辞会骗人：`注册进宿主模型选择器` → `写进生成的配置`；宿主同步行改成「已导入 N/M」）；保存模型后的提示也从"manifest 已写入"改成"重新生成配置再导入"。新增断言器 `test/render-import-config.cjs`（现 40 条）。
29. **「写入文件」：插件唯一的写盘动作（用户要求"只允许写这一条路径"）**：用宿主的 `root: "userSelected"` 机制 —— 第一次点会弹系统目录选择器（选 `~/.pi/agent`），句柄**只活在插件进程内**；`pi.fs.requestDirectory()` 实际校验的是 **`fs.read`** 权限（在已装宿主包里核实过），所以 manifest 同时声明 `fs.read`（**不给任何 `fs.read` 规则**，不放开任何可读路径）与 `fs.write`；`pi.fs.writeText(pathFromRoot, …)` 收的是**相对 root 的路径**，代码因此只传字面量 `models.json`。取消选择器 → 一个文件都不写；进程内记住目录，第二次是秒写；**0 个模型时直接拒绝**（不用空清单覆盖用户已有的文件）。面板上还有一句提示：选择器是模态窗口、请在 30 秒内选完，超时就再点一次（秒写）。测试从 71 条加到 **76 条**。
30. **干脆不声明 provider（用户："第一个这个可以不要喽"）**：`contributes.providers` 与 `provider.register` 权限一起删除；端口/地址从 manifest 挪到 `src/protocol.js` 的单一常量（`GATEWAY_PORT` / `GATEWAY_BASE_URL`），`manifestPort()` 与 `providerBaseUrl()` 一并删除，`src/` 里再没有任何地方读 `contributes.providers`。宿主会在下一次同步（停用→启用/重启）删掉那行（对账逻辑会枚举 `owner_plugin_id` 的行）。另外查明并写进上一节：`pi` 导入格式**硬编码**思考档位（`reasoning: true` → `off/low/medium/high`），所以 models.dev 的梯子只能在设置页里手改 —— 这不是"没对齐"，是导入格式的限制。

### J 组 · 模型元数据与 id 拼写对齐（31）

31. **网关 `/v1/models` 改报导入拼写，`name` 改用面板的有效名（对齐宿主的探测结果）**：宿主导入 provider 后会去探测它的 `/v1/models`，把读到的写进自己的 `models` 表（`source = discovered`）。而本插件端点原来广播的是**目录 id**（`cline-pass/x`），生成的配置却用 `cline-pass-local/x` —— 两边自相矛盾，实测有两个后果：① 撞名从探测这条路又回来了（宿主的委派 key 是 `<vendorKey>/<模型 id>`，于是 `custom/cline-pass/x` 与直连 `api.cline.bot` 那条同名），② 宿主 `models` 表里该 provider 名下**只有 14 行目录 id、一行导入 id 都没有**，导入的 5 条没有显示名而探测出来的 14 条有。改法：`modelsEndpointPayload()` 用 `importModelId()` 重拼 id，`name` 改用**面板的有效名**（此前这个「显示名」字段完全空转 —— 宿主导入不读 `name`，端点又只用目录名，两边都没用上）。网关照旧三种拼写都收，所以纯 OpenAI 客户端「拿到什么就发回什么」也能用。测试加三条断言：广播 id == 生成配置 id、每条广播 id 都能反查回目录模型、面板改名后 `/v1/models` 跟着变。

### K 组 · 宿主档位直写（32）

32. **「写入宿主档位」：面板一键把插件的档位写进宿主那一行（用户要求）**：宿主的 `models.json` 读取器没有档位字段（见第 30 条），所以导入后档位永远是硬编码 `off/low/medium/high` + `medium`，`max` 选不到。宿主也不给任何 provider 写接口 —— `providers/list`、`providers/listModels`、`providers/modelCatalogStatus` 全是读，`providers/refreshModelCatalog` 只刷 models.dev 目录；唯一带档位的载荷 `parseProviderImportPayload`（字段表 `MODEL_FIELDS` 含 `thinkingLevels`）只有云同步与 SSH 导入两个入口，且都要过 `isSyncableProvider` → `networkEndpoint()`，而那个函数明确拒绝 `127.x`。所以新增 `src/hostladder.js`：用宿主自己也在用的 `node:sqlite` 打开宿主数据库，把 `thinkingLevels` / `defaultThinkingLevel` 写进「`base_url` 指向本网关」的那一行。**这是明知故犯的越界**（写的是宿主数据库，没有任何已声明权限覆盖它；插件本来就跑在宿主主进程里、用 `node:fs` 写自己的 config.json 与 usage.jsonl），所以护栏写死在代码里：只在面板点按钮时跑；必须**恰好一行**匹配，否则拒绝；`config_json` 必须能解析出 `models` 数组，否则拒绝；只改这两个字段，其他键与顺序原样保留；只认本插件 `cline-pass-local/` 前缀映射回目录的 id，用户手加的模型一律跳过；写进去的默认档位必须在自己那套档位里（宿主自己的校验规则）；写之前把原 `config_json` 存进插件数据目录，「撤销」按钮原样放回去。测试 `test/host-ladder.cjs`（34 条：纯计划函数、只动那一行、另一条 provider 逐字节未变、重复点是无操作、撤销还原到原字节、四条拒绝路径）。**两个已知代价**：设置页里对那条 provider 点一次「保存服务」，宿主会用内存里的旧副本覆盖回去；每次「重新导入」也会回到硬编码档位。

### L 组 · 两套发布值可选（33）

33. **两套发布值可选（用户要求「把 cline pass 那一套加回去」）**：`src/catalog.js` 现在带**两张表** —— `MODEL_CATALOG`（models.dev 的读数，`tools/sync-catalog.mjs` 可刷新）与 `CLINE_PUBLISHED`（**Cline 自己发布的那套**：窗口、输出上限、档位 lever 与 levels，读自 Cline SDK `sdk/packages/llms/src/catalog/catalog.generated.ts` 的 `cline-pass` provider key 与 `cline-recommended.generated.ts` 的 `clinePass[]`，2026-10-13）。两套确实不一样：`deepseek-v4.1-flash` 的输出上限 models.dev 报 **384000**、Cline 报 **943718**；`deepseek-v4-pro` 的档位 models.dev 是 `high/max`、Cline 是 `high/xhigh`。`catalogEntry(id, source)` 按 `source` 合并，未知 source 读作 models.dev，Cline 表没覆盖的模型保留 models.dev 的数（不会静默丢成空）。显示名与图片能力**始终**来自 models.dev —— Cline 的生成目录不发布这两项，自己补就成了第二个猜测。选择存在 `config.json` 的 `catalogSource`（`models.dev` | `cline-pass`；`normalize()` 只认这两个值，`setConfig` 是唯一写入口），面板「模型参数」卡顶部有下拉；它决定「官方值」栏、生成配置里的 `limit.*`、以及 `/v1/models` 广播的数字。测试：`gateway.test.mjs` 新增一条覆盖上面每一点，**56/56**。

### M 组 · 参数来源反转（34）

34. **参数来源反转：插件不再自己规定参数，改成「宿主那一行说了算」（用户要求）**：原来面板的数值/档位是插件的源、宿主只是镜像，两边可以不一致。现在反过来 —— 新增 `hostladder.readHostModels()`（只读，3 秒 TTL 缓存，写后由 `invalidateHostModels()` 失效）把宿主那一行的窗口 / 输出 / 图片 / 档位读回来，`effectiveModels(settings, source, hostModels)` 的优先级变成**宿主 → 面板 → 目录**（宿主没有该模型的行时，面板的值才是「初版 / 兜底」）；网关的 `modelParams()`（请求路径的档位映射）、`/v1/models`、`ops.status` 三处都改走这条链，所以**档位映射用的是宿主那套**，面板改档位不再影响运行时。面板侧：`addField` 给「来源是宿主」的字段挂 `宿主` 标记并**只读**（窗口 / 输出 / 图片 / 档位复选框 / 默认档位都禁用），卡片尾部一句说明「要改请去宿主设置页改，网关几秒内会跟着变」；`refreshLevelChoices()` 原来会把默认档位重新启用、`levelsWrap.textContent = ""` 会把标记清掉，两处都按来源修正了。「宿主档位」卡新增**只读对比**（`hostLadderDiff` 动作）：逐模型列「宿主现值 vs 目录建议」并标 ✔/✖ —— 档位仍可能停在导入时的硬编码值上，那正是那个按钮要修的状态。读取失败一律返回 `null`（不是空 map），避免把「读不到」当成「没有参数」；`hostDbPath()` 也加了护栏：`dataDir` 为空时不再回退到真机路径，否则测试会读到你自己的库。测试：`host-ladder` **34 → 45**（读取器、缓存与失效、空 dataDir、无该行读作 null）、`gateway` **56 → 57**（宿主优先于面板与目录、`origin` 标记、无宿主时的回落）、`render-model-card` **60 → 68**（宿主字段只读 + 标记 + 只说明一次；无宿主时保持可编辑）。

### N 组 · 面板减负与两处修复（35）

35. **面板排版减负 + 两处真机 bug（用户反馈 5 点）**：① **`origin` / `host` 漏在 status 拼接里** —— `ops.status()` 是逐字段拼模型对象的，我把 `origin`/`host` 加进了 `effectiveModels` 却忘了加进这个拼接，于是面板永远收不到来源标记，**「宿主」标记与只读全部不生效**（真机现象：用户找不到任何「宿主」标记）。已补，并在 `gateway.test.mjs` 的接线冒烟里加三条断言钉住（status 必须带 `origin` 且取值合法、必须带 `host` 键）。② **「写进生成的配置」勾了没用** —— 那张卡的设计是「改动后点卡片底部的『保存模型参数』才提交」，而卡片很长、按钮在屏幕外，勾完看不到任何变化。现在 `registered` 这个布尔**勾上即保存**（没有校验要跑），保存后 `refresh()` 让徽标立刻变，日志也明说「已勾选 / 已取消勾选」。③ **排版重构（前端由 Kimi K3 实现，我逐项复核）**：原来「生成配置 / 宿主档位 / 模型参数」是三张各自带 4–8 行长 hint 的卡片，纵向堆在「模型与通道」tab 里非常吵；现在合并成**一张 `#import-and-params`（「导入与模型参数」）**，内部三节（`generate-config-card` / `host-ladder-card` / `model-settings` 都保留为节容器），首屏只留一句话摘要 + 关键警告，长解释收进 `<details><summary>说明</summary>`。**复核方式**（不采信子代理自述）：只允许改 CSS 与标记 —— 验证脚本区（`<script>` 起止之间）**行数与改动前逐行一致（1800 行）**、脚本里不出现任何新 class 名（`import-section` / `import-title` / `import-and-params` 零命中）、`git diff` 的 hunk 全部落在 CSS 与标记区、五个渲染/接线测试全过。

> **后续（第 36 / 37 条）**：用户先澄清要的是**独立 tab**（卡搬进「导入与参数」，第 36 条），随后指出**模型列表属于模型页** —— 于是「生成配置 / 宿主档位」留在新 tab，「模型参数（含模型列表）」搬回「模型与通道」（第 37 条）。

### O 组 · 面板 tab 拆分与检查加固（36）

36. **「导入与参数」独立成页 + 两处接线检查加固**（用户澄清「卡片重组」= 新增 tab）：第 35 条把三张卡合并成一张 `#import-and-params` 之后，用户指出要的是**独立 tab**，而不是挤在「模型与通道」里。改动只有四处：`<nav id="tabs">` 里在「模型与通道」之后加 `<button data-tab="import">`；`<main>` 里把 `#import-and-params` 从 `#tab-models` 移进新的 `<section id="tab-import" hidden>`（位置在 `#tab-models` 与 `#tab-history` 之间）；**把 `"import"` 加进 tab 切换器的硬编码名单**；顺手修掉上一轮留下的 432 行错误缩进。**第三处是必须知道的坑**：切换器是 `["accounts", "models", "history", …].forEach(name => document.getElementById("tab-" + name).hidden = …)` —— 名字是**字面量数组**，不是从 DOM 推导的；漏加名字则新 section 永远 `hidden`（点了没反应），而多写一个不存在的名字会 `Cannot set properties of null` 直接抛错。`panel-wiring.cjs` 原来的检查只匹配 `getElementById("字面量")`，抓不到 `getElementById("tab-" + name)` 这种拼接，所以补了第 6 组（按钮 ↔ section ↔ 名单两两一致）与第 7 组（「导入与参数」紧跟「模型与通道」、三节都在 `#tab-import` 内、卡已不在 `#tab-models` 内）。同时**复活了名存实亡的检查 2**：原文件里 `emitted` 集合被填充却从未断言（注释写着「每个脚本 emit 的 class 都要有样式规则」，实际一行检查都没跑）—— 现已补上，并把 `\b` 收紧为 `(?![a-z0-9-])`：`\b` 会让 `.import-title` 被 `.import-title-renamed` 满足，是**假阴性**（负向对照实验抓到的：改名规则后旧正则仍报 OK）。**负向对照**（证明新检查不是空转）：删掉 `<section id="tab-import">` → 6 条 FAIL；把脚本 emit 的 `.pill` 规则改名 → 1 条 FAIL。离线验证：`gateway` **57/57**、`host-ladder` **45**、`render-model-card` **68**、`render-import-config` **40**、`render-host-sync` **25**、`host-sync` OK、`render-quota` OK、`panel-wiring` OK、`node --check` 全仓 0 失败、`PluginCheck` 24 文件通过。**真机待看一眼**：重载后新 tab 能切、「宿主」标记出现、勾选即时生效。

### P 组 · tab 归属修正与三处 UI 修复（37）

37. **模型列表搬回「模型与通道」+ 三处 UI 修复（用户 4 点反馈）**：① **模型卡不再默认展开** —— 原来 `entry.open` 的兜底是 `model.id === state.model`，于是打开面板时第一张卡（当前选中的模型）自动展开，把其余卡全挤出屏幕；现在只有用户点开过（`state.openModels[id] === true`）才展开，而 `focusModelEntry()` 仍会在**你主动切换模型**时展开对应的卡。② **「说明」框不再比文字宽一倍** —— `#model-settings > .hint` 上有一条 `max-width: 72ch`，让这张卡的文字只占 ~600px，而 `<details>` 铺满整卡（1235px），于是框看起来「歪出去」；已去掉该限制。③ **数值来源两处可改** —— 原来只有「模型参数」节有这个下拉，现在「宿主档位」节也有一个（档位建议本来就按它算），两处由同一个 `CATALOG_SOURCE_SELECTS` 列表驱动、改哪一处都走同一条 `setConfig`，不会出现两处显示不一致。④ **模型列表回到「模型与通道」** —— 第 36 条把整节搬进「导入与参数」后，用户指出模型卡列表属于模型页：现在「模型与通道」= 模型选择 + 通道 pin + 模型参数（含列表），「导入与参数」= 生成配置 + 宿主档位。**几何实测（不是目测）**：用 headless Chrome 在 900 / 1330 两个宽度、折叠与展开两种状态下量 `getBoundingClientRect()` —— 三个节、每个 `.hint`、每个 `<details>` 的左右边界全部是同一组值（1330 下 `[31, 1266]`），展开后 `scrollWidth === clientWidth`（无横向溢出）。离线验证：`gateway` **57/57**、`host-ladder` 45、`render-model-card` **70**（+2 条：默认折叠、用户展开后重建仍保持）、`render-import-config` 40、`render-host-sync` 25、`host-sync`/`render-quota`/`panel-wiring` OK、`node --check` 0 失败、`PluginCheck` 24 文件。**负向对照**：把 `entry.open` 改回旧逻辑 → `render-model-card` 1 条 FAIL；删掉 `<section id="tab-import">` → `panel-wiring` 6 条 FAIL；把脚本 emit 的 `.pill` 规则改名 → 1 条 FAIL。**真机待看一眼**：重载后首屏不再自动展开、说明框与文字同宽、两处数值来源同步。
>
> **修正（同一轮，最终状态）**：④ 的第一版把「模型参数」**整节**搬进了「模型与通道」—— 用户指出要的是**那一列模型卡**过去、而「模型参数」节留在「导入与参数」。最终：「模型与通道」= 模型选择 + 通道 pin + `#model-list-card`（只含 `#model-settings-list`）；「导入与参数」= 生成配置 + 宿主档位 + 模型参数（数值来源 + 说明）。`panel-wiring.cjs` 第 7 组据此改成：`#tab-import` 必须含 `model-settings`，`#tab-models` 必须含 `model-list-card` 且**不含** `model-settings-list`。
>
> **⑤ 补「保存模型参数」按钮（用户「第二个卡片的按钮呢」）**：列表搬走后「模型参数」节只剩数值来源与说明，文案却还写着"在此调整参数并保存"，而唯一的提交入口是**每张模型卡里的**「保存模型参数」—— 用户在导入页看不到任何按钮。现在该节底部有一个**批量**「保存模型参数」（`#save-all-models`）：`modelSettingsCard()` 把每张卡的提交路径挂到 `entry._save`，批量按钮遍历列表逐个触发（`saveModel` 自己会跳过没有改动的），面板同一时刻只允许一个调用，所以其余排队等 `busy` 落下再点下一个。**测试**：`render-model-card.cjs` 新增 7 条（`saveAllModelParams` 已导出，`busy` 按测试既有风格注入）—— 改过的卡提交、未改的卡报「没有改动」且不提交、提交走的是该卡自己的「保存模型参数」路径（断言 `beginBusy` 的 label 带模型名）、其余排在面板定时器上、结束时有一行「批量保存结束」。**负向对照**：把 `entry._save(button)` 改成空操作 → 3 条 FAIL。离线验证：`gateway` **57/57**、`host-ladder` 45、`render-model-card` **77**、`render-import-config` 40、`render-host-sync` 25、`host-sync`/`render-quota`/`panel-wiring` OK、`node --check` 0 失败。
>
> **⑥ 独立评审后的四处修复（`code-reviewer` 只读评审，我逐条核验后采纳）**：① **面板忙时两处下拉会永久分歧** —— `setCatalogSource` 在 `beginBusy` 失败时直接 `return`，而浏览器已经把被点的那个 `<select>` 的原生值改了、这次既不提交也不刷新，两处会一直显示不同的值。现在失败分支先 `renderCatalogSource(state.status)` 把两处拨回当前生效值。② **批量保存无上限重试** —— `busy.active` 长期为 true 时 `step` 每 200 ms 自调度、永远不打结束行（**实测**：去掉上限后测试进程 8 秒仍不终止，只能硬杀）。现在有 60 秒总上限，超时写一行「批量保存中止」。③ **提交可能落在已脱离文档的旧表单上** —— 保存一张卡会让 status 回来、面板可能重建那张卡的 DOM；`step` 现在每一步按 `data-model` 在**当前文档**里取节点，而不是用开始时抓的那批引用。④ **`panel-wiring` 第 9 组断言可被绕过** —— 原来断言 `!/entry\.open = model\.id === state\.model/`，若改成 `… === true || model.id === state.model` 仍会通过；现在取整行断言，并要求该行不出现 `state.model`。**新增测试**：`render-model-card.cjs` **84** 条（+7：忙时不抢锁只排队、越过 60 秒中止并说明、两处下拉同步与忙时回滚）。**负向对照**：去掉回滚 → 1 条 FAIL（打印出 `models.dev / cline-pass` 的分歧）；去掉 60 秒上限 → 进程不终止（8 秒硬杀验证）。

### Q 组 · 首次打开面板与探测通道（38）

38. **面板首次打开不再需要手动刷新 + 探测会走完账号池（用户报「一开面板得先 reload」「探测通道探不出来」）**：① **首次打开的真根因** —— `main.js` 的 `liveGateway()` 在网关服务尚未起来时**抛** `the plugin is not loaded`，而 `case 'status'` 直接 `gw.ops.status(...)`；面板刚打开（宿主加载插件那一刻）拿不到 status，于是留一张空面板，等你点「刷新」时网关已经起来，看起来就像"得先 reload 一次"。现在未就绪时返回 `{ ok: false, code: 'NO_GATEWAY', error: '网关还没就绪（插件正在启动），面板会自动重试。' }`，面板的 `refresh()` 认这个 code **自己重试**（1 秒一次、最多 6 次），不再把这件事丢给用户。② **「探测通道探不出来」的真因不是渲染** —— 实测运行中网关的 status 是 `upstreams: []`、`probedAt: 0`、`pipeline: null`、`lastError: "Error 429: You have reached your weekly Clinepass limit…"`，且 `gateway.log` 里**没有**对应的 `probe complete`（只有 10-15 的旧记录）。也就是说探测**确实失败了**，原因是账号额度（三个内联账号里两个 weekly 已 100%）。旧行为把一次点击耗在**池里第一个**账号上：429 就结束，得反复点直到轮到可用账号。现在 `engine.probe` 拆成 `probeOnce` + 重试包装，`429/500/502/503/504` 会**换账号重试**（账号池是 round-robin，每次拿到不同的），最多 3 次，日志有 `probe retrying`。③ **面板措辞** —— 「还没有通道列表」原来与"从没探测过"同义；现在有 `lastError` 时写「上次探测失败（原因见上方），点"探测通道"重试」。**测试**：`gateway.test.mjs` **58**（+1：三个账号全限流时探测仍失败但请求数 ≥3，证明它走完了池子；有一个可用时探测成功）、`render-model-card.cjs` **89**（+5：`NO_GATEWAY` 时自动重试、最终拿到 status、日志里不出现"失败，按钮已恢复"）。**负向对照**：`PROBE_ATTEMPTS` 改回 1 → 6 条 FAIL（含新测试）；去掉面板重试分支 → 4 条 FAIL。

### R 组 · 请求历史与账号模式的贯穿（39）

39. **「请求历史」改读落盘账本 + 探测遵守账号模式（用户报「请求历史从来没有显示过东西」「固定/轮询没有贯穿」）**：① **请求历史为空的真因** —— 同一次请求被记了两遍：内存的 `store.history`（`store.record`，4 处调用）与落盘的 `usage.jsonl`（`ledger.record`，同样 4 处）。面板「请求历史」读前者、「用量 → 最近请求明细」读后者，于是**插件一重载，请求历史就永远是空的**（`status.historySize` 也一直显示 0）。现在 `ops.history()` 与 `status.historySize` 都改读账本（`ledger.recent()` / `ledger.summary({ days: 0 }).rows`），两个 tab 共用同一份数据；面板上写明分工：请求历史 = 逐条 + 可按模型过滤，用量 = 汇总 + 带 token/成本的最近明细。② **探测没有贯穿账号模式** —— `pool.resolve()` 本身遵守 `single`（固定账号）/`roundrobin`（轮换），但上一轮加的探测重试是**无条件**的：`single` 模式下每次都会拿到**同一个**账号，重试 3 次等于把同一把钥匙插 3 遍（真机上会因此把面板预算耗在一个已知 429 的账号上）。现在 `probeOnce` 回报用了哪个账号，包装层发现**池子给回同一个账号就停**（`probe retrying` 只在真的换了账号时出现）。③ **真实额度证据** —— 运行中网关的 `ops.quota`：`xianglingwk` weekly 已用 100%（3 天 8 小时后重置）、`zzzawv` weekly 已用 100%（7 小时 45 分后重置）、`6636013` weekly 45% 可用；所以轮询模式下探测应当能走到可用账号，固定模式下则必须只用你选的那个。**测试**：`gateway.test.mjs` **60**（+2：新建 gateway 读同一 dataDir 仍能看到账本里的两行、最新在前、失败的请求也保留；`single` 模式下探测只问被固定的那个账号）。**证据强度说明**：这两条的负向对照（把 `ops.history` 改回内存版 / 去掉重复账号检查）**未取得干净 FAIL** —— 改回旧行为会让整个测试套件挂起（后续测试在失败状态下等到 300 秒流超时），只能拿到"挂起"而非"FAIL"；因此这里保留的是正向证据加代码事实（新 gateway 实例的内存 store 必为空），而"挂起"本身也说明不检查重复账号会让面板卡住。

---

## ✅ 自测

> 小结：离线 mock 上游，不需要真 key；覆盖清单形态、预算、pin、流式、failover、生成配置、账本、额度、接线冒烟。

```powershell
cd <本仓库>\cline-pass
node --test test/gateway.test.mjs      # Windows 下必须给文件路径；57 项
node test/render-quota.cjs             # 面板额度卡片：63 条断言，不需要浏览器
node test/render-model-card.cjs        # 面板模型参数卡：68 条断言（含「默认档位点不开」回归 + 宿主字段只读）
node test/render-import-config.cjs     # 面板「生成配置」卡片：40 条断言（生成 / 复制 / 写入文件 / 模型 id 前缀说明）
node test/render-host-sync.cjs         # 面板宿主同步行：25 条断言（六种状态）
node test/host-sync.cjs                # 宿主清单比对 + 写入文件（pi.models.list / pi.fs 桩）：76 条断言
node test/host-ladder.cjs              # 宿主档位直写 + 读取（临时 SQLite 文件 + 真事务 + 撤销）：45 条断言
node test/panel-wiring.cjs             # 面板接线：脚本要的 id/class 是否都还在
```

| 覆盖维度 | 说明 |
| --- | --- |
| 基础一致性 | manifest↔代码一致性（工具 / 面板动作逐项对齐）、**清单形态守卫（`{en, zh-CN}` 只允许出现在宿主会解析 i18n 的位置）**、**面板/工具预算不越宿主上限** |
| 网关内核 | pin 两种拼装的写入与解析、模型清单与外机 403、流式 SSE、非流式 JSON、跨账号 failover 与冷却落点、pin 注入上游、思考档位映射与**按模型收敛**、无可用账号时的 502、probe 抓通道、validate 逐通道、test 走 pin 链、账号 CRUD 不泄漏密钥、端口/状态一致性 |
| 生成配置 | **生成配置（默认 5 个进配置 / 覆盖生效与越界丢弃 / 形状守卫 / 只含勾选模型 / 不碰 manifest / `apiKey` 是占位串）** |
| 账本与额度 | **用量账本（窗口过滤、按模型·通道·天分组、坏行容错、清空、`extractUsage` 的多种成本拼写）**、**官方额度（按账号读取与 60 秒缓存、`refresh` 绕过、401/500 当数据返回、空窗口列表不是错误、缺百分比保持未知）** |
| 接线冒烟 | **接线冒烟（临时网关 start → `/v1/models` → `state` → `usage` → 真实请求落账 → stop，用来抓漏 require 这类只在运行期暴露的错）** |
| 新增覆盖 | **宿主清单比对（`pi.models.list` 桩：缺权限 / 抛错 / 返回非数组 / key 双前缀 / 混入别家模型）**、**面板「宿主侧同步状态」行的六种渲染状态**、**probe 在「非流式被拒 → 流式拼装」下的管线判定（planner 不许被平铺成 direct）**、**非 2xx 无 body 时的错误文本（不许抛 TypeError、不许留空）** |
| 运行方式 | 上游由本机 mock 顶替，不需要真 key、不产生真实流量 |

---

## 🧪 验证状态

> 按验证状态逐条列出 —— 真机已验证、宿主库只读核对、尚未在真机点过的部分，各附证据。

| 状态 | 说明与证据 |
| --- | --- |
| 已验证（真机） | 插件在 PI-Desktop 里加载并持续使用；`development.plugin.reloaded` 多次 `ok:true`、网关 `health` 正常；真实请求走通（非流式 `200`、`provider=deepseek`、`reasoning` 保留、`usage` 有值）；源码 10 个 JS + `main.js` + 6 个测试脚本过 `node --check`；`node --test test/gateway.test.mjs` **53/53**；`node test/host-sync.cjs` 33 条（`pi.models.list` 桩：全同步 / 空清单 / 混入别家模型 / key 双前缀 / 抛错 / 缺 API / 非数组）；`node test/panel-wiring.cjs` 通过（57 个 id、全部 class 有样式、`<style>` 花括号平衡、v2 chrome meta 与标题栏变量还在）；渲染层 63 条离线断言（`node test/render-quota.cjs`：从 `renderer/index.html` 现抽脚本、喂假 DOM 跑额度卡片，口径逐条对照 DSH 原版 `UsageCard`）+ 模型卡 60 条（`node test/render-model-card.cjs`）+ 宿主同步行 25 条（`node test/render-host-sync.cjs`：全同步 / 部分同步 / 未同步 / 一条都没注册 / 读不到 / 缺字段 六种状态的文案与类名）全过；`PluginCheck` 无 error（1 条 warning：`agent.tool.register` / `fs.write` 属高危权限，需你在加载时批准）；清单字段形态与宿主限额按 0.19.1 随应用发布的开发说明 + 宿主实现 + 21 个已装/内置 manifest 逐项对照 |
| 已验证（宿主库只读核对） | 插件 provider 行由**宿主核心在启动 / 插件安装启用时**同步写入，开发热重载**不**刷新它（见上文「生效路径」；证据：连续 4 次 `ok:true` 热重载后该行 `updated_at` 未变） |
| 已验证（真机） | **官方额度的读取** —— 插件自己的 `gateway.log` 有 `quota read {"accounts":3,"ok":2}`（08:06Z），2 个内联账号都读到、host 那行没有 key 读不到；`cline_pass_quota` 工具随宿主重启后注册。本次「额度卡过滤 host」用插件自己的网关对着真实数据目录跑了一次 `ops.quota({ refresh: true })`（临时端口，不碰 41593）：3 行返回、host 行带 `source:"host"`、面板的过滤结果正是 2 个内联账号（两个内联账号的数字各自独立：21/36/18% 与 0/100/84%）。面板的**编辑**路径也因此确认跑通 —— 把其中一个账号的 key 换成自己的之后，两行掩码不同、`duplicate:false`，读数各自独立；这是本次实跑 `ops.quota` 看到的，不是推断 |
| 未在真机上点过（仍然） | 额度卡本次改动的**面板侧呈现**（重开面板 + 刷新后应只列 2 个内联账号、标题 `官方额度 · 2 个账号`）—— 数据路径已实跑核对，渲染侧由 63 条离线断言覆盖，剩下只是打开看一眼；`ops.setModel` 真正改写 manifest 的那条路径在测试里刻意用了与官方值相同的 no-op 写入（避免测试改写随包发布的 manifest），要实机保存一次才算跑过；账本 2 MB 轮转只断言了常量 |
| 本轮已验证（真机数据 + 宿主代码定位） | 宿主那行 `plugin:io.github.duya07.cline-pass:cline-pass` 的 `auth_kind` 已经是 `none`、`created_at = updated_at`（= 你 17:47 重新加载插件那一刻），5 个模型与档位齐全 —— 「模型选择器里看不到」在宿主侧已经解决，之前那张挂着「尚未设置 API 密钥」的截图是**旧渲染**。（**后续**：第 30 条把 provider 声明整个删掉后，那行已被宿主回收，选择器里不再有插件那一行。） |
| 本轮新增（真机待看一眼 → **后来已实测**） | 面板的**宿主侧同步状态行**（第 24 条）。它读 `pi.models.list()`，而 `models.list` 属于**扩大 `permissions`** —— 开发说明写明热重载不会授予你没批准过的权限，必须**显式重新加载**插件。所以在你重新加载之前，这行会显示灰字「读不到宿主模型清单：…」；重新加载之后显示「宿主模型已同步：N/N 已导入，模型选择器里可见」—— 重新加载后实测 `plugin.api models.list ok:true`（count 64），这一行是通的 |
| 本轮真机观察到（权限门槛确实生效，实测） | 插件目录里**任何一次保存**都会让宿主尝试热重载，而因为 manifest 多要了 `models.list`，宿主**拒绝**了这次重载 —— `logs\app\plugin.log` 里连着一串 `development.plugin.reloaded ok:false` 与 `PERMISSION_DENIED: manifest now requests models.list; reload it from the Plugins page to review`（18:31–18:32 本地，多次）。**旧实例没有被拆掉**：`http://127.0.0.1:41593/v1/models` 仍然 `HTTP 200`（14 个目录模型），也就是这段等待期里网关照常服务、只是新代码尚未生效；在插件页重新加载一次即可全部生效。对照证据：另一个插件 `cn.star.skill-learning` 的 `plugin.api models.list ok:true count:63` 说明这个权限名与 `pi.models.list()` 在真机上是通的 |
| 本轮新增（变体 ①，2026-10-13 深夜） | 插件**不再声明任何 provider**（`contributes.providers` 与 `provider.register` 权限都删了），模型参数只写插件配置；面板新增「生成配置 / 写入文件」，导出给 PI-Desktop「从其他工具导入」用 —— 原因与实测证据见上文第 4 步的 NOTE。离线验证：`node --test test/gateway.test.mjs` **54/54**、`node test/host-sync.cjs` 75、`node test/render-import-config.cjs` 36、`node test/render-host-sync.cjs` 25、`node test/render-model-card.cjs` 60、`node test/render-quota.cjs` 63、`node test/panel-wiring.cjs` OK；`node --check` 全部 JS 与测试脚本 0 失败；`PluginCheck` 通过（22 文件；warning 列 `agent.tool.register` 与 `fs.write`）。**真机进度（2026-10-13 深夜复核，只读核对宿主库）**：用户已按流程导入成功 —— 他自己的 provider（`<你的 provider id>`：`base_url = http://127.0.0.1:41593/v1`、`api_style = chat_completions`、`auth_kind = api_key_and_base_url`、5 个模型）；重载后**插件那一行已从宿主库里消失**（`providers` 表里再无 `owner_plugin_id` 非空的行）—— 删掉 `contributes.providers` 之后宿主确实回收了旧行，选择器里不会再出现插件那一行。委派目录（`<vendor_key>/<modelId>`）里已出现 `custom/cline-pass/<模型>`（勾了「可供 AI 自动调度」1/5）。已实测（2026-10-14 01:0x）：面板「写入文件」跑通（`fs.requestDirectory ok:true path="<home>\\.pi\\agent"` + `fs.writeText ok:true`），磁盘文件与 `importConfigPayload()` **逐字节一致**；用户删掉旧 provider 后重新导入，新 id 也是他自己新建的那个（5 个模型，baseUrl 仍指网关）。档位仍是宿主通用那套（用户未手改）；勾选仍只有 1 个 |
| 本轮新增（数值来源换成 models.dev） | `src/catalog.js` 14 条按 models.dev 重算（13 条变化），刷新脚本 `tools/sync-catalog.mjs`，幂等复跑 0 变化 |
| 本轮新增（2026-10-14 凌晨，用户拍板） | **生成配置里的模型 id 改带 `cline-pass-local/` 前缀**，网关再做映射 —— 为了消掉委派目录的 key 撞名（见上文 WARNING「子代理侧更隐蔽」）。用户当时的原话是「你确定撞的是模型 id 而不是名字？」—— 确实是模型 id：委派 key 是 `<vendorKey>/<模型 id>`，用户自建 provider 的 vendorKey 全是 `custom`，provider 显示名根本不进 key，所以「改个 provider 名字」没有用（而且默认名本来就叫「Cline Pass（本地网关）」，早就区分开了，照样撞）。改动：`src/models.js` 新增 `IMPORT_MODEL_PREFIX` / `importModelId()` / `unimportModelId()`，`importConfigPayload()` 用前缀拼 id；`src/gateway.js` 的 `normalizeModelId()` 先剥前缀再查目录，**三种拼写都收**（`cline-pass-local/x`、`cline-pass/x`、宿主的 `x`），落不到任何模型时原样透传（错模型应答比上游报错更糟）。面板「生成配置」卡片与「模型参数」卡片都加了说明（用户要求：别让人以为改了名就路由不回去）。TDD 顺序：先写会红的用例（网关把 `cline-pass-local/…` 原样转发 → `actual: 'cline-pass-local/<模型>'`），再改实现。离线验证：`gateway` **55/55**（+1 条：三种拼写 + pin 跟随 + 未知 id 透传）、`host-sync` **76**（+1 条：前缀契约）、`render-import-config` **40**（+4 条：前缀说明文案）、`render-host-sync` 25、`render-model-card` 60、`render-quota` 63、`panel-wiring` OK、`node --check` 0 失败。**用户侧代价**：旧 provider 里的 id 是旧拼写，要享受前缀必须**删掉重新导入一次**（导入器判重会跳过同名 provider） |
| 本轮新增（2026-10-14 01:5x，**真机端到端验证通过**） | 用户重载插件 + 重新「写入文件」+ 删旧 provider + 重新导入之后，前缀方案在真机上闭环 —— 面板「写入文件」写入 **1704 字节**（旧拼写是 1675），网关日志 `import config written {"bytes":1704,"models":5}`；新 provider（`<你的 provider id>`，baseUrl 指网关、5 模型），旧的已删；委派 key 变成 `custom/cline-pass-local/<模型>`。用 `custom/cline-pass-local/<模型>` 起 explorer（任务：读 `src/protocol.js` 报 `GATEWAY_PORT` / `GATEWAY_BASE_URL`）**返回正确答案**；但"任务完成"不等于走网关，所以核对了账本：`usage.jsonl` 从 5 行增到 **7 行**，两笔都是 `model: "cline-pass/<模型>"`（**目录 id** —— 说明网关把 `cline-pass-local/<模型>` 剥前缀映射回去了）、`status=200`、2 秒上下、带成本；`gateway.log` 同期还有 `account benched {"reason":"QUOTA_EXCEEDED","ms":900000}`（冷却 + failover 又一次真机复现）。宿主转录里该 delegation 记的 `modelId` 是 `cline-pass-local/<模型>`（请求的拼写）—— 请求拼写 → 宿主 provider → 网关映射 → 目录 id → 上游，链路闭合。**撞名消失的对照实验**：再起一个**没勾**「可供 AI 自动调度」的模型，宿主**明确拒绝** —— `Model "custom/cline-pass-local/<模型>" is not available for delegation. Available: …`，而可用列表里 `custom/cline-pass/*`（直连 `api.cline.bot` 那条）与 `custom/cline-pass-local/*`（网关那条）**分成两个命名空间**；修复前同样的请求会被直连那条**静默接走**（`historySize = 0`、账本无新行、任务却显示"完成"） |
| 本轮新增（2026-10-14，`/v1/models` 拼写对齐 + 宿主库只读核对） | 网关 `/v1/models` 改成广播 `cline-pass-local/<模型>` 之后，宿主的 `models` 表里出现了 `cline-pass-local/deepseek-v4.1-flash`（`source = discovered`、显示名 `DeepSeek V4.1 Flash`）—— 修复前这张表在该 provider 名下**只有 14 行目录 id，没有一行导入 id**。同时核清了「同一个模型 id 在不同 provider 下有的显示 `1M · 384K`、有的显示 `-- · --`」的三步判据（认 provider → 按 id 最后一个 `/` 之后的 leaf 查 → 所有者兜底），以及显示语义（`contextWindowSource` 为 `"user"` 显示存值、为 `"catalog"` 显示目录查到的值、查不到就是 `-- · --`），并据此**否掉**了自己上一轮「把 source 发成 `catalog` 更贴合宿主默认」的想法：`127.0.0.1:41593` 在 models.dev 里没有对应 provider（那边本机只有 `:1337` / `:1234` / `:8081`，且比对是**协议 + host:port 全等**），发 `catalog` 会把整列变成 `-- · --`。离线验证：`node --test test/gateway.test.mjs` **55/55**、`host-sync` 76、`render-import-config` 40、`render-host-sync` 25、`render-model-card` 60、`render-quota` 63、`panel-wiring` OK、`node --check` 0 失败、`PluginCheck` 22 文件通过（warning 仍是 `agent.tool.register` + `fs.write`） |
| 本轮新增（2026-10-14，宿主档位直写：先在真机库上跑过同一套动作） | 把这条路径写进插件之前，先用一个独立脚本在**真机库**上跑通了同一套动作，证明它可行：`VACUUM INTO` 一致性快照（28.8 MB）+ 把原 `config_json` 单独存出来（1163 字节）+ 只改 `providers.config_json` 里 4 个模型的两个字段（事务内 `UPDATE`，`changes = 1`）+ **逐行比对证明 7 行里只有 1 行不同、其他 6 条 provider 逐字节一致** + 25 秒后回读仍是新值（宿主仍在写 WAL，但没覆盖那一行）。插件里的同一逻辑由 `test/host-ladder.cjs` 34 条离线断言覆盖（临时 SQLite 文件，不碰真机库）。**已知代价**：设置页里保存那条 provider 会覆盖回去；重新导入会回到硬编码档位。 |
| 本轮新增（2026-10-14，两套发布值可选） | `CLINE_PUBLISHED` 的值不是新猜的：取自旧版目录（`git show a5f7b68:cline-pass/src/catalog.js`，即 `f7be3b9` 换成 models.dev 之前那张表），出处是 Cline SDK 的 `sdk/packages/llms/src/catalog/catalog.generated.ts`（provider key `cline-pass`）与 `cline-recommended.generated.ts`（`clinePass[]`）。离线验证：`gateway` **56/56**（+1 条来源切换：两套的差、未知 source 回落、`qwen3.8-max` 在 Cline 表里仍是 `fallback`、切换后广播与生成配置都跟着变、非法值被拒）、`host-sync` OK、`host-ladder` 34、`render-import-config` 40、`render-host-sync` 25、`render-model-card` 60、`render-quota` OK、`panel-wiring` OK、`node --check` 0 失败、`PluginCheck` 24 文件通过。**面板侧待看一眼**：下拉切换后「官方值」栏与生成配置应立刻跟着变。 |
| 本轮新增（2026-10-14，参数来源反转） | 插件不再自己规定参数：`hostladder.readHostModels()` 读宿主那一行，`effectiveModels` 的优先级改成**宿主 → 面板 → 目录**，网关的档位映射 / `/v1/models` / `ops.status` 全部走宿主那套。离线验证：`gateway` **57/57**、`host-ladder` **45**、`render-model-card` **68**、`host-sync` OK、`render-import-config` 40、`render-host-sync` 25、`render-quota` OK、`panel-wiring` OK、`node --check` 0 失败、`PluginCheck` 24 文件通过。**真机待看一眼**：面板模型卡上的「宿主」标记与只读、以及「宿主档位」卡的对比表（读的是你库里那条 provider；离线断言用的是临时 SQLite 文件）。 |
| 本轮新增（2026-10-14，面板减负 + status 漏字段修复） | 真机现象驱动：`ops.status()` 逐字段拼模型对象时漏了 `origin` / `host` → 面板的「宿主」标记与只读**全不生效**（已补，并在接线冒烟里加三条断言钉住）；「写进生成的配置」勾完要滚到卡片底部点保存才生效 → 改成**勾上即保存**。面板排版重构由 Kimi K3 实现，我的复核是**结构性**的：脚本区行数与改动前一致（1800 行）、脚本内不出现任何新 class 名、`git diff` 的 hunk 只落在 CSS 与标记区、五个渲染/接线测试全过。离线验证：`gateway` **57/57**、`host-ladder` 45、`render-model-card` 68、`host-sync` OK、`render-import-config` 40、`render-host-sync` 25、`render-quota` OK、`panel-wiring` OK、`node --check` 0 失败、`PluginCheck` 24 文件通过。**真机待看一眼**：重载后的新卡片排版，以及「宿主」标记是否出现。 |
| 本轮新增（2026-10-14，「导入与参数」独立成页） | 三张卡合并后用户澄清要的是**独立 tab**：新增 `data-tab="import"` + `<section id="tab-import" hidden>`，并把 `"import"` 加进切换器的硬编码名单（漏加则新 section 永远 `hidden`，多写则抛 `Cannot set properties of null`）。`panel-wiring.cjs` 补第 6/7 组检查，并**复活了原来只填充不断言的检查 2**（`\b` → `(?![a-z0-9-])`，否则 `.import-title` 会被 `.import-title-renamed` 满足）。负向对照：删 section → 6 FAIL、改名 `.pill` → 1 FAIL。离线验证：`gateway` **57/57**、`host-ladder` 45、`render-model-card` 68、`render-import-config` 40、`render-host-sync` 25、`host-sync`/`render-quota`/`panel-wiring` OK、`node --check` 0 失败、`PluginCheck` 24 文件。**真机待看一眼**：新 tab 能切、排版、勾选即时生效。 |
| 本轮新增（2026-10-14，tab 归属修正 + 三处 UI 修复） | 用户 4 点反馈：模型卡不再默认展开（原来兜底 `model.id === state.model`）；去掉 `#model-settings > .hint` 的 `max-width: 72ch`（它让文字只占框宽的一半，是「说明框歪」的真因）；「宿主档位」节新增数值来源下拉，与「模型参数」节由同一个 `CATALOG_SOURCE_SELECTS` 驱动；模型列表搬回「模型与通道」。几何实测（headless Chrome，900/1330 宽 × 折叠/展开）：三节与各自的 `.hint`、`<details>` 左右边界完全一致（1330 下 `[31,1266]`），无横向溢出。离线验证：`gateway` **57/57**、`host-ladder` 45、`render-model-card` **70**、`render-import-config` 40、`render-host-sync` 25、`host-sync`/`render-quota`/`panel-wiring` OK、`node --check` 0 失败、`PluginCheck` 24 文件。负向对照：旧 `entry.open` 逻辑 → 1 FAIL；删 tab section → 6 FAIL；`.pill` 改名 → 1 FAIL。**真机待看一眼**：首屏不自动展开、说明框与文字同宽、两处下拉同步。 |
| 修正（同一轮） | 「模型参数」节的第一版被**整节**搬进「模型与通道」，用户纠正后拆回：「模型与通道」只放模型列表卡（`#model-list-card` 含 `#model-settings-list`），「导入与参数」放生成配置 + 宿主档位 + 模型参数（数值来源 + 说明）。几何复测（headless Chrome，900 / 1330 宽 × 展开）：`#tab-import` 三个节与 `#model-list-card` 的 `.hint`、`<details>` 左右边界全部一致（1330 下 `[31,1266]`），无横向溢出；`panel-wiring` 第 7 组断言同步更新。离线验证：`gateway` **57/57**、`host-ladder` 45、`render-model-card` **70**、`render-import-config` 40、`render-host-sync` 25、`host-sync`/`render-quota`/`panel-wiring` OK、`node --check` 0 失败。 |
| 修正（同一轮，补按钮） | 模型列表搬走后「模型参数」节没有提交入口（用户「第二个卡片的按钮呢」）：新增批量「保存模型参数」（`#save-all-models`）—— `modelSettingsCard()` 暴露 `entry._save`，按钮遍历 `#model-settings-list` 逐个触发，未改动的被 `saveModel` 跳过，面板同一时刻只调用一次（其余排队等 `busy`）。`render-model-card.cjs` 新增 7 条断言（**77**），负向对照（空操作）→ 3 FAIL。 |
| 本轮新增（2026-10-14，独立评审后的四处修复） | `code-reviewer` 只读评审 + 我逐条核验：① `setCatalogSource` 在 busy 冲突时把两处下拉拨回当前生效值（原来会永久分歧）；② `saveAllModelParams` 加 60 秒总上限（原来会无限自调度）；③ 每步按 `data-model` 取**当前文档**节点（避免提交已脱离文档的旧表单）；④ `panel-wiring` 第 9 组改成整行断言（原来可被 `|| model.id === state.model` 绕过）。`render-model-card` **84**（+7）。负向对照：去回滚 → 1 FAIL；去上限 → 进程不终止（8 秒硬杀验证）。 |
| 本轮新增（2026-10-16，首次打开面板 + 探测通道） | ① `main.js` 网关未就绪时返回 `code:'NO_GATEWAY'` 而不是抛错，面板 `refresh()` 认这个 code 自动重试（1 秒 × 最多 6 次）—— 原来会留一张空面板等用户点「刷新」。② `engine.probe` 拆成 `probeOnce` + 重试包装，429/5xx 换账号重试最多 3 次 —— 原来一次点击耗在池里第一个账号上（实测 status `upstreams:[]`、`probedAt:0`、`lastError:429`，`gateway.log` 无 `probe complete`）。③ 「还没有通道列表」在有 `lastError` 时改说「上次探测失败…重试」。`gateway` **58**、`render-model-card` **89**、其余不变。负向对照：`PROBE_ATTEMPTS=1` → 6 FAIL；去掉面板重试 → 4 FAIL。**真机待验证**：重载后首次打开面板应自动等到状态；有账号限流时探测应能走完池子。 |
| 本轮新增（2026-10-16，请求历史与账号模式） | ① 「请求历史」原本读**内存** `store.history`（重载即清空，所以永远是空的），「用量 → 最近请求明细」读**落盘** `usage.jsonl`；同一份数据两个来源。现在 `ops.history()` 与 `status.historySize` 都读账本，两 tab 共用数据并在面板写明分工。② `engine.probe` 的重试原来**无条件**换账号，`single`（固定账号）模式下每次拿到的都是同一个，重试只浪费时间；现在 `probeOnce` 回报账号，池子给回同一个就停。`gateway` **60**（+2：跨实例仍能看到账本行、`single` 模式只问固定账号）。负向对照未取得干净 FAIL（旧行为会让套件挂起），已在正文说明证据强度。 |

---

## 📦 来源

行为移植自 DSH 插件 `dsh-cline-pass` 0.2.5-p3（其 `package.json` 声明 MIT）。本插件目录为改编产物。
