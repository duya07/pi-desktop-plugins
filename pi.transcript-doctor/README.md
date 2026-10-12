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

上游 issue：[vastsa/PI-Desktop#1585](https://github.com/vastsa/PI-Desktop/issues/1585)（主修复 PR #1555 已并入 main，但 v0.18.0 早于该修复，仍在受影响）。

## 它做什么

- **面板**：每个会话一行 —— 大小、记录数、索引头字节数 vs 实际字节数、span 数、错位偏移数、落在多字节字符内部的偏移数、是否有进行中的轮次（inflight）。
- **信号**：`logs/app/persistence.log` 最近 15 分钟是否出现过 `session.persistence.flush.paused`；outbox 积压条数与按会话分布。
- **清理**：勾选过期索引 → dry-run 预览清单 → 二次确认 → 备份到插件数据目录后删除。
- **agent 工具** `transcript_doctor`：`scan` / `inspect` / `clean` / `verify`，让 agent 遇到该报错时能直接体检和清理（默认 dry-run，需显式 `confirm=true` 才删）。
- **后台自检**：低频扫描，发现脏索引或持久化被暂停过就发一次原生通知（同一问题 30 分钟内不重复提醒）。

## 它做不到什么（重要）

**清理只让「下一次重启」干净。** 运行中的 host-core 把 layout 缓存在内存里，删磁盘文件对它无效 —— 这一点在真实故障中已实测确认。所以：

1. 清理 → 2. **重启 PI-Desktop** → 3. 宿主全量扫描并重建干净索引（判据：`索引头 == 文件字节数`，错位 0）。

另外它**不**修 `.jsonl` 内容（转录本身始终是好的，坏的是索引），也**不**能阻止 bug 复发 —— 根治要等含 PR #1555 的版本。

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

## 相关

- Agent 侧的操作流程见技能 `pi-desktop-transcript-utf8-stall`（诊断 → 清缓存 → 空闲时重启 → 验证）。插件是常驻体检台，skill 是报错时的处置流程，两者共用同一套判据。

## 变更

- **0.1.0**：首个版本。面板 + 扫描 + 备份清理 + `transcript_doctor` 工具 + 低频后台自检。
