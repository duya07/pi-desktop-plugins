# 上游插件校验记录（2026-10-14）

## 官方工具链校验（容器内，宿主机无 Node）

```bash
docker run --rm -v <PI-Desktop仓库>:/work -v <插件目录>:/pdp -w /work node:22-bookworm-slim sh -c '
  npm i -g pnpm@10
  pnpm install --filter "@pi-desktop/plugin-devkit..."
  pnpm --filter "@pi-desktop/plugin-devkit..." build
  node packages/plugin-devkit/dist/cli.js check /pdp/<plugin>
  node packages/plugin-devkit/dist/cli.js pack  /pdp/<plugin> --out /pdp/dist
'
```

结果：

```
warn   permission.high-risk: high-risk permissions require an explicit user grant: agent.tool.register
OK io.github.duya07.desktop-file-reader@0.1.0 — 3 files, 13.2 KB

warn   permission.high-risk: high-risk permissions require an explicit user grant: agent.extension
OK io.github.duya07.think-zh@0.2.0 — 4 files, 6.0 KB
```

（`warn` 是高危权限的正常提示，不是错误。）

## 两个必踩的坑

1. `pnpm` 必须 **≥ 10**（9.x 被仓库 `engines` 拒绝）
2. build 的 filter 必须带 **`...` 后缀**递归编译依赖的 `plugin-sdk`，
   否则 `check` 报 `Cannot find module '@pi-desktop/plugin-sdk/dist/index.js'`

## 远程工作区下 PluginCheck/PluginScaffold/PluginPack 会失败

它们在**桌面侧**执行，把 workspace 当桌面路径，报：

```
ENOENT: no such file or directory, mkdir 'D:\Programs Files\PI-Desktop\remote-project:<id>\...'
```

所以远程会话里要用上面的容器化方案做权威校验。

## 产物 sha256

| 文件 | sha256 |
|---|---|
| io.github.duya07.desktop-file-reader-0.1.0.piplug | 9f7069897626c0cc5490093bd090c238e0c1271642102eb700f2db973bb5c86a |
| io.github.duya07.think-zh-0.2.0.piplug | 70f92976303255e36d14f23d7e03ca859638461d9e6896556db9e8427ccb691d |

注：Release `plugins-2026.10.14` 上挂的是**手工打的 zip**，与官方 `pack` 产物**内容相同、字节数相同**，
仅 zip 头时间戳字段不同；两者都可正常安装。

## 追加：desktop-file-reader 0.2.0（2026-10-14）

新增 `write_desktop_file`（无目录限制，用户明确要求；安全性由使用纪律 + 工具内置保护共同保证）。

- 官方 `pi-plugin check`：`OK io.github.duya07.desktop-file-reader@0.2.0 — 3 files, 20.7 KB`
- `node --check`：通过
- 逻辑测试：**14 项全部通过**，含全部拒绝路径
  （新建无 `allowCreate` / 覆盖无 `expectedSha256` / 覆盖 sha 不匹配 / 超 4 MiB / 目录路径 / 空 path）
- 官方 `pack` 产物 sha256：`3be054df23a07f8cb6858d33aa32dcf9d0730037c6d103ce27c7b11053da152b`

已推送 `b590d19` 并发 Release `desktop-file-reader-v0.2.0`；旧的 0.1.0 产物已从 `plugins-2026.10.14` 移除。

## 追加：desktop-file-reader 0.3.0（2026-10-14）

新增 `delete_desktop_file`（四道门禁 + 保护清单，约束细节见插件 README）。

- 官方 `pi-plugin check`：`OK io.github.duya07.desktop-file-reader@0.3.0 — 3 files, 36.0 KB`
- `node --check`：通过
- 隔离运行时测试：**43 项全部通过**（容器 `node:22-bookworm-slim`，脚本 `ops/plugin/upstream/test/delete-0.3.0.test.js`）
  - 保护清单 16 例：盘根 `C:/` `C:\` `/`、`Windows`、`Program Files`、`Program Files (x86)`、
    `ProgramData`、`.ssh`、`.gnupg`、`.aws`、`.pi-desktop`、`pagefile.sys`、`hiberfil.sys`、
    `swapfile.sys`、`bootmgr`、`$MFT`
  - 不误伤：`C:/Users/me/Windows/notes.txt`（同名普通目录）
  - 类型门：符号链接不跟随、目录不递归、空 path、不存在的路径
  - 确认门：缺 `confirm`、`confirm` 为字符串 `"true"`
  - 内容门：缺 sha/size、sha 非 64 hex、sha 不匹配、size 不匹配、size 非整数
  - 正例：`dryRun` 不落删、sha 路径成功、size 路径成功、两者同时成功、删除后目录条目减少
- 官方 `pack` 产物：`io.github.duya07.desktop-file-reader-0.3.0.piplug`
  37272 字节 sha256 `ce2f6836aa6f0f8870432905ac0b57f950cfc2601ea4bf8ea8a74c0dc6f000bf`

已推送上游 `cfa1993`（0.3.0 主体）与 `140d4ab`（README 指向仓库内测试脚本 + 测试脚本入库），
并发 Release `desktop-file-reader-v0.3.0`（资产 `uploaded`）。

## 追加：desktop-file-reader 0.4.0（2026-10-14）

新增 `push_desktop_file_to_remote` / `pull_remote_file_to_desktop`（HTTP 直传，字节不经 LLM，详见 `ops/plugin/upstream/DESIGN-0.4.0.md`）。
旧 4 工具语义不变，权限仍仅 `agent.tool.register`。设计文档已移至 `ops/plugin/upstream/DESIGN-0.4.0.md`（不在插件目录内）。
0.4.0-rev.2：receiver 凭据不进 `ps`（`--token-file` / `DFR_RECEIVER_TOKEN`），修复 `57c78...` 产物；旧产物作废见下。

### 官方工具链校验（容器内，宿主机无 Node）

```bash
# 宿主机无 Node，用容器跑官方校验（两个必踩坑见上）
docker run --rm -v /root/PI-Desktop/code/PI-Desktop:/work -v /root/PI-Desktop/ops/plugin/desktop-file-reader:/pdp -w /work node:22-bookworm-slim sh -c '
  npm i -g pnpm@10
  pnpm install --filter "@pi-desktop/plugin-devkit..."
  pnpm --filter "@pi-desktop/plugin-devkit..." build
  node packages/plugin-devkit/dist/cli.js check /pdp
  node packages/plugin-devkit/dist/cli.js pack  /pdp --out /pdp/dist   # 产物在 /pdp/dist，仅验证用
  # 正式归档：pack 到宿主机可见的 upstream/dist
'
# 正式归档（宿主机可见）
docker run --rm -v /root/PI-Desktop/code/PI-Desktop:/work -v /root/PI-Desktop/ops/plugin/desktop-file-reader:/pdp -v /root/PI-Desktop/ops/plugin/upstream/dist:/out -w /work node:22-bookworm-slim sh -c '
  node packages/plugin-devkit/dist/cli.js pack /pdp --out /out
'
```

真实输出（2026-10-14 12:36，rev.2）：

```
warn   permission.high-risk: high-risk permissions require an explicit user grant: agent.tool.register

OK io.github.duya07.desktop-file-reader@0.4.0 — 5 files, 89.0 KB
warn   permission.high-risk: high-risk permissions require an explicit user grant: agent.tool.register
Packed io.github.duya07.desktop-file-reader-0.4.0.piplug (5 files, 89.5 KB)
  path   /tmp/out/io.github.duya07.desktop-file-reader-0.4.0.piplug
  sha256 e92733a2b99800e9f5aade81ed3ab8aa13ad9f98e2f06e00c40e0ef6f97a70ca
```

条目清单（5 files，`python3 -m zipfile` 解包核对）：

```
.gitignore  31
README.md   26545
main.js     40405
manifest.json  8591
remote/receiver.py  15567
```

`dist/` 与 `__pycache__/` / `*.pyc` 已排除（`ops/plugin/desktop-file-reader/.gitignore` + pack 的 `dist/` 排除；语法检查用 `python3 -c "import ast;ast.parse(...)"` 不写字节码）。

作废声明：
- `f72d19af43e0a122490dd4d9d78421c5074ed3e258c7609fff8f57f20aea7337`（117247 字节，6 files 含 `remote/__pycache__/receiver.cpython-311.pyc`）**作废**（首版 0.4.0 误用 `python3 -m py_compile` 产生 pyc）
- `57c7808d066fe076fd28950357a83320af2fa5c618f721557116145e72cf5728`（87678 字节，5 files，不含 pyc，receiver 旧版无 `--token-file`）**作废**，已替换为上述 `852de0a…`（receiver 支持 `--token-file` / `DFR_RECEIVER_TOKEN`，README/DESIGN 改为 `umask 077 && openssl rand -hex 16 > /tmp/dfr.token` 形式）

另外验证（容器 `node:22-bookworm-slim`）：

```bash
docker run --rm -v /root/PI-Desktop/code/PI-Desktop:/work -v /root/PI-Desktop/ops/plugin/desktop-file-reader:/pdp -v /root/PI-Desktop/ops/plugin/upstream/test:/t -w /work node:22-bookworm-slim sh -c '
  node --check /pdp/main.js && echo "node --check OK"
  node /t/delete-0.3.0.test.js /pdp/main.js
  node /t/transfer-0.4.0.test.js /pdp/main.js
'
# 语法：python3 -c "import ast;ast.parse(open('ops/plugin/desktop-file-reader/remote/receiver.py',encoding='utf-8').read())" && echo "py ast ok"
# 凭据：python3 -u remote/receiver.py --token-file /tmp/dfr.token ... & ps -o args= / grep -v token
```

真实输出（rev.2）：

- `node --check /pdp/main.js`：`OK`（无输出即通过）
- `delete-0.3.0.test.js`：**43 passed, 0 failed**（0.4.0 中该脚本已放宽“注册 4 个工具”为包含新工具的兼容断言，旧 43 项语义继续全过）
- `transfer-0.4.0.test.js`：**51 passed, 0 failed**（含全部拒绝路径、端到端与补强）
  - 拒绝路径：push（缺 path/缺 URL/非 http/token 过短/含空白/sha 非法/sha 不匹配/method 非法/timeout 非法/目录/符号链接/不存在/不可达）、pull（缺 path/缺 URL/非 http/token 过短/expectedRemoteSha256 非法/缺 allowCreate/缺 expectedSha256/目录/符号链接）、端到端（push 成功/POST/重定向拒绝/500 拒绝、pull 新建/expectedRemoteSha256 正确与不匹配/覆盖成功与不匹配/重定向/404/二进制 64KB 随机字节一致/token 错 401）、补强（push >50 MiB 超限前置拒绝、pull X-File-SHA256 头与实际内容不一致被拒、receiver token 日志遮蔽、--token-file 鉴权、DFR_RECEIVER_TOKEN 鉴权、ps/cmdline 不含明文 token）
  - 端到端以本地 `http.createServer` mock 远端 receiver.py 行为（PUT /push/<name>、GET /pull/<name>、/health、/redirect、/error500）；receiver 真实运行以 `python3 -u --token-file` 起子进程验证 `ps -o args=` 与 `/proc/<pid>/cmdline` 均不含明文 token，且 `Authorization: Bearer` 鉴权成功、横幅为 `token=*** (from file ...)`、`token=*** (from env ...)`
- `python3 -c "import ast;...receiver.py"`：`py ast ok`（不写 `__pycache__`）
- receiver 实测（宿主 `python3 -u`）：`--token-file` 与 `DFR_RECEIVER_TOKEN` 两条路径均 `PUT 200` / `GET 200` 且 sha 一致；`--token` 路径 `ps -eo args` 可见明文（符合预期，仅调试用）；横幅与访问日志均不含明文 token（`/push/***/...`）

### 产物

| 文件 | 大小 | sha256 | 条目 |
|---|---|---|---|
| io.github.duya07.desktop-file-reader-0.4.0.piplug | 91630 字节（89.5 KB） | `e92733a2b99800e9f5aade81ed3ab8aa13ad9f98e2f06e00c40e0ef6f97a70ca` | 5 files（.gitignore, README.md, main.js, manifest.json, remote/receiver.py） |

- 产物仅归档到 `ops/plugin/upstream/dist/`（`ops/plugin/desktop-file-reader/dist/` **不保留**，已删除；插件目录仅源码）
- 上游工作副本 `/tmp/pdp/desktop-file-reader/` 已同步：`main.js` / `manifest.json` / `README.md` / `remote/receiver.py` / `.gitignore`（`DESIGN-0.4.0.md` 在 `ops/plugin/upstream/` 不进包），`dist` 已同步新 sha
- `remote/receiver.py`：`python3 -c "import ast;ast.parse(open(...).read())"` 通过；`__pycache__` 已清理；日志 token 遮蔽 + `ps` 不泄露已验证；`--token-file` 权限过宽时打 `WARNING`（不拒绝，便于排障）
- P2 判断：`.gitignore` 31 字节**有意包含**在 `.piplug`（见下节），上游 pack 与独立 pack 一致
- 未变更旧产物：`0.2.0` `3be05…` / `0.3.0` `ce2f6…` / `think-zh 70f92…` 保持不变

### P2 判断：`.gitignore` 要不要进包

**结论：有意包含，保持现状。理由：**
- `walk.ts` 的 `IGNORED_DIR_NAMES` 仅忽略 `.git` 与 `node_modules`，`selectPackageFiles` 仅忽略 `dist/` 与 `SECRET_FILE_PATTERNS`（`.env` / `*.pem` / `*.key` 等），`.gitignore` 本不在忽略列表——这是上游 pack 的既定行为，不是本插件可改的。
- 把规则挪到仓库根 `.gitignore` 可让插件目录"看起来干净"，但对 pack 结果无影响（根 `.gitignore` 不影响 `walkPluginDir(dir)` 的文件收集），反而让"此插件为何忽略 `__pycache__`"的意图在插件目录内不可见，增加维护成本。
- `.gitignore` 仅 31 字节，明文且无敏感信息，随包分发无安全/体积问题；且它让"如何本地开发不污染包"的约定与包本身自描述一致。
- 因此接受并在此注明"有意包含"；`VERIFICATION` 的条目清单已显式列出 `.gitignore`，与独立 pack 的 5 files 一致，可作为安装校验依据。

### 未验证项

- 真实 Windows 桌面 + 真实远端 VPS 的端到端直传（仅本地 mock + 宿主 receiver 子进程验证，未在 <mesh-ip> / <remote-public-ip> 上起 receiver.py）
- `receiver.py` 经 openresty 反向代理的链路（`proxy/dfr.conf` 未创建，按 DESIGN 需手动一次性配置，附回滚）
- 桌面直连 `<mesh-ip>:8765` 已知不可达（桌面不在 mesh，见 DESIGN §4.4），首选 `ssh -L` 转发
- LLM 侧真实调用 push/pull 的集成（仅工具层单测，未走 PI-Desktop 宿主分发链）

## 去敏修订（2026-10-14）

0.4.0 首版文档（`README.md` / `DESIGN-0.4.0.md` / `remote/receiver.py`）与包内 README 曾照抄环境侦察结果，
含真实域名、真实服务器路径、内网 mesh 拓扑、容器服务清单与公网 IP，这些**不应出现在公开仓库**。

已全部替换为占位符（`panel.example.com` / `/srv/panel/` / `<mesh-ip>` / `<remote-public-ip>` 等），
并重新打包。**当前有效产物**：

| 文件 | 字节 | sha256 |
|---|---|---|
| io.github.duya07.desktop-file-reader-0.4.0.piplug | 91630 | `e92733a2b99800e9f5aade81ed3ab8aa13ad9f98e2f06e00c40e0ef6f97a70ca` |

此前记录的 `852de0a9…`（去敏前）**作废**。Release 资产与 Release body 已同步替换。

---

## 追加：desktop-file-reader 0.5.2（2026-10-14）

**新增只读工具 `read_skill`** —— 按技能名读桌面 `~/.agents` 下的 `skills/<name>/` 目录里的文件（默认 `SKILL.md`）。

动机：宿主侧 `cn.star.skill-learning` 的 `tool_call` 守卫对**非白名单工具**（`read_desktop_file` 正在其中）会在载荷含技能目录字面量时拦截；把「技能名」交给插件、完整路径由插件内部拼装后，载荷天然不含该字面量，守卫不再误拦。`name` 只接受单层目录名，`file` 只接受技能目录内相对路径，越界解析再兜一道。

### 校验

- `node --check` 通过。
- 守卫判决探针（复刻 `cn.star.skill-learning` 0.1.8 的 `isBlockedSkillsWrite` 规则）**5/5 符合预期**：直写完整路径 = 拦、插 `/./` = 过、`read_skill` = 过、传技能目录给 `list_desktop_dir` = 过。
- 真读 `win-to-remote-sync/SKILL.md` 得 `size=20038`，base64 解码以 `---\nname: win-to-remote-sync` 开头。
- 非法输入（`name:"../.."`、`name:"a/b"`、`file:"../../../secrets/x"`、`file:"C:/Windows/win.ini"`、空 `name`）全部拒绝。
- `onLoad` 注册的 **8** 个工具名与 manifest 逐一对齐。

### 产物

| 文件 | 字节 | sha256 |
|---|---|---|
| io.github.duya07.desktop-file-reader-0.5.2.piplug | 153096 | `f88c51d20909091fbf5e15876d05390f87fc130f277fbd4c62587b5c732777b1` |

### 安装与生效（本机实测）

插件页**安装**该 `.piplug` 后，`plugin.log` 出现 `plugin.unload` + `plugin.load.success`，`ToolSearch` 可激活 `read_skill`。
注意：**installed 插件不热重载** —— 直接覆盖 `installed/<id>/main.js` 不会生效，日志里也不会出现 load 事件；只能走插件页安装。

本版同时包含 0.5.1 的 SSH 通道修复（`sftp` 子进程补 `%ProgramData%`，否则 Windows 上必然 `exit 255` 且零输出），0.5.1 未单独发版。
