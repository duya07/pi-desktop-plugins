# PI-Desktop Plugins

[duya07](https://github.com/duya07) 的 [PI-Desktop](https://github.com/vastsa/PI-Desktop) 插件集合。每个子目录是一个独立插件，自带 `manifest.json` 和 README。

| 插件 | 说明 | 版本 | 权限 |
|---|---|---|---|
| [`pi.transcript-doctor`](./pi.transcript-doctor/) | 会话转录索引体检。检查 `.jsonl.layout` 行偏移缓存是否与 `.jsonl` 对得上，脏了就备份并清理，避免 host-core 报 `stream did not contain valid UTF-8` 并卡死持久化队列。纯本地字节比对，零模型调用。 | 0.1.0 | `ui.panel` `background.service` `notify` `agent.tool.register` |
| [`pi-think-zh`](./pi-think-zh/) | 中文可见推理指引。每轮在 `before_agent_start` 追加明确的语言要求，约束宿主"思考"区里模型已公开返回的 `thinking` / `reasoning` 文字，而不只是最终回答。 | 0.2.0 | `agent.extension` |

## 安装

**方式一：开发加载（改代码即时热重载）**

1. 打开 PI-Desktop → 设置 → 插件。
2. 点 **Load development plugin**，指向本仓库里的插件目录（例如 `.../pi.transcript-doctor`）。
3. 首次加载会列出该插件申请的权限，确认后即可用。

> 注意：开发插件的权限集以你**首次批准**时看到的 manifest 为上限。之后若 manifest 新增了权限，热重载会被拒绝（`PERMISSION_DENIED`），需要在插件页移除后重新加载，重新审查一次。

**方式二：安装打包产物**

`dist/*.piplug` 由插件页安装（发行版会挂在 GitHub Releases）。

## 开发

每个插件的目录约定：

```
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

## 命名约定

插件 id 使用 `io.github.duya07.<name>`。`pi.*` 前缀属于 PI-Desktop 官方插件（`pi.todo`、`pi.browser`、`pi.file-manager`），请勿占用；`local.*` 是宿主给本地开发插件的标识，发布时也应替换。

## 许可

MIT，见 [LICENSE](./LICENSE)。
