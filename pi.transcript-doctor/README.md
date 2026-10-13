> **⚠️ 已废弃（2026-10-13）—— 不再需要，不再维护，不要重新加载或安装。**
>
> 本插件是为 **PI-Desktop v0.18.0 及更早版本**的 layout 缓存漂移 bug 写的变通工具。该 bug 已由上游修复：
> - [#1555](https://github.com/vastsa/PI-Desktop/pull/1555) `fix(host-core): reject unsupported persistent transcript identities`（2026-10-11 合并；Windows 上 `file_identity()` 恒为 0 → 停用磁盘 layout 缓存，属止血）
> - [#1599](https://github.com/vastsa/PI-Desktop/pull/1599) `fix(transcripts): recover stale layout caches`（2026-10-12 合并；版本化缓存 + 可靠 file identity + 失效边界自动重建，属治本）
> - [#1586](https://github.com/vastsa/PI-Desktop/pull/1586) `fix(host-core): clean up transcript layout cache in remove_session_files`（2026-10-12 合并；删除会话时一并清理 layout 残留）
>
> 三者随 **v0.18.0-beta.7**（2026-10-12 17:45:41 UTC）发布，issue [#1585](https://github.com/vastsa/PI-Desktop/issues/1585) 已于 2026-10-13 确认 fixed 并关闭。本机随后升级到 **PI-Desktop 0.19.1**，已包含该修复，插件失去存在理由；插件已于 2026-10-13 从 PI-Desktop 卸载（`plugin.uninstalled`）。
>
> 下方内容保留为当时的实现与判据记录。今后再遇到 `stream did not contain valid UTF-8`，先确认宿主版本是否 ≥ v0.18.0-beta.7，而不是装回本插件。

# Transcript Doctor（转录体检）

PI-Desktop 插件。检查每个会话的 `.jsonl.layout` 行偏移索引是否与 `.jsonl` 对得上，脏了就备份并清理。

**纯本地字节比对，不调用任何模型 —— 零 token 消耗。**

## 它解决什么问题

PI-Desktop 宿主（`pi-desktop-host-core`）会把每条会话消息的行起始偏移缓存在转录旁边：`~/.pi-desktop/sessions/<id>.jsonl.layout`。

当 `<id>.jsonl` 被**原地重写**（流式 assistant 消息落地、子代理 Task 状态更新）而磁盘上的 layout 缓存没有被判失效时，偏移整体漂移。宿主随后 `seek` 到行中间、甚至中文 3 字节字符的续字节，`read_line()` 直接报：

```
stream did not contain valid UTF-8
```

Electron 侧把这条错误当作瞬态错误，于是 **`PersistenceOutbox.flushLoop` 永久暂停该会话的持久化队列**，后续消息全部积压在 `session-message-outbox.json` 里。

上游 issue：[vastsa/PI-Desktop#1585](https://github.com/vastsa/PI-Desktop/issues/1585)。**已修复** —— 由 [#1555](https://github.com/vastsa/PI-Desktop/pull/1555)（止血：Windows 上 identity 恒为 0 时停用磁盘 layout 缓存）+ [#1599](https://github.com/vastsa/PI-Desktop/pull/1599)（治本：版本化缓存与失效边界自动重建）+ [#1586](https://github.com/vastsa/PI-Desktop/pull/1586)（清理删除残留）共同修复，随 v0.18.0-beta.7 发布；issue 已于 2026-10-13 由报告者确认 fixed 并关闭。本 README 早期版本只提 #1555 并称其为主修复 —— 方向没错但不完整；#1585 的关闭评论引用的是 #1586 + #1599。

## 它做什么

- **面板**：每个会话一行 —— 大小、记录数、索引头字节数 vs 实际字节数、span 数、错位偏移数、落在多字节字符内部的偏移数、是否有进行中的轮次（inflight）。
- **信号**：`logs/app/persistence.log` 最近 15 分钟是否出现过 `session.persistence.flush.paused`；outbox 积压条数与按会话分布。
- **清理**：勾选过期索引 → dry-run 预览清单 → 二次确认 → 备份到插件数据目录后删除。
- **自动清理**（默认关闭）：后台自检发现过期索引就自动备份并删除，不必手动点；开启后仍会发通知告知清了多少、还剩多少。
- **备份管理**：面板列出所有备份（时间 / 文件数 / 体积），可删单份、也可一键清理旧备份；`backupKeep` 控制保留份数（默认 10，0 = 不限制），每次清理后自动剪枝，避免备份无限累积。
- **agent 工具** `transcript_doctor`：`scan` / `inspect` / `clean` / `verify` / `backups` / `prune_backups`，让 agent 遇到该报错时能直接体检、清理和整理备份（清理默认 dry-run，需显式 `confirm=true` 才删）。
- **后台自检**：低频扫描，发现脏索引或持久化被暂停过就发一次原生通知（同一问题 30 分钟内不重复提醒）。

## 它做不到什么（重要）

**清理只让「下一次重启」干净。** 运行中的 host-core 把 layout 缓存在内存里，删磁盘文件对它无效 —— 这一点在真实故障中已实测确认。所以：

1. 清理 → 2. **重启 PI-Desktop** → 3. 宿主全量扫描并重建干净索引（判据：`索引头 == 文件字节数`，错位 0）。

另外它**不**修 `.jsonl` 内容（转录本身始终是好的，坏的是索引）。根治已由上游提供：`#1555`（止血）+ `#1599`（治本）+ `#1586`，随 **v0.18.0-beta.7** 发布。**本插件因此废弃**，见文首说明。

## 判据

| 状态 | 含义 |
|---|---|
| `healthy` | `索引头 == jsonl 字节数` 且 错位 0 且 字符内 0 |
| `behind` | 索引头落后于文件（通常是追加写入），但偏移仍落在行首 —— **无害，不需要清理**；一旦转录被原地重写就会漂移成 stale |
| `stale` | 有偏移不在行首，或落在多字节字符内部 —— **需要清理**（宿主 seek 会错位并报 invalid UTF-8） |
| `no-cache` | 没有 layout 缓存（< 2 MiB 的会话本来就不写缓存，正常） |
| `error` | 文件读不了（权限/占用） |

面板只给 `stale` 提供勾选框：`behind` 清理了也没意义，还会白白触发一次重启。

宿主只在转录 ≥ 2 MiB 时才写 layout 缓存（`LAYOUT_CACHE_MIN_LEN`），所以小会话永远是 `no-cache`。

## 安全边界

- 只读：`~/.pi-desktop/sessions/*.jsonl`、`*.jsonl.layout`、`logs/app/persistence.log`、`session-message-outbox.json`。
- 唯一写操作：把 `*.jsonl.layout` / `*.layout.tmp` **复制**到插件数据目录（`<pluginData>/backups/<时间戳>/`）后删除原件。备份失败则拒绝删除。
- 删除白名单：路径必须是 `sessions` 目录的直接子项，且文件名匹配 `*.jsonl.layout` / `*.layout.tmp`。**绝不触碰** `.jsonl`、`.inflight.json`、outbox。
- 无网络请求、不调用模型、不自动执行代码。
- 文件访问走 Node fs：宿主的 `pi.fs.*` 被沙箱在 workspace 内，够不到 `~/.pi-desktop`（与 `cn.star.skill-learning`、`pi.file-manager` 同做法）。

## 命令

- `转录体检：打开面板`
- `转录体检：立即扫描`
- `转录体检：备份并清理过期索引`

## 设置

| 键 | 默认 | 说明 |
|---|---|---|
| `watchEnabled` | true | 后台自检开关 |
| `watchIntervalMinutes` | 5 | 自检间隔 |
| `notifyOnStale` | true | 发现问题时发系统通知 |
| `autoCleanEnabled` | **false** | 自动清理过期索引（发现即备份并删除）。默认关——它会真的删文件 |
| `backupKeep` | 10 | 备份保留份数；0 = 不限制（会一直累积） |

## 相关

- Agent 侧的操作流程见技能 `pi-desktop-transcript-utf8-stall`（诊断 → 清缓存 → 空闲时重启 → 验证）。插件是常驻体检台，skill 是报错时的处置流程，两者共用同一套判据。

## 变更

- **0.2.0**：自动清理（默认关闭）、备份保留份数 `backupKeep`、备份管理（面板 + 工具 `backups` / `prune_backups`）。
- **0.1.1**：修复面板「确认：备份并删除」点了没反应（宿主 `getDataPath` 是 async，被当同步值用）；面板调用加 20s 超时。
- **0.1.0**：首个版本。面板 + 扫描 + 备份清理 + `transcript_doctor` 工具 + 低频后台自检。
