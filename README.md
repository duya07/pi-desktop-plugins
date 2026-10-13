# PI-Desktop Plugins

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE) [![pi.cline-pass](https://img.shields.io/badge/pi.cline--pass-1.0.0-blue)](./pi.cline-pass/) [![PI-Desktop](https://img.shields.io/badge/PI--Desktop-compatible-lightgrey)](https://github.com/vastsa/PI-Desktop)

> 精选 · 独立 · 可发布 — 每个子目录都是一个自带 `manifest.json` 的完整 PI-Desktop 插件，开箱即用，互不依赖。

[duya07](https://github.com/duya07) 的 [PI-Desktop](https://github.com/vastsa/PI-Desktop) 插件集合。每个子目录是一个独立插件，自带 `manifest.json` 和 README。

---

## 🧩 插件一览

| 插件 | 版本 | 说明 | 权限 | 关键能力 |
|---|---|---|---|---|
| [`pi.transcript-doctor`](./pi.transcript-doctor/) | 0.1.0 | 会话转录索引体检。检查 `.jsonl.layout` 行偏移缓存是否与 `.jsonl` 对得上，脏了就备份并清理，避免 host-core 报 `stream did not contain valid UTF-8` 并卡死持久化队列。纯本地字节比对，零模型调用。 | `ui.panel` · `background.service` · `notify` · `agent.tool.register` | 本地字节比对 · 自动备份清理 · 零模型调用 |
| [`pi.cline-pass`](./pi.cline-pass/) | 1.0.0 | Cline Pass 订阅接入。插件自带本地 OpenAI 兼容网关（`127.0.0.1:41593`），把声明式 provider 接到同一条请求路径上：账号池与轮转、上游通道枚举与校验、pin/exclude、failover、流式空闲超时、思考档位映射。面板分账号池 / 模型与通道 / 请求历史 / 用量 / 设置五页，含 Cline 官方额度窗口（5 小时 / 本周 / 本月）与 10 个 `cline_pass_*` agent 工具。 | `ui.panel` · `background.service` · `notify` · `agent.tool.register` · `provider.register` | 本地网关 `127.0.0.1:41593` · 账号池轮转/冷却 · 10 个 agent 工具 · 5 模型默认注册 |
| [`pi-think-zh`](./pi-think-zh/) | 0.2.0 | 中文可见推理指引。每轮在 `before_agent_start` 追加明确的语言要求，约束宿主"思考"区里模型已公开返回的 `thinking` / `reasoning` 文字，而不只是最终回答。 | `agent.extension` | `before_agent_start` 注入 · 约束 `thinking`/`reasoning` 语言 |

> [!TIP]
> `pi.cline-pass` 会注册一个 provider：装好后模型选择器里出现 `cline-pass/*`（默认注册 5 个模型，注册范围可在面板里改）。用之前给它一把 Cline API Key —— 填在模型设置页（只在当次请求的内存里，不落盘），或在插件面板「账号池」里加内联账号（可多个，轮转 + 冷却失败账号）。

---

## 📦 安装

### 方式一 · 开发加载（改代码即时热重载）

1. 打开 PI-Desktop → 设置 → 插件。
2. 点 **Load development plugin**，指向本仓库里的插件目录（例如 `.../pi.transcript-doctor`）。
3. 首次加载会列出该插件申请的权限，确认后即可用。

> [!CAUTION]
> 注意：开发插件的权限集以你**首次批准**时看到的 manifest 为上限。之后若 manifest 新增了权限，热重载会被拒绝（`PERMISSION_DENIED`），需要在插件页移除后重新加载，重新审查一次。

### 方式二 · 安装打包产物

`dist/*.piplug` 由插件页安装（发行版会挂在 GitHub Releases）。

---

## 🛠️ 开发

每个插件的目录约定：

```text
<plugin>/
├── manifest.json     # 清单：id / version / permissions / contributes / activationEvents
├── main.js           # 导出 onLoad / onUnload（面板插件再加 onPanelInvoke）
├── renderer/         # 面板 UI（可选）
├── src/              # 实现模块（可选）
└── README.md
```

用 PI-Desktop 自带 CLI 校验与打包（`dist/` 不入库）：

```bash
pnpm pi-plugin check <plugin-dir>
pnpm pi-plugin pack <plugin-dir>
```

---

## 🏷️ 命名约定

插件 id 使用 `io.github.duya07.<name>`。`pi.*` 前缀属于 PI-Desktop 官方插件（`pi.todo`、`pi.browser`、`pi.file-manager`），请勿占用；`local.*` 是宿主给本地开发插件的标识，发布时也应替换。

---

## 📄 许可

MIT，见 [LICENSE](./LICENSE)。
