# 🔌 Cline Pass 本地网关 · PI-Desktop 插件

[![version: 1.0.0](https://img.shields.io/badge/version-1.0.0-blue)](./manifest.json) [![license: MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/duya07/pi-desktop-plugins/blob/main/LICENSE) [![PI-Desktop](https://img.shields.io/badge/PI--Desktop-0.19.1-compatible-lightgrey)](https://github.com/vastsa/PI-Desktop) [![gateway: 127.0.0.1:41593](https://img.shields.io/badge/gateway-127.0.0.1:41593-orange)](#端口)

> 把 DSH 的 `dsh-cline-pass` 0.2.5-p3 移植到 PI-Desktop。保留内核，换掉外层接法——插件自带只监听本机的 OpenAI 兼容网关，声明式 provider 的每一次请求都落进同一条路径。

| 维度 | 说明 |
| --- | --- |
| **这是什么** | 本地网关 `127.0.0.1:41593` + 账号池与轮转/冷却 + 通道枚举与校验 + pin / exclude + failover + 流式空闲超时 + 思考档位映射 |
| **怎么看** | 面板五页：账号池 / 模型与通道 / 请求历史 / 用量 / 设置 · 官方额度窗口（5 小时 / 本周 / 本月）· 10 个 `cline_pass_*` agent 工具 |
| **接哪里** | Cline Pass（`api.cline.bot`）· 面板生成的配置 → 你自己的 provider → 本机网关 |

---

PI-Desktop 的插件只能**声明式**注册 provider（`contributes.providers`），请求由宿主自己发出——插件拿不到请求路径。
所以这里保留 DSH 内核、换掉外层的接法：插件自带一个**只监听本机**的 OpenAI 兼容网关，再由面板**生成一份配置**，
你在 设置 → 模型配置 →「从其他工具导入」里把它导入成**你自己的** provider（baseUrl 就指向这个网关）；
宿主发的每个请求都会落进网关，网关照旧做通道枚举与校验、pin/exclude、failover、账号池与冷却、流式空闲超时、思考档位映射。

```text
PI-Desktop ──POST http://127.0.0.1:41593/v1/chat/completions──▶ 本插件网关 ──▶ Cline Pass (api.cline.bot)
```

---

## 🚀 加载与首次使用

### 1 · 加载

插件页 → **Load development plugin** → 指向本目录（`D:\Pi\Chat\plugins\cline-pass`）。保存文件即热重载。
本插件申请 `agent.tool.register`（高危，需要你显式批准）、`background.service`、`ui.panel`、`notify`、`models.list`，
以及 `fs.read` + `fs.write`（面板「写入文件」用：`fs.read` 是 `pi.fs.requestDirectory()` 实际校验的那一条，`fs.write`
被 `root: "userSelected"` 限制在**你亲手选的那个目录**，代码只写 `models.json` 一个文件名）。
若之后改了 `permissions`，先移除再重新加载（开发插件的权限以首次批准为上限，宿主会拒绝热重载）。

### 2 · 打开面板

命令面板里 `Cline Pass：打开管理面板`（命令 id `cline-pass.open`），或插件页的面板。

### 3 · 给 key（密钥全部由本插件管，宿主侧不用填）

- 面板「账号池」里加**内联账号**（key 写进插件数据目录的 `config.json`）：可以放多个，轮转 + 失败冷却。
  表里每行都有**编辑**：改账号名 / 显示名 / 换 key（**key 留空 = 不改动**）/ 停用启用。
- 宿主侧**不用填密钥**：插件**不声明任何 provider**（`contributes.providers` 已删），模型选择器里不会再出现插件那一行；
  真正被使用的是你下一节导入出来的那个 provider —— 它在每个请求上带一个占位 bearer（`pi-desktop-no-auth`），
  插件把它当成「宿主没有 key」忽略，绝不会拿它去请求 Cline。
- 向前兼容：若哪天宿主真的发来一把 key（非占位串），插件仍会把它当 `host` 账号在当次请求里使用，不落盘。
- 没有「读环境变量」那种账号：宿主给插件进程的是**最小环境**（`PATH`/`TEMP`/`HOME` 一类 + `PI_PLUGIN_ID`），
  取不到你自己设的变量，所以这个来源已去掉（传 `source=env` 会被明确拒绝）。

### 4 · 接进模型选择器（生成配置 → 从其他工具导入）

插件**不声明任何 provider**，得把模型导入成**你自己的** provider —— 只有这种 provider 能在设置页里编辑、能勾
「可供 AI 自动调度」（子代理能不能用它，就看这一勾）：

1. 面板「模型与通道」→ **生成配置** → **写入文件**：第一次会弹系统目录选择器，选 `C:\Users\<你>\.pi\agent`
   （目录不存在就先建一个）。插件只往这个目录写一个 `models.json`，不读、不删别的文件。
   不想授权写盘就点「复制」，自己存成同一个路径 —— 这个路径是「从其他工具导入」会扫描的来源之一（`pi`）。
2. 设置 → 模型配置 → **从其他工具导入** → **扫描** → 勾选「Cline Pass（本地网关）」→ **导入所选**。
3. 导入后在那张模型卡里勾上 **「可供 AI 自动调度」**。
4. 之后调参数直接改设置页那张卡（理由见下一节）；`models.json` 留着或删掉都行（留着下次扫描还能看到）。

> [!TIP]
> 目录选择器是模态窗口，请在 30 秒内选完（宿主对一次面板调用只等 30 秒）。万一面板提示超时，**直接再点一次「写入文件」**
> —— 目录已经记住，这一次是秒写。插件重载后需要重新选一次目录。

> [!NOTE]
> 为什么要绕这一下：插件声明的 provider 行有两条硬限制 —— ①宿主只维护它认识的 7 个字段，`availableForSubagents`
> 会被**丢弃**（2026-10-13 对照实验：manifest 里写上它、同时把一个宿主必看的 `maxTokens` 改成 384001，
> 停用→启用后行确实被重写、对照值进去了，而这个字段 5 个模型**全缺**）；②插件行在设置页**没有编辑入口**。
> 所以插件模型永远进不了委派目录 —— 这也是本插件现在**干脆不声明 provider** 的原因；而**你自己的** provider 没有这两条限制。

### 5 · 摸通道

面板依次点 **Probe**（判定路由管线并从路由层错误里抓该模型的完整通道列表）→ **Validate**（逐通道 pin 一遍，
判定依据是响应自报的 `finalProvider`，不是 HTTP 200）→ 需要时 **Pin/Exclude**。

### 6 · 用起来

模型选择器里选 **baseUrl 是 `http://127.0.0.1:41593/v1` 的那个 provider**（也就是上一节导入出来的那个）下的模型。
注意别和自建的 `api.cline.bot` provider 混了 —— 它们的模型 id 可能一模一样（见下文「认准 baseUrl」）。

---

## 🧩 生成配置与生效路径

插件**不声明任何 provider**（`contributes.providers` 与 `provider.register` 权限都已删除），所以模型选择器里不会再有插件那一行。
面板里的模型参数写进插件数据目录的 `config.json`（`modelSettings`），再由一个面板动作把它们翻译成**你要导入的那份 JSON**：

- 面板「模型参数（写进生成的配置）」可改 `registered`（= 是否写进生成的配置）/ `contextWindow` / `maxTokens` /
  `supportsImages` / `thinkingLevels` / `defaultThinkingLevel`；保存只提交改动过的字段，**不需要重载插件**。
- 默认值取自 **models.dev**：`<安装目录>\resources\models.dev\api.json` 里 `cline-pass` provider 下的模型
  （窗口 `limit.context`、输出上限 `limit.output`、图片 `modalities.input`、档位 `reasoning_options`）。
  仓库里的 `tools/sync-catalog.mjs` 就是刷新这张表的脚本：默认读本机快照，`--remote` 直连 models.dev，不加 `--write` 只报告差异。
- 生成配置里写死的 `limit` 会被宿主当成**用户值**，models.dev 补全不会覆盖它。但 **`pi` 格式没有"自定义档位阶"字段**：
  0.20.1 的 `bindingFromPiModel` 只要看到 `reasoning: true` 就**硬编码** `thinkingLevels: ["off","low","medium","high"]` +
  默认 `medium`（`out/main/index.js:2238` 附近），所以导入后的档位是宿主通用那套，**不是**上面表里的 models.dev 梯子。
  要按 models.dev 的梯子来（例如 `deepseek-v4.1-flash` 应是 `off/low/high/max`），就在 设置 → 模型配置 那张模型卡里手改档位 ——
  那里可以改（`SettingsPage` 的档位 chips 会写回 `thinkingLevels` / `defaultThinkingLevel`）。
- 「宿主专有能力」（思考协议 / PDF / 自动调度 / 联网搜索 / 生图）插件写不进生成配置：导入之后到设置页里改，
  其中**「可供 AI 自动调度」就是 `availableForSubagents`**。
- **生成的模型 id 带 `cline-pass-local/` 前缀**（`cline-pass/deepseek-v4.1-flash` → `cline-pass-local/deepseek-v4.1-flash`）：
  这是故意的，原因见下面 WARNING 的「子代理侧更隐蔽」——撞的是模型 id，不是 provider 名字。网关两种拼写都认，旧配置照旧可用。

> [!IMPORTANT]
> **生效路径（实测）**：`importConfigPayload()` 从 `src/protocol.js` 的 `GATEWAY_BASE_URL` 取网关地址（`http://127.0.0.1:41593/v1`），
> 生成的 JSON 固定包含：`api: "chat_completions"`、`apiKey: "pi-desktop-no-auth"`（占位串，网关忽略它、改用你自己的账号池）、
> 每个模型一个 `limit`（窗口/输出）、`reasoning: true`、图片模型带 `input: ["text","image"]`。
> 导入器对**已存在**的 provider（判重规则：同 baseUrl + apiStyle，或同 vendorKey + apiStyle，且密钥一致）会**跳过**，
> 所以「生成配置 → 导入」主要用于**第一次**接上；之后调参数请直接改 设置 → 模型配置 里那张卡（它现在是你的 provider，能改）。

> [!WARNING]
> **认准 baseUrl（实测踩过）**：模型选择器按「provider + 模型」区分，同一个模型 id 可以挂在多个 provider 下。
> 2026-10-13 本机实测：`cline-pass/deepseek-v4.1-flash` 同时出现在**自建的 `api.cline.bot` provider**（`bc036988-…`）
> 与本插件网关的 provider 下，而日常会话走的是前者 —— 于是插件网关侧 0 会话、账本为空，pin / failover / 账号池 /
> 额度这些功能**看不到那部分流量**。想用上它们，就选 baseUrl 为 `http://127.0.0.1:41593/v1` 的那个 provider。
> **子代理侧更隐蔽（2026-10-13 实测，别踩）**：委派目录的 key 是 `<vendorKey>/<模型 id>`，而用户自建的 provider 的 `vendorKey`
> 都是 `custom`，于是**两个 provider 的同名模型会撞成同一个 key**。实测：`custom/cline-pass/deepseek-v4.1-flash` 被宿主判为可用，
> 但那一次子代理请求**根本没进网关**（网关 `historySize = 0`、账本没有新行、宿主日志里也没有）—— 它被直连 `api.cline.bot` 的那条接走了。
> 对照组：只在网关 provider 里存在的 `cline-pass/glm-5.3`（且未勾「可供 AI 自动调度」）被宿主**直接拒绝** ——
> `Model "custom/cline-pass/glm-5.3" is not available for delegation. Available: …` → 说明门禁确实生效，而撞名的那条是另一个 provider。
> 想让子代理只走网关：把旧直连 provider 里**同名**模型的「可供 AI 自动调度」取消勾选（或直接停用它），再勾上网关 provider 的模型；
> 否则子代理会悄悄走直连那条，账号池 / pin / failover / 账本全都看不到这部分流量。**插件侧的根治办法见下一节**：生成配置里的模型 id 带 `cline-pass-local/` 前缀，撞名就不存在了；上面这条「取消勾选」只是零代码的临时办法。

---

## 📊 用量账本

宿主不会告诉插件一次会话花了多少，网关能看到的是**每次响应最后那帧的 `usage`**（含 token 与成本明细），
于是每个请求落一行到 `<数据目录>\usage.jsonl`：

- 面板「用量」按 1 / 7 / 30 天或全部汇总：请求数、失败数、输入/输出 token、成本（只统计上游真给了成本的请求，
  `costKnown` 形如 `3/10`）、平均耗时，并给出按模型 / 按通道 / 按天分组与最近明细。
- 上游没给成本的请求显示「—」，不按单价估算。
- `cline_pass_usage` 工具给 agent 同一份数据（`days` / `limit` / `model`），`usageClear` 清空账本。

---

## 💳 官方额度（Cline 订阅窗口）

与本地账本并列的第二块：这个账号在**官方侧**用掉了多少。接口是 Cline 自己的
`GET {baseUrl}/users/me/plan/usage-limits`，返回
`{success, data:{limits:[{type:'five_hour'|'weekly'|'monthly', percentUsed, resetsAt}]}}`；
同一族还有 `GET /users/me`（profile）与 `GET /users/{id}/usages/daily?startDate=&endDate=`（按天用量）。
路径与形态对照 DSH `dsh-cline-pass` 0.2.5-p3 的 `lib/cline.js`（`USAGE_LIMITS_PATH` / `PROFILE_PATH` / `PLAN_PATH`）逐字核对；
卡片本身对照同一版本的 `lib/client.js` 里 `UsageCard` + `usageColor` + `countdown` 逐条复刻：

- **显示「已用」百分比**（`percentUsed` 取整并夹到 0..100），条长就是已用比例，配色沿用原版 `usageColor`：
  ≥90% 红、≥70% 橙、其余绿。窗口按 `five_hour` / `weekly` / `monthly` = 5 小时 / 本周 / 本月 排序，
  多出来的按上游 `type` 附在后面。
- **账号池一次只看一个账号**：标题是 `官方额度 · N 个账号`（单账号则是 `官方额度 · 账号 <名字>`），
  名字行给 `‹ 名字 [当前] 第 i / n 个 ›`；翻页纯本地 —— 一次读取已经把整个池读回来了，箭头不发请求。
  「当前」只在该账号是单选模式的 active 账号时出现（轮询模式下每个请求都在换，标了就是假话）。
- **`host` 账号不列在这里**（和「账号池」表一致）：它只在宿主真发来一把 key 时才存在，而那把 key 只活在当次请求
  的内存里 —— 面板这座桥拿不到它，列出来永远只能是一行「读不到」，所以直接不列；标题里的账号数也只数内联账号。
  真有一个账号读不到时，行内是一句短中文（`暂时读不到官方额度。密钥被官方拒绝了（HTTP 401）。` /
  `连不上官方接口。` / `这个账号现在没有密钥。` …），网关与上游的英文原文挂在 `title` 上（鼠标停一下能看全），
  灰字不上色；整个池读不到时只有一句 `暂时读不到官方额度。`，重试就是标题行那个「刷新」按钮，不再另给一个。
- **同一个 key 填在两个账号上时明说**：`duplicateNames()` 按真实 key 分组（key 本身不返回、不记日志），撞车的账号在翻页行显示掩码
  （`.quota-key`，和「账号池」是同一列信息）并补一句灰字「这个账号和另一个账号用的是同一个 key（同一个 Cline 账号），所以两边数字一样 ——
  到「账号池」把 key 改成各自的。」（有意偏差：DSH 原版既不显示掩码也不提示重复；少了这条，「名字对、数字不对」就变成一个谜。）
- **缺失值不编造**：官方没给某个窗口的 `percentUsed` 就显示 `—`、进度条不写 `aria-valuenow`、
  提示条写「官方没有返回这一档的百分比」；解析层也不把缺失补成 0（`Number(null)` 就是 0，这条踩过）。
  原版假设这个值一定有，这里沿用它「一定有」的显示路径，缺值时降级显示而不是撒谎。
- 倒计时按原版算法**从 `resetsAt` 现算**（`3 天 2 小时后重置` / `5 小时 10 分钟后重置` / `42 分钟后重置`），
  不认上游算好的文本，省得两边对不上。
- 两个口径不要混：本地账本只统计**经过本网关**的请求，官方额度包含该账号在别处用掉的量，对不上是正常的。
- `cline_pass_quota` 工具给 agent 同一份数据（`refresh` 绕过 60 秒缓存）；`status` 里也带缓存里的最近一次读数。

---

## 🔒 数据与隐私

| 内容 | 位置 |
| --- | --- |
| 配置 / 账号 / pin | `%USERPROFILE%\.pi-desktop\plugins\data\io.github.duya07.cline-pass\config.json`（写入 0600；Windows 上权限位可能被忽略，文件仍在用户目录内） |
| 插件日志 | 同目录 `gateway.log`（上限 512 KB，超出即清空重写），同时打到 stderr，宿主 `plugin.log` 里带 `[cline-pass]` 前缀 |
| 用量账本 | 同目录 `usage.jsonl`（超过 2 MB 轮转为 `usage.1.jsonl`）：模型/通道/账号/token/成本/耗时，不含任何请求正文 |
| manifest 备份 | 同目录 `manifest.backup.json`（面板改参数前的上一版 manifest） |

- 内联账号的 key 只写进插件数据目录的 `config.json`（宿主看不到）；宿主若发来一把真实 bearer，只在当次请求的内存里用、不写盘。
  面板与工具只回显掩码提示（`maskKey`），日志不打印 key。
- 上游流量只发往面板里配置的 `baseUrl`（默认 `https://api.cline.bot/api/v1`）。传输层用 Node 全局 `fetch`；
  宿主对 `pi.net.*` 的出口域名白名单不在这条路径上。
- 请求历史只记模型 / 命中通道 / 账号名 / 状态 / 耗时 / token / 备注。

---

## 🔌 端口

- `41593` 现在是 `src/protocol.js` 里的单一常量 `GATEWAY_PORT` / `GATEWAY_BASE_URL`（原先写在 manifest 的 provider baseUrl 里；provider 声明删掉后就挪到代码里了）；
  所以**改端口只改这一个常量**（网关监听、生成配置里的 baseUrl、面板显示都跟着它走）。
- 端口被占用时：插件不会静默降级——日志里 `gateway did not start`，面板顶部显示启动错误，并弹一次通知。
- 网关只监听 `127.0.0.1`，且校验 `Host` 头：非本机来源直接 403。

---

## 🤖 Agent 工具（10 个）

`cline_pass_status`（状态：端口/账号池冷却/pin/并发/最近一次额度读数）、`cline_pass_models`（模型参数与已探测通道）、
`cline_pass_probe`、`cline_pass_validate`、`cline_pass_test`（按 pin/exclude 真发一次并给轨迹）、
`cline_pass_pin`（写/清 pin）、`cline_pass_accounts`（list/add/update/remove/mode/test/resetCooldowns；`update` 支持改名 `renameTo`、改显示名、换 key、启停）、
`cline_pass_history`（最近请求）、`cline_pass_usage`（用量账本汇总）、`cline_pass_quota`（官方额度窗口）。

---

## 🖥️ 面板动作

宿主的面板桥只转发 `skill.*` 通道，所以面板统一走 `skill.setEnabled` + `payload.action`（与官方 `pi.todo` 同形）：
`status` `probe` `validate` `test` `pin` `clearPin` `accounts` `history` `setConfig` `reloadConfig` `restartGateway`
`setModel`（写模型参数到插件配置，不再碰 manifest）`generateConfig`（生成要导入的 JSON，不落盘）`writeConfig`（把它写到用户选的目录里的 `models.json`）`usage` `usageClear` `quota`。
`status` 除网关状态外还带 `host`（宿主清单比对结果，即「宿主侧同步状态」那一行的原始数据）。
宿主对**一次面板调用**只等 30 秒（`PLUGIN_PANEL_TIMEOUT_MS`），所以面板侧的超时是 25 秒；probe/validate/test 这类
重活给的是同一预算，超时会说清原因并建议改用 agent 工具（110 秒）。插件进程抛错时宿主可能不回传异常，面板因此自带超时与错误提示。

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

## 🛠️ 本轮修复（对照文档/宿主实现后改动）

1. **`contributes.services[].label` 由 `{en, zh-CN}` 改为字符串**：宿主只校验 `service.id`，渲染时把 `label` 当文本，
   对象直接进 React children → 整页崩（minified error #31）。这是加载时把应用弄崩的那一处。
2. **`contributes.providers[].category` / `.description` 由对象改为字符串**：校验器两种形态都收，但渲染侧
   `providerDisplayName` 是直接当 React child 用的，而 21 个已装/内置 manifest 里没有第二个插件声明过 provider——
   对象形态在真机上从未被走过，不再赌它。
3. **去掉读环境变量的账号来源**：插件进程是最小环境，这个功能本来就不可能工作。
4. **面板与工具加上时间预算**：面板原先写 90s/300s，远超宿主 30 秒的面板上限。
5. **补 `appearance:changed` 订阅**：换主题时无需重开面板。
6. **非流式一律可回退流式拼装**：上游 `api.cline.bot` 对 `stream:false` 回 500 `{"error":"empty response content"}`（真机实测），
   `engine.collectCompletion()` 把同一条请求改成流式并拼回一个 JSON 响应，`reasoning` / `tool_calls` / `usage` / `provider` 都保留。
7. **日志噪声**：宿主把插件 stderr 一律记成 `level:"error"`，所以 `createLogger` 只在失败时写 stderr，进度只进 `gateway.log`。
8. **模型参数表按 Cline 官方目录重写**：14 个 `cline-pass/*` 的上下文 / 输出 / 图片 / 档位逐条对照；档位按模型收敛，
   `qwen3.8-max` 标 `fallback`（官方目录里这个条目用的就是它自己的兜底常量）。
9. **面板即时反馈**：动作点击后同一个 tick 里锁按钮 + 顶部 busy 条 + 秒数计时，任何终局路径都会解锁并留一行日志。
10. **`modelSettings` + manifest 回写**：参数 / 注册项写进 `config.json`，再回写本插件的 `manifest.json`（写前备份到数据目录）。
11. **用量账本**：每个请求落一行 `usage.jsonl`，面板与 `cline_pass_usage` 工具给出窗口汇总与明细。
12. **新增 `cline_pass_usage` 工具并锁住声明**：`manifest.json` 的 `contributes.agentTools` 与 `main.js` 的 `TOOL_NAMES`
    有守卫测试逐项对齐 —— 这条正是测试先抓出来的（manifest 漏声明时宿主不会暴露该工具）。
13. **官方额度**：移植 DSH 的 `usage-limits` 读取（`src/cline.js` + `src/quota.js` + 网关 `ops.quota` + 面板卡片 + `cline_pass_quota`），
    并把「缺失百分比」这条规则贯穿三层（解析 / 归一化 / 渲染）：三处都先判 `null`/`""` 再转数字，因为 `Number(null)` 是 0，
    否则缺值的窗口会被画成「剩余 0%」并标红。回归测试先红后绿（测试、渲染断言各加一条）。
14. **额度卡片按原版重做（用户截图纠正后）**：第一版卡片自作主张显示「剩余」、错误标红、账号叠着排；
    实际原版（`dsh-cline-pass/lib/client.js` 的 `UsageCard` + `usageColor` + `countdown`）是
    **显示已用 %**（≥90 红 / ≥70 橙 / 其余绿）、账号池 `‹ 名字 [当前] 第 i / n 个 ›` 一次一个、读不到用**灰字**。
    已整块复刻（含 `已用` 的 aria 与 tooltip、倒计时从 `resetsAt` 现算、单账号不给箭头），
    并新增 53 条渲染断言（`test/render-quota.cjs`）锁住这套口径，随后又按独立评审的原版对照修掉 6 处偏差。
15. **重复 key 检测（真机踩到）**：两个内联账号填了同一个 key（掩码逐字相同、weekly `resetsAt` 只差 250 ms）时，
    面板会把同一个账号的额度显示在两个名字下 —— 用户就是拿这个来报「额度也不对」的。现在
    `src/config.js` 的 `duplicateNames()` 按**真实 key** 分组（key 永不返回、永不记日志），`ops.quota` 与「账号池」数据都带
    `duplicate` 布尔（「账号池」里撞车的行会挂一个「同一个 key」小标）；额度卡的翻页行显示掩码，撞车时补一句灰字说明。不是解析错，也不是语义错。
16. **账号池可编辑、`host` 不再占一行**：`update` 现在支持改名（`renameTo`：查重、拒绝改 `host`、single 模式的 active 账号跟着改）；
    面板每行加「编辑」，把该账号载入上方表单（账号名 / 显示名 / 换 key，**key 留空 = 不改动**），按钮变「保存」并出现「取消」。
    `host` 那行不再列在表里 —— 它的 key 只在请求内存里，读不到也改不了，留着纯噪音；改由顶部提示说明它还在不在。
    报头也从「账号 N」（含 host）改成「内联账号 N + host」，与表里一致。
17. **额度卡也过滤 `host`、错误只说中文**（用户第二次纠正：「你这里还留着呢 不全面一点」）：上一轮只把 host 从「账号池」表里拿掉了，
    额度卡还把它当第 1 / 3 个账号列着，后面拖着一长串英文。现在 `ops.quota` 的每行都带 `source`（网关两条返回路径 + `quota.js` 透传），
    渲染层 `quotaAccounts()` 过滤掉 `host`（标题只数内联账号）、`quotaHiddenHosts()` 让「只有 host」和「一个账号都没有」说不同的话、
    `quotaErrorText()` 把网关/上游的英文压成一句短中文（原文留在 `title`）。渲染断言 53 → 63 条，网关测试补 `source` 断言（45/45）。
    真机核对（拿插件自己的网关对着真实数据目录跑一次 `ops.quota({ refresh: true })`）：3 行、host 行标 `source:"host"`、
    面板会只列 2 个内联账号。顺带确认用户在面板里改 key 生效了：两行掩码已不同（掩码只回前 6 + 后 4 位，形如 `sk_aaa***1111`），`duplicate:false`，
    读数各自独立（21/36/18% 与 0/100/84%）。

18. **整条 provider 从模型选择器里消失（真机+宿主代码定位）**：用户截图 `Cline Pass（本地网关）` 那一行挂着「尚未设置 API 密钥」，
    而模型列表里根本选不到。根因不是面板也不是网关照，而是**宿主的选择器门槛**：
    `SettingsPage` 的徽章条件是 `!hasSecret && authKind !== "none"`，模型选择器（`ComposerPermissionPicker` / `listReadyPluginModels`）
    只列 `enabled && (hasSecret || authKind === "none")` 的 provider —— 插件把 key 存在自己的 `config.json` 里、宿主 `secret_ref` 永远是 NULL，
    于是 5 个模型虽然已经落进 `providers.config_json`，却整条被过滤掉。修法：provider 声明改成 `authKind: "none"`，
    同时插件把宿主发来的占位 bearer（`pi-desktop-no-auth`）当成「没有 key」忽略，不再拿它去请求 Cline。
    测试先红后绿（回退 `keyFor` 那一行时该用例报 `actual: 200, expected: 502`，证明它真的在守这条路径）。
19. **模型卡按宿主「模型设置」页对齐，并说清哪些字段插件根本声明不了**：官方那屏的 13 个字段里，
    **插件 provider 只有 7 个会被 host-core 落库**（`id` / `name`→`alias` / `contextWindow` / `maxTokens` / `supportsImages` / `thinkingLevels` / `defaultThinkingLevel`）——
    实测宿主库里我们这行的 `config_json.models[0]` 恰好就是这 7 个键，且 `name` 被改写成 `alias`。
    所以面板模型卡补齐了官方那套交互（上下文窗口预设 `128k/256k/312k/500k/1M`、最大输出预设 `4k/8k/16k/32k/128k`、
    7 个思考等级 chips、默认档位下拉含 `omit`）、并把 `thinkingProtocol` / `supportsDocuments` / `availableForSubagents` /
    `nativeWebSearch` / 生图这些**宿主专有**字段放成只读说明，不给假开关。
20. **模型卡按官方那屏重做**（前端由 Kimi K3 实现，我复核）：单列「左标签 + 右控件」；上下文窗口与最大输出各配一套预设 chips
    （`128k/256k/312k/500k/1M`、`4k/8k/16k/32k/128k`，点 chip 填值并高亮）；7 个思考等级做成 chips；新增「显示名（别名）」；
    默认档位下拉补 `omit`；宿主专有的 5 项（思考协议 / PDF / 自动调度 / 联网搜索 / 生图）单独成块且**只读**。
    - 用户报的「默认档位点不开」根因：`refreshLevelChoices()` 在卡片挂进 DOM **之前**就从**卡片根节点**查复选框 → 查到 0 个 →
      选项为空且 `disabled = true`。改成从本地 `.levels` 容器读，并用新断言器回归锁死。
    - **Kimi 的实现里有两处是死的，我在后端补上了**：`patch.name`（别名）与 `defaultThinkingLevel: "omit"` 原本会被
      `sanitizeSettings` 丢掉（白名单只认那几个键，`effectiveModels` 还要求默认档位必须在 `thinkingLevels` 里）——
      现在两者都保留（别名 trim + 截断 60 字符，`published.name` 供对照），并补了单测（先红后绿）。
    - 新增 `test/render-model-card.cjs`：60 条断言跑在假 DOM 上（从 `renderer/index.html` 现抽模型卡整块），
      并对实现副本注入 **6 处故障 —— 全部转红**（候选改回根节点查找 → 20 条失败；chip 不再高亮；`off` 校验被跳过；别名写成 `patch.alias` …），
      证明断言不空转。
21. **命名规范化与仓库收尾**：插件目录 `pi.cline-pass` → `cline-pass`（`git mv`；插件 id 与数据目录仍走 `io.github.duya07.cline-pass`，未变），
    全目录 `pi.cline-pass` 引用清零（13 个文件 20 处：JSDoc 模块名、stderr 前缀、health 载荷的 `plugin` 值、工具描述、README 路径）；
    根 README 把 `pi.transcript-doctor` 标为**已废弃**（宿主 v0.19.1 已修复）、`cline-pass` 行与徽章换成新目录名、TIP 里
    「宿主侧填密钥」改成 `authKind: "none"` 的正确说法；GitHub 仓库描述补了一句。
22. **账号「测试」按钮的假失败（用户真机报的 `empty response content`）**：上游 `api.cline.bot` 拒绝一切**非流式**请求
    （HTTP 500 + `empty response content`，同一个请求改流式发就正常），而这条「非流式被拒 → 改流式拼装」的回退原本只内联在
    `attemptChat` 里；面板的「测试」按钮（`testAccount`）与 `probe` 直接调 `chatCompletion`，于是拿到一次假红。
    现在抽出 `completionWithStreamFallback({ baseURL, apiKey, body, signal, timeoutMs })`（返回 `{ result, payload, failed, note }`），
    三条路径共用；`harvest` **有意不动** —— 它要的正是 `__probe__` 那次 400 的错误正文（通道列表），走回退反而会把列表弄丢。
23. **独立评审又抓到两条真缺陷（同一处改动，都已修）**：① `probe` 的失败分支漏了可选链：`failed` 现在也可能只由「非 2xx」成立，
    而空体 / 非 JSON 的失败体经 `unwrapEnvelope(null)` 会变成 `null`，`payload.error` 直接 TypeError（前置代理的 502/504 HTML 页正是这情形），
    面板只会看到一条没有理由的失败；② 拼装体把 **planner** 的路由（`choices[0].delta.provider_metadata.gateway.routing.finalProvider`）
    平铺进了**根级 `provider`**，而根级 `provider` 恰恰是 **direct** 的标记 —— 真机上每次调用都走回退，于是 planner 被报成 direct、
    `pinnable` 与通道落错桶。修法：拼装时按管线还原形状（planner 保留嵌套 `provider_metadata`，只有 direct 才写根级 `provider`），
    失败文本改成 `errorText(payload?.error) || result.text.slice(0, 200) || 「HTTP <status>」` 三级兜底（同一个坑也补在「测试」按钮上）。
    新增 4 条用例，其中 3 条先红；「测试」按钮那条另用变异验证（去掉兜底 → `actual: '' expected: 'HTTP 500'`）。
24. **面板新增「宿主侧同步状态」行 —— 让「选择器里看不到模型」不再靠猜**：宿主是不是真的把本插件的模型同步进了它自己的库，
    以前在面板里完全看不出来。现在面板 `status` 载荷多一个 `host = { ok, synced, total, missing[], error }`，
    来源是 `pi.models.list()`：宿主只返回「已启用且就绪」的 provider 的模型，所以「0 条」只能说「不在选择器里」，
    不能说清是没同步还是没就绪 —— 文案因此不猜原因。为此新增权限 `models.list`（宿主白名单里确有这个名字），
    而**扩大 `permissions` 是热重载的唯一例外**：宿主必须显式重新加载才会授予，所以重载前这行显示灰字「读不到宿主模型清单」。
    面板还区分了「一条模型都没注册」（你自己的选择，别怪宿主）与「注册了但宿主没同步」两种状态。
25. **模型卡的复选框不再是蓝色大方块**：根因是全局 `input{ min-height:30px; padding:6px 9px; background:var(--card); border:1px solid var(--line) }`
    把 16px 的复选框撑成了带边框的大方块。修法是给 `input[type="checkbox"]` 一条更具体的选择器，把尺寸/内边距/背景/边框按回原生
    （保留 `accent-color`、`:focus-visible` 轮廓、`:disabled` 透明度），并把模型卡的竖向节奏、hint 行高、chips 尺寸对齐。
    **复核时抓到同一次编辑的连带损伤**：`.quota-pos` / `.quota-key` / `.field-control input[type=text|number]{width:100%}`
    这三条**与复选框无关**的规则被一起删掉了（额度翻页行和模型卡的别名/数值输入都靠它们），已原样恢复；
    判据是**行集合比对**而不是 `git diff` —— 后者会把新插入块前后的一行标成 delete+add 的配对假象，只看 diff 会误判。
    脚本块除新增的 `renderHostSync` 外逐字节未变，用**规范化行尾后**的哈希核对（`git show` 给 LF、工作树是 CRLF，直接比会假报不一致）。
26. **变体 ①：插件不再自动注册模型（用户拍板）**：两条硬限制逼出来的（见上文第 4 步 NOTE）——插件 provider 拿不到
    `availableForSubagents`，也无法在设置页编辑。改法：`contributes.providers[0].models` 置空（空 `models` 只在
    `(authKind ?? "api_key") === "api_key"` 且有 `baseUrl` 时合法，所以同时删掉 `authKind: "none"`）；面板新增 `generateConfig`
    动作产出要导入的 JSON（`api: "chat_completions"`、`apiKey: "pi-desktop-no-auth"`、每模型一个 `limit`）；`setModel` 只写
    `config.json`、**不再重写 manifest**，因此改参数不再需要重载插件；`registered` 的语义变成"写进生成的配置"。
27. **数值来源换成 models.dev（用户拍板）**：`src/catalog.js` 的 14 条按 PI-Desktop 自带的 `resources/models.dev/api.json` 重算
    （窗口 `limit.context` / 输出 `limit.output` / 图片 `modalities.input` / 档位 `reasoning_options`，`none` 折进宿主的 `off`），13 条变化 ——
    例如 `deepseek-v4.1-flash` 输出上限 943718 → **384000**、`glm-5.3` 与 `kimi-k3` → **131072**、`deepseek-v4-pro` 档位
    `high/xhigh` → **`high/max`**；`qwen3.8-max` 原来被标"兜底默认值"，models.dev 里其实有它 → 标记去掉。
    刷新脚本 `tools/sync-catalog.mjs`（默认读本机快照，`--remote` 走网络，`--write` 才落盘，幂等）。落地时踩过一次自己写的坑：
    合并时 `...rest` 把 current 的派生字段又铺回去，报告"1 处变化"却写回旧值 —— 已修。
28. **面板补齐（前端由 Kimi K3 实现，我复核并补文案）**：新增「生成配置（导入到模型配置）」卡片（按钮 / 只读 JSON / 复制 / 四步说明）；
    模型卡与「宿主侧同步状态」行全面改文案（旧措辞会骗人：`注册进宿主模型选择器` → `写进生成的配置`；宿主同步行改成「已导入 N/M」）；
    保存模型后的提示也从"manifest 已写入"改成"重新生成配置再导入"。新增断言器 `test/render-import-config.cjs`（现 36 条）。
29. **「写入文件」：插件唯一的写盘动作（用户要求"只允许写这一条路径"）**：用宿主的 `root: "userSelected"` 机制 ——
    第一次点会弹系统目录选择器（选 `~/.pi/agent`），句柄**只活在插件进程内**；`pi.fs.requestDirectory()` 实际校验的是
    **`fs.read`** 权限（在已装宿主包里核实过），所以 manifest 同时声明 `fs.read`（**不给任何 `fs.read` 规则**，不放开任何可读路径）
    与 `fs.write`；`pi.fs.writeText(pathFromRoot, …)` 收的是**相对 root 的路径**，代码因此只传字面量 `models.json`。
    取消选择器 → 一个文件都不写；进程内记住目录，第二次是秒写；**0 个模型时直接拒绝**（不用空清单覆盖用户已有的文件）。
    面板上还有一句提示：选择器是模态窗口、请在 30 秒内选完，超时就再点一次（秒写）。测试从 71 条加到 **75 条**。
30. **干脆不声明 provider（用户："第一个这个可以不要喽"）**：`contributes.providers` 与 `provider.register` 权限一起删除；
    端口/地址从 manifest 挪到 `src/protocol.js` 的单一常量（`GATEWAY_PORT` / `GATEWAY_BASE_URL`），
    `manifestPort()` 与 `providerBaseUrl()` 一并删除，`src/` 里再没有任何地方读 `contributes.providers`。
    宿主会在下一次同步（停用→启用/重启）删掉那行（对账逻辑会枚举 `owner_plugin_id` 的行）。
    另外查明并写进上一节：`pi` 导入格式**硬编码**思考档位（`reasoning: true` → `off/low/medium/high`），
    所以 models.dev 的梯子只能在设置页里手改 —— 这不是"没对齐"，是导入格式的限制。

---

## ✅ 自测

```powershell
cd D:\Pi\Chat\plugins\cline-pass
node --test test/gateway.test.mjs      # Windows 下必须给文件路径；55 项
node test/render-quota.cjs             # 面板额度卡片：63 条断言，不需要浏览器
node test/render-model-card.cjs        # 面板模型参数卡：60 条断言（含「默认档位点不开」回归）
node test/render-import-config.cjs     # 面板「生成配置」卡片：40 条断言（生成 / 复制 / 写入文件 / 模型 id 前缀说明）
node test/render-host-sync.cjs         # 面板宿主同步行：25 条断言（六种状态）
node test/host-sync.cjs                # 宿主清单比对 + 写入文件（pi.models.list / pi.fs 桩）：76 条断言
node test/panel-wiring.cjs             # 面板接线：脚本要的 id/class 是否都还在
```

覆盖：manifest↔代码一致性（工具 / 面板动作逐项对齐）、**清单形态守卫（`{en, zh-CN}` 只允许出现在宿主会解析 i18n 的位置）**、
**面板/工具预算不越宿主上限**、pin 两种拼装的写入与解析、模型清单与外机 403、流式 SSE、非流式 JSON、
跨账号 failover 与冷却落点、pin 注入上游、思考档位映射与**按模型收敛**、无可用账号时的 502、probe 抓通道、validate 逐通道、
test 走 pin 链、账号 CRUD 不泄漏密钥、端口/状态一致性、
**生成配置（默认 5 个进配置 / 覆盖生效与越界丢弃 / 形状守卫 / 只含勾选模型 / 不碰 manifest / `apiKey` 是占位串）**、
**用量账本（窗口过滤、按模型·通道·天分组、坏行容错、清空、`extractUsage` 的多种成本拼写）**、
**官方额度（按账号读取与 60 秒缓存、`refresh` 绕过、401/500 当数据返回、空窗口列表不是错误、缺百分比保持未知）**、
**接线冒烟（临时网关 start → `/v1/models` → `state` → `usage` → 真实请求落账 → stop，用来抓漏 require 这类只在运行期暴露的错）**。
新增覆盖：**宿主清单比对（`pi.models.list` 桩：缺权限 / 抛错 / 返回非数组 / key 双前缀 / 混入别家模型）**、
**面板「宿主侧同步状态」行的六种渲染状态**、**probe 在「非流式被拒 → 流式拼装」下的管线判定（planner 不许被平铺成 direct）**、
**非 2xx 无 body 时的错误文本（不许抛 TypeError、不许留空）**。
上游由本机 mock 顶替，不需要真 key、不产生真实流量。

---

## 🔄 与 DSH 版的差异

|  | DSH | 这里 |
| --- | --- | --- |
| 接法 | LLM adapter 直接挂进请求链 | 声明 provider → 本机网关（`src/gateway.js`）承载同一条请求路径 |
| 思考档位 | DSH 词表 | PI 词表（`off/minimal/low/medium/high/xhigh/max`）；宿主发 `reasoning_effort`，`off` → 删掉该字段 |
| 密钥 | DSH 配置 | 插件数据目录 `config.json`（内联账号，可多个轮转）；provider 声明 `authKind: "none"`，宿主侧不填密钥 |
| 面板桥 | DSH 面板通道 | `skill.setEnabled` + `payload.action` |
| 官方额度 | 面板直接读 | 同一接口、同一显示口径（已用 % + `usageColor` 三档 + ‹ › 翻页 + 灰字错误），多一层按账号逐读与 60 秒缓存，缺百分比降级显示而不是补 0 |

`src/protocol.js`、`src/engine.js`、`src/catalog.js` 与账号池（`src/config.js`）按 DSH 0.2.5-p3 的 `lib/*.js` 逐字对照改写为 CommonJS。

---

## 🧪 验证状态

- 已验证（真机）：插件在 PI-Desktop 里加载并持续使用；`development.plugin.reloaded` 多次 `ok:true`、网关 `health` 正常；
  真实请求走通（非流式 `200`、`provider=deepseek`、`reasoning` 保留、`usage` 有值）；
  源码 10 个 JS + `main.js` + 6 个测试脚本过 `node --check`；`node --test test/gateway.test.mjs` **53/53**；
  `node test/host-sync.cjs` 33 条（`pi.models.list` 桩：全同步 / 空清单 / 混入别家模型 / key 双前缀 / 抛错 / 缺 API / 非数组）；
  `node test/panel-wiring.cjs` 通过（57 个 id、全部 class 有样式、`<style>` 花括号平衡、v2 chrome meta 与标题栏变量还在）；
  渲染层 63 条离线断言（`node test/render-quota.cjs`：从 `renderer/index.html` 现抽脚本、喂假 DOM 跑额度卡片，
  口径逐条对照 DSH 原版 `UsageCard`）+ 模型卡 60 条（`node test/render-model-card.cjs`）+ 宿主同步行 25 条
  （`node test/render-host-sync.cjs`：全同步 / 部分同步 / 未同步 / 一条都没注册 / 读不到 / 缺字段 六种状态的文案与类名）全过；
  `PluginCheck` 无 error（1 条 warning：`provider.register` / `agent.tool.register` 属高危权限，需你在加载时批准）；
  清单字段形态与宿主限额按 0.19.1 随应用发布的开发说明 + 宿主实现 + 21 个已装/内置 manifest 逐项对照。
- 已验证（宿主库只读核对）：插件 provider 行由**宿主核心在启动 / 插件安装启用时**同步写入，开发热重载**不**刷新它
  （见上文「生效路径」；证据：连续 4 次 `ok:true` 热重载后该行 `updated_at` 未变）。
- 已验证（真机）：**官方额度的读取**——插件自己的 `gateway.log` 有 `quota read {"accounts":3,"ok":2}`（08:06Z），2 个内联账号都读到、
  host 那行没有 key 读不到；`cline_pass_quota` 工具随宿主重启后注册。本次「额度卡过滤 host」用插件自己的网关对着真实数据目录跑了一次
  `ops.quota({ refresh: true })`（临时端口，不碰 41593）：3 行返回、host 行带 `source:"host"`、面板的过滤结果正是 2 个内联账号
  （两个内联账号的数字各自独立：21/36/18% 与 0/100/84%）。面板的**编辑**路径也因此确认跑通 ——
  把其中一个账号的 key 换成自己的之后，两行掩码不同、`duplicate:false`，读数各自独立；这是本次实跑 `ops.quota` 看到的，不是推断。
- 未在真机上点过（仍然）：额度卡本次改动的**面板侧呈现**（重开面板 + 刷新后应只列 2 个内联账号、标题 `官方额度 · 2 个账号`）——
  数据路径已实跑核对，渲染侧由 63 条离线断言覆盖，剩下只是打开看一眼；`ops.setModel` 真正改写 manifest 的那条路径在测试里
  刻意用了与官方值相同的 no-op 写入（避免测试改写随包发布的 manifest），要实机保存一次才算跑过；
  账本 2 MB 轮转只断言了常量。
- 本轮已验证（真机数据 + 宿主代码定位）：宿主那行 `plugin:io.github.duya07.cline-pass:cline-pass` 的 `auth_kind` 已经是 `none`、
  `created_at = updated_at`（= 你 17:47 重新加载插件那一刻），5 个模型与档位齐全 —— 「模型选择器里看不到」在宿主侧已经解决，
  之前那张挂着「尚未设置 API 密钥」的截图是**旧渲染**（徽章条件是 `!hasSecret && authKind !== "none"`，行已改成 `none` 就不会再显示）。
- 本轮新增（真机待看一眼）：面板的**宿主侧同步状态行**（第 24 条）。它读 `pi.models.list()`，而 `models.list` 属于**扩大 `permissions`**——
  开发说明写明热重载不会授予你没批准过的权限，必须**显式重新加载**插件。所以在你重新加载之前，这行会显示灰字
  「读不到宿主模型清单：…」；重新加载之后应显示「宿主模型已同步：5/5 已注册，模型选择器里可见」。这两种真机状态都还没亲眼看过。
- 本轮真机观察到（权限门槛确实生效，实测）：插件目录里**任何一次保存**都会让宿主尝试热重载，而因为 manifest 多要了 `models.list`，
  宿主**拒绝**了这次重载 —— `logs\app\plugin.log` 里连着一串 `development.plugin.reloaded ok:false` 与
  `PERMISSION_DENIED: manifest now requests models.list; reload it from the Plugins page to review`（18:31–18:32 本地，多次）。
  **旧实例没有被拆掉**：`http://127.0.0.1:41593/v1/models` 仍然 `HTTP 200`（14 个目录模型），也就是这段等待期里网关照常服务、
  只是新代码尚未生效；在插件页重新加载一次即可全部生效。对照证据：另一个插件 `cn.star.skill-learning` 的
  `plugin.api models.list ok:true count:63` 说明这个权限名与 `pi.models.list()` 在真机上是通的。
- 本轮新增（变体 ①，2026-10-13 深夜）：插件**不再声明任何 provider**（`contributes.providers` 与 `provider.register` 权限都删了），模型参数只写插件配置；面板新增「生成配置 / 写入文件」，导出给 PI-Desktop「从其他工具导入」用 —— 原因与实测证据见上文第 4 步的 NOTE。
  离线验证：`node --test test/gateway.test.mjs` **54/54**、`node test/host-sync.cjs` 75、`node test/render-import-config.cjs` 36、
  `node test/render-host-sync.cjs` 25、`node test/render-model-card.cjs` 60、`node test/render-quota.cjs` 63、`node test/panel-wiring.cjs` OK；
  `node --check` 全部 JS 与测试脚本 0 失败；`PluginCheck` 通过（22 文件；warning 列 `agent.tool.register` 与 `fs.write`）。
  **真机进度（2026-10-13 深夜复核，只读核对宿主库）**：用户已按流程导入成功 —— 他自己的 provider
  `59f36d16-…`（`base_url = http://127.0.0.1:41593/v1`、`api_style = chat_completions`、
  `auth_kind = api_key_and_base_url`、5 个模型）；重载后**插件那一行已从宿主库里消失**（`providers` 表里再无 `owner_plugin_id` 非空的行）
  —— 删掉 `contributes.providers` 之后宿主确实回收了旧行，选择器里不会再出现插件那一行。
  委派目录（`<vendor_key>/<modelId>`）里已出现 `custom/cline-pass/minimax-m3`（勾了「可供 AI 自动调度」1/5）。
  已实测（2026-10-14 01:0x）：面板「写入文件」跑通（`fs.requestDirectory ok:true path="<home>\\.pi\\agent"` + `fs.writeText ok:true`），
  磁盘文件与 `importConfigPayload()` **逐字节一致**；用户删掉旧 provider 后重新导入，新 id `2f3e36b3-…`（5 个模型，baseUrl 仍指网关）。
  档位仍是宿主通用那套（用户未手改）；勾选仍只有 `minimax-m3` 一个。
- 本轮新增（数值来源换成 models.dev）：`src/catalog.js` 14 条按 models.dev 重算（13 条变化），刷新脚本 `tools/sync-catalog.mjs`，幂等复跑 0 变化。
- 本轮新增（2026-10-14 凌晨，用户拍板）：**生成配置里的模型 id 改带 `cline-pass-local/` 前缀**，网关再做映射 —— 为了消掉
  委派目录的 key 撞名（见上文 WARNING「子代理侧更隐蔽」）。用户当时的原话是「你确定撞的是模型 id 而不是名字？」——
  确实是模型 id：委派 key 是 `<vendorKey>/<模型 id>`，用户自建 provider 的 vendorKey 全是 `custom`，provider 显示名根本不进 key，
  所以「改个 provider 名字」没有用（而且默认名本来就叫「Cline Pass（本地网关）」，早就区分开了，照样撞）。
  改动：`src/models.js` 新增 `IMPORT_MODEL_PREFIX` / `importModelId()` / `unimportModelId()`，`importConfigPayload()` 用前缀拼 id；
  `src/gateway.js` 的 `normalizeModelId()` 先剥前缀再查目录，**三种拼写都收**（`cline-pass-local/x`、`cline-pass/x`、宿主的 `x`），
  落不到任何模型时原样透传（错模型应答比上游报错更糟）。面板「生成配置」卡片与「模型参数」卡片都加了说明（用户要求：别让人以为改了名就路由不回去）。
  TDD 顺序：先写会红的用例（网关把 `cline-pass-local/…` 原样转发 → `actual: 'cline-pass-local/deepseek-v4.1-flash'`），再改实现。
  离线验证：`gateway` **55/55**（+1 条：三种拼写 + pin 跟随 + 未知 id 透传）、`host-sync` **76**（+1 条：前缀契约）、
  `render-import-config` **40**（+4 条：前缀说明文案）、`render-host-sync` 25、`render-model-card` 60、`render-quota` 63、
  `panel-wiring` OK、`node --check` 0 失败。
  **用户侧代价**：旧 provider 里的 id 是旧拼写，要享受前缀必须**删掉重新导入一次**（导入器判重会跳过同名 provider）。

---

## 📦 来源

行为移植自 DSH 插件 `dsh-cline-pass` 0.2.5-p3（其 `package.json` 声明 MIT）。本插件目录为改编产物。
