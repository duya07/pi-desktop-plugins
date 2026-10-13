# 🔌 Cline Pass 本地网关 · PI-Desktop 插件

[![version: 1.0.0](https://img.shields.io/badge/version-1.0.0-blue)](./manifest.json) [![license: MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/duya07/pi-desktop-plugins/blob/main/LICENSE) [![PI-Desktop](https://img.shields.io/badge/PI--Desktop-0.19.1-compatible-lightgrey)](https://github.com/vastsa/PI-Desktop) [![gateway: 127.0.0.1:41593](https://img.shields.io/badge/gateway-127.0.0.1:41593-orange)](#端口)

> 把 DSH 的 `dsh-cline-pass` 0.2.5-p3 移植到 PI-Desktop。保留内核，换掉外层接法——插件自带只监听本机的 OpenAI 兼容网关，声明式 provider 的每一次请求都落进同一条路径。

| 维度 | 说明 |
| --- | --- |
| **这是什么** | 本地网关 `127.0.0.1:41593` + 账号池与轮转/冷却 + 通道枚举与校验 + pin / exclude + failover + 流式空闲超时 + 思考档位映射 |
| **怎么看** | 面板五页：账号池 / 模型与通道 / 请求历史 / 用量 / 设置 · 官方额度窗口（5 小时 / 本周 / 本月）· 10 个 `cline_pass_*` agent 工具 |
| **接哪里** | Cline Pass（`api.cline.bot`）· 声明式 `contributes.providers` → 本机网关 |

---

PI-Desktop 的插件只能**声明式**注册 provider（`contributes.providers`），请求由宿主自己发出——插件拿不到请求路径。
所以这里保留 DSH 内核、换掉外层的接法：插件自带一个**只监听本机**的 OpenAI 兼容网关，manifest 把这个网关声明成 provider，
宿主发的每个请求都会落进网关，网关照旧做通道枚举与校验、pin/exclude、failover、账号池与冷却、流式空闲超时、思考档位映射。

```text
PI-Desktop ──POST http://127.0.0.1:41593/v1/chat/completions──▶ 本插件网关 ──▶ Cline Pass (api.cline.bot)
```

---

## 🚀 加载与首次使用

### 1 · 加载

插件页 → **Load development plugin** → 指向本目录（`D:\Pi\Chat\plugins\pi.cline-pass`）。保存文件即热重载。
本插件申请 `provider.register`、`agent.tool.register`（高危，需要你显式批准）、`background.service`、`ui.panel`、`notify`；
若之后改了 `permissions`，先移除再重新加载（开发插件的权限以首次批准为上限，宿主会拒绝热重载）。

### 2 · 打开面板

命令面板里 `Cline Pass：打开管理面板`（命令 id `cline-pass.open`），或插件页的面板。

### 3 · 给 key（两种可以混用，账号池会轮转）

- 模型设置页里给这个 provider 填 Cline API Key → 作为 `host` 账号参与，**只在当次请求的内存里用，不落盘**；
- 面板「账号池」里加 `inline` 账号（key 写进插件数据目录的 `config.json`）。表里每行都有**编辑**：改账号名 / 显示名 / 换 key
  （**key 留空 = 不改动**）/ 停用启用。
  - 模型设置页里填的那把 key 会以 `host` 账号参与轮转，但它**不列在账号池表里**：它的 key 只在当次请求的内存里，
    插件既读不到也改不了（报头的「内联账号 N + host」会说明它还在不在）。
  没有「读环境变量」那种账号：宿主给插件进程的是**最小环境**（`PATH`/`TEMP`/`HOME` 一类 + `PI_PLUGIN_ID`），
  取不到你自己设的变量，所以这个来源已去掉（传 `source=env` 会被明确拒绝）。

### 4 · 摸通道

面板依次点 **Probe**（判定路由管线并从路由层错误里抓该模型的完整通道列表）→ **Validate**（逐通道 pin 一遍，
判定依据是响应自报的 `finalProvider`，不是 HTTP 200）→ 需要时 **Pin/Exclude**。

### 5 · 用起来

模型选择里选 **provider「Cline Pass（本地网关）」**下的模型即可——注意别和自建的同名 provider 混了（见下文「注意 provider 撞名」）。

---

## 🧩 模型注册与参数（面板可改）

宿主的插件 provider 是**插件所有**的：`providers.owner_plugin_id` 标着插件 id，设置页对这类行不给编辑入口
（原文：\"This provider comes from the plugin …, which supplies its endpoint and models.\"），而且宿主加载插件时会用
manifest 里的 `contributes.providers[0]` 整体刷回该行的 `config_json`。所以**能改参数的地方只有本插件的 manifest**，
面板就是这个改动的入口：

- 面板「模型参数 / 注册」可改 `registered` / `contextWindow` / `maxTokens` / `supportsImages` / `thinkingLevels` / `defaultThinkingLevel`；
  改动写进插件数据目录的 `config.json`（`modelSettings`），并**重写本插件自己的 `manifest.json`**（写前备份到数据目录 `manifest.backup.json`）。
- 参数默认值取自 Cline 官方目录里 `cline-pass` provider 下的 14 个模型；`cline-pass/qwen3.8-max` 在官方目录里没有独立条目
  （窗口/输出与目录的 `CLINE_PASS_MODEL_DEFAULTS` 常量逐字相同），目录与面板都标 `fallback`，默认不注册。
- 未注册的模型**不会**出现在宿主的模型选择器里。

> [!IMPORTANT]
> **生效路径（实测，别搞错）**：宿主 provider 行由宿主核心同步，**开发热重载不会刷新它**——2026-10-13 连续 4 次热重载
> （`development.plugin.reloaded` 均为 `ok:true`）后，`pi.sqlite` 里那行仍是旧的 15 个模型（`updated_at` 停在 `06:45:11Z`）。
> 宿主日志只在启动时打 `state: reconciled plugin provider rows count=1`；插件**安装/启用**路径会重写该行。
> 因此要让新参数/新模型真的进模型选择器，需要在插件页把本插件**停用再启用**（或重启 PI-Desktop）。面板写入成功后会提示这一点。

> [!WARNING]
> **注意 provider 撞名（实测踩过）**：宿主的模型选择器按「provider + 模型」区分，同一个模型 id 可以同时挂在多个 provider 下。
> 2026-10-13 本机实测：6 个 provider 里有两个都提供 `cline-pass/deepseek-v4.1-flash`，用户日常会话走的是**自建的那条**
> （`bc036988-…`，只声明了 2 个模型），插件网关侧 0 个会话、用量账本为空——也就是说 pin / failover / 账号池 / 用量
> 这些功能看不到那部分流量。要让它们真正作用到你的请求：在模型选择器里选 provider 为「Cline Pass（本地网关）」下的模型，
> 或者把你自建 provider 的 `baseUrl` 指到 `http://127.0.0.1:41593/v1`（后者会让本插件的网关接管那条 provider 的所有请求）。

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
- **`host` 账号不列在这里**（和「账号池」表一致）：模型设置页那把 key 只活在请求内存里，面板这座桥拿不到它，
  列出来永远只能是一行「读不到」，所以直接不列 —— 标题里的账号数也只数内联账号。
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
| 插件日志 | 同目录 `gateway.log`（上限 512 KB，超出即清空重写），同时打到 stderr，宿主 `plugin.log` 里带 `[pi.cline-pass]` 前缀 |
| 用量账本 | 同目录 `usage.jsonl`（超过 2 MB 轮转为 `usage.1.jsonl`）：模型/通道/账号/token/成本/耗时，不含任何请求正文 |
| manifest 备份 | 同目录 `manifest.backup.json`（面板改参数前的上一版 manifest） |

- 模型设置页里填的 key 只作请求内存使用，不写盘；面板与工具只回显掩码提示（`maskKey`），日志不打印 key。
- 上游流量只发往面板里配置的 `baseUrl`（默认 `https://api.cline.bot/api/v1`）。传输层用 Node 全局 `fetch`；
  宿主对 `pi.net.*` 的出口域名白名单不在这条路径上。
- 请求历史只记模型 / 命中通道 / 账号名 / 状态 / 耗时 / token / 备注。

---

## 🔌 端口

- `41593` 写在 `manifest.json` 的 `contributes.providers[0].baseUrl`；网关启动时回读 manifest（`manifestPort()`），
  所以**改端口只改 manifest 这一处**。
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
`setModel`（写模型参数并重写 manifest）`usage` `usageClear` `quota`。
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

---

## ✅ 自测

```powershell
cd D:\Pi\Chat\plugins\pi.cline-pass
node --test test/gateway.test.mjs      # Windows 下必须给文件路径；45 项
node test/render-quota.cjs             # 面板额度卡片：63 条断言，不需要浏览器
node test/panel-wiring.cjs             # 面板接线：脚本要的 id/class 是否都还在
```

覆盖：manifest↔代码一致性（工具 / 面板动作逐项对齐）、**清单形态守卫（`{en, zh-CN}` 只允许出现在宿主会解析 i18n 的位置）**、
**面板/工具预算不越宿主上限**、pin 两种拼装的写入与解析、模型清单与外机 403、流式 SSE、非流式 JSON、
跨账号 failover 与冷却落点、pin 注入上游、思考档位映射与**按模型收敛**、无可用账号时的 502、probe 抓通道、validate 逐通道、
test 走 pin 链、账号 CRUD 不泄漏密钥、端口/状态一致性、
**注册表（默认 5 个注册 / 覆盖生效与越界丢弃 / manifest 写入与备份 / 坏 manifest 不抛）**、
**用量账本（窗口过滤、按模型·通道·天分组、坏行容错、清空、`extractUsage` 的多种成本拼写）**、
**官方额度（按账号读取与 60 秒缓存、`refresh` 绕过、401/500 当数据返回、空窗口列表不是错误、缺百分比保持未知）**、
**接线冒烟（临时网关 start → `/v1/models` → `state` → `usage` → 真实请求落账 → stop，用来抓漏 require 这类只在运行期暴露的错）**。
上游由本机 mock 顶替，不需要真 key、不产生真实流量。

---

## 🔄 与 DSH 版的差异

|  | DSH | 这里 |
| --- | --- | --- |
| 接法 | LLM adapter 直接挂进请求链 | 声明 provider → 本机网关（`src/gateway.js`）承载同一条请求路径 |
| 思考档位 | DSH 词表 | PI 词表（`off/minimal/low/medium/high/xhigh/max`）；宿主发 `reasoning_effort`，`off` → 删掉该字段 |
| 密钥 | DSH 配置 | 插件数据目录 `config.json` + 模型设置页的 host key（内存） |
| 面板桥 | DSH 面板通道 | `skill.setEnabled` + `payload.action` |
| 官方额度 | 面板直接读 | 同一接口、同一显示口径（已用 % + `usageColor` 三档 + ‹ › 翻页 + 灰字错误），多一层按账号逐读与 60 秒缓存，缺百分比降级显示而不是补 0 |

`src/protocol.js`、`src/engine.js`、`src/catalog.js` 与账号池（`src/config.js`）按 DSH 0.2.5-p3 的 `lib/*.js` 逐字对照改写为 CommonJS。

---

## 🧪 验证状态

- 已验证（真机）：插件在 PI-Desktop 里加载并持续使用；`development.plugin.reloaded` 多次 `ok:true`、网关 `health` 正常；
  真实请求走通（非流式 `200`、`provider=deepseek`、`reasoning` 保留、`usage` 有值）；
  源码 10 个 JS + `main.js` + 3 个测试脚本过 `node --check`；`node --test test/gateway.test.mjs` **45/45**；`node test/panel-wiring.cjs` 通过（56 个 id、全部 class 有样式、`<style>` 花括号平衡、v2 chrome meta 与标题栏变量还在）；
  渲染层 63 条离线断言（`node test/render-quota.cjs`：从 `renderer/index.html` 现抽脚本、喂假 DOM 跑额度卡片，
  口径逐条对照 DSH 原版 `UsageCard`）全过；
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

---

## 📦 来源

行为移植自 DSH 插件 `dsh-cline-pass` 0.2.5-p3（其 `package.json` 声明 MIT）。本插件目录为改编产物。
