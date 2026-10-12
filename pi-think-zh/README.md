# 中文可见推理指引

0.2.0 在每轮 `before_agent_start` 追加中文写的语言要求，明确针对宿主“思考”区里模型已公开返回的 `thinking`、`reasoning`、`reasoning_content` 文字及摘要，而不只针对最终回答。

核心要求：从第一句开始使用简体中文；英文任务、工具说明和引用不自动改变思考区叙述语言；代码、标识符、命令、路径、API 名和原始错误保留原文。用户明确指定某部分语言时服从该要求。

## 机制与边界

- 只用 `agent.extension`；没有文件、网络、翻译模型、后台服务或额外工具。
- 原宿主/项目提示保持不变，仅更新本插件有明确标记的 v1/v2 段；相同指引不会重复追加。
- 入口从 `extension.js` 更换为 `extension-v2.js`，避开安装版按入口 realpath 缓存的旧工厂；这不是通过修改注册表清缓存。
- 注入标记为 `<io.github.duya07.think-zh/v1|v2>`；去重正则同时认旧 id `local.pi-think-zh`，所以改 id 之前写进过 system prompt 的块也会被替换掉，不会新旧并存。
- 已核实这版 PI 的路径规则刷新会重新组装系统提示，可能覆盖本轮追加段。未采用 `before_provider_request` 返回整份 payload 的补丁，因为宿主多个该钩子的返回值不自动串联，可能覆盖 Project Knowledge 附件。该宿主限制未修复。
- 注入只对**之后新开的对话**生效：宿主在会话开始时组装 system prompt，已经开着的对话即使重新加载本插件也拿不到新段（用户 2026-10-12 实测：新对话生效，旧对话不生效）。验证办法：新开一个对话，让 agent 原样引用它 system prompt 里以 `<io.github.duya07.think-zh/v2>` 开头的那段。
- 不要求披露隐藏推理、不伪造思考区内容；不能可靠控制模型未公开的内部推理。
- 有可见文字的模型也可能忽略语言提示，因此源码和隔离运行时 PASS 不等于实际模型输出已变成中文。

## 来源

参考并适配作者发布的 `Len7183/DSH-Think-zh`（`f68c4ab06768aaec10a315712b3d15c9fa05ddaa`）与 `EmbOriented/DeepSeek-Thinking-CN`（`9dc0684267785c22cb4f646a45aafa0d61853cc0`）的明确语言条款。后者明确加入“从第一个词开始”和语言自纠。没有移植 DSH 的极小 order 置顶、宿主事件或改写用户消息的逐轮通道；不声称作者的演示是 PI 的实测结果。

固定来源、取舍和本轮验证见 `D:/Pi/Chat/research/THINK-ZH-RESEARCH.md`。

## 检查与加载

```powershell
Set-Location D:\Pi\Chat
node .\scripts\Test-ThinkZh.mjs
```

该检查使用 PI 本机 `TrustedExtensionRunner`，验证新入口加载、中文注入契约、基础提示保留、v1 升级和去重；不调用模型。单独新开会话未必重新导入扩展，必须先确认宿主已重载 manifest 指向的 `extension-v2.js`。建议在设置页显式重载/安装 0.2.0，再开新对话测试第一条消息及一次带路径的工具调用后的文字。不要直接改注册表或自动重启宿主。

## 回退

在插件页停用 `io.github.duya07.think-zh`，或恢复已备份的 0.1.0 文件后显式重载。它没有自己的业务数据或外部依赖。
