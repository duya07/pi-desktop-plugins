# PI-Desktop Plugins

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE) [![cline-pass](https://img.shields.io/badge/cline--pass-1.0.0-blue)](./cline-pass/README.md) [![PI-Desktop](https://img.shields.io/badge/PI--Desktop-compatible-lightgrey)](https://github.com/vastsa/PI-Desktop)

> 精选 · 独立 · 可发布。每个子目录都是一个自带 `manifest.json` 的完整 PI-Desktop 插件，开箱即用，互不依赖。

- **这是什么**：[duya07](https://github.com/duya07) 的 [PI-Desktop](https://github.com/vastsa/PI-Desktop) 插件集合，每个子目录都自带 README。
- **有哪些插件**：见下方「插件一览」，已废弃的插件也列在表中并有标注。
- **怎么装**：见下方「安装」，可用开发加载，也可安装打包产物。

---

## 🧩 插件一览

下表列出各插件的说明、版本、权限和关键能力。

| 插件 | 版本 | 说明 | 权限 | 关键能力 |
|---|---|---|---|---|
| [`pi.transcript-doctor`](./pi.transcript-doctor/README.md) · **已废弃** | 0.1.0 | **PI-Desktop v0.19.1 已修复该问题，因此本插件已废弃（2026-10-13）：不再需要、不再维护，不要重新加载或安装。** 原功能：检查 `.jsonl.layout` 行偏移缓存是否与 `.jsonl` 对得上；若不一致，就备份并清理，避免 host-core 报 `stream did not contain valid UTF-8` 并卡死持久化队列。纯本地字节比对，零模型调用。 | `ui.panel` · `background.service` · `notify` · `agent.tool.register` | 本地字节比对 · 自动备份清理 · 零模型调用 |
| [`cline-pass`](./cline-pass/README.md) | 1.0.0 | Cline Pass 订阅接入。插件自带本地 OpenAI 兼容网关（`127.0.0.1:41593`）：账号池与轮转、上游通道枚举与校验、pin/exclude、failover、流式空闲超时、思考档位映射。面板分为五页：账号池、模型与通道、请求历史、用量、设置。此外还包含 Cline 官方额度窗口（5 小时 / 本周 / 本月）、「生成配置 / 写入文件」导出，以及 10 个 `cline_pass_*` agent 工具。 | `ui.panel` · `background.service` · `notify` · `agent.tool.register` · `models.list` · `fs.read`/`fs.write` | 本地网关 `127.0.0.1:41593` · 账号池轮转/冷却 · 10 个 agent 工具 · 生成配置供导入（默认 5 模型） |
| [`pi-think-zh`](./pi-think-zh/README.md) | 0.2.0 | 中文可见推理指引。每轮在 `before_agent_start` 追加明确的语言要求，约束宿主「思考」区中模型已公开返回的 `thinking` / `reasoning` 文字，而不只是最终回答。 | `agent.extension` | `before_agent_start` 注入 · 约束 `thinking`/`reasoning` 语言 |
| [`desktop-file-reader`](./desktop-file-reader/README.md) | 0.5.2 | 让**远端工作区**的会话直接读写删桌面机上的文件，并支持**大文件直传**（默认 SSH/sftp，零用户准备、零远端服务；字节不经 LLM 上下文）。工具在**桌面侧执行**：分发链按工具名前缀分流，先于远端分支命中。 | `agent.tool.register` | 桌面分发工具 · 读/写/删 · push/pull 直传 · `list_ssh_hosts` 列别名（先让用户选，再拼参数） · `read_skill` 按技能名读桌面技能目录（绕开宿主内容守卫的载荷匹配） · sha256 门禁 + 保护清单 · 免浏览器面板 |

> [!TIP]
> `cline-pass` **不声明任何 provider**，模型选择器里不会出现插件那一行。用法如下：
>
> 1. 在面板点「生成配置」并复制 JSON，或直接点「写入文件」（写入 `~/.pi/agent/models.json`）。
> 2. 到设置页「从其他工具导入」，把它建成**你自己的** provider（默认 5 个模型，范围可在面板里改）。
> 3. 在那张模型卡里勾选 **「可供 AI 自动调度」**。子代理能否使用它，就看这一勾；导入格式不带思考档位阶，档位请在那张卡里手改。
>
> 生成的模型 id 带 `cline-pass-local/` 前缀。宿主给子代理的委派 key 是 `<vendorKey>/<模型 id>`，若不加前缀，就会和「直连 `api.cline.bot` 的那个 provider」撞名。改 provider 名字没用，因为 key 里没有名字。网关两种拼写都认。
>
> Cline API Key 全部加在插件面板的「账号池」里（可添加多个，支持轮转与失败冷却）。导入器对**已存在**的 provider 会跳过，之后调参数请在设置页那张卡里改。

---

## 📦 安装

### 方式一 · 开发加载（改代码即时热重载）

1. 打开 PI-Desktop，依次进入「设置」→「插件」。
2. 点击 **Load development plugin**，指向本仓库里的插件目录，例如 `.../pi.transcript-doctor`。
3. 首次加载时会列出该插件申请的权限，确认后即可使用。

> [!CAUTION]
> 注意：开发插件的权限集以你**首次批准**时看到的 manifest 为上限。之后若 manifest 新增了权限，热重载会被拒绝（`PERMISSION_DENIED`）。此时需要先在插件页移除该插件，再重新加载，并重新审查一次。

### 方式二 · 安装打包产物

在插件页安装 `dist/*.piplug` 文件（发行版会挂在 GitHub Releases 上）。

---

## 🛠️ 开发

每个插件目录的约定结构如下：

```text
<plugin>/
├── manifest.json     # 清单：id / version / permissions / contributes / activationEvents
├── main.js           # 导出 onLoad / onUnload（面板插件再加 onPanelInvoke）
├── renderer/         # 面板 UI（可选）
├── src/              # 实现模块（可选）
└── README.md
```

使用 PI-Desktop 自带的 CLI 校验与打包（`dist/` 不入库）：

```bash
pnpm pi-plugin check <plugin-dir>
pnpm pi-plugin pack <plugin-dir>
```

---

## 🏷️ 命名约定

- 插件 id 使用 `io.github.duya07.<name>`。
- `pi.*` 前缀属于 PI-Desktop 官方插件（`pi.todo`、`pi.browser`、`pi.file-manager`），请勿占用。
- `local.*` 是宿主给本地开发插件的标识，发布时也应替换。

---

## 📄 许可

许可证为 MIT，详见 [LICENSE](./LICENSE)。
