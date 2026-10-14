/**
 * desktop-file-reader 0.5.0 SSH（sftp）通道测试。
 *
 * 用法：node ssh-0.5.0.test.js /path/to/main.js
 * 在容器里跑（宿主机无 Node）：
 *   docker run --rm -v <插件目录>:/pdp -v <本文件>:/t.js -w /tmp node:22-bookworm-slim \
 *     sh -c 'node /t.js /pdp/main.js'
 *
 * 覆盖：
 *   - mode 决议：缺省推断（host→ssh / remoteUrl→http）、显式 mode、歧义、非法值
 *   - 参数校验：host 白名单与 `-` 开头拒绝、remotePath 绝对路径与控制字符、
 *     port 范围、本地路径控制字符
 *   - 传输：put/get 批处理内容与 argv 拼装（假 sftp 记录 argv + batch）、
 *     引号/反斜杠转义往返、带 port、成功返回值
 *   - 故障：非零退出码 + stderr 回传、超时杀进程（stub pid 消失）、tmp 清理、sftp 缺失
 *
 * 用假 sftp 可执行文件（放进 PATH 的 stub 脚本）验证——不发起真实网络连接。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");

const mainPath = process.argv[2];
if (!mainPath) {
  console.error("usage: node ssh-0.5.0.test.js /path/to/main.js");
  process.exit(2);
}

// ---- mock 宿主 ------------------------------------------------------------
const registered = new Map();
global.pi = {
  agent: {
    registerTool: async (t) => registered.set(t.name, t),
    unregisterTool: async (name) => registered.delete(name),
  },
};

const plugin = require(mainPath);

// ---- 小工具 ---------------------------------------------------------------
let pass = 0;
let fail = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log("PASS  " + name);
  } catch (e) {
    fail++;
    failures.push(name + " :: " + e.message + "\n" + (e.stack || ""));
    console.log("FAIL  " + name + " :: " + e.message);
  }
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ---- 假 sftp --------------------------------------------------------------
// 记录 argv 与 batch 内容到 SFTP_STUB_LOG（每行一个 JSON）；
// 按 SFTP_STUB_MODE 行为：copy（解析 put/get 并真实拷贝）/ fail（exit 1 + stderr）/ hang（永不退出）。
const STUB_SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const log = process.env.SFTP_STUB_LOG;
const mode = process.env.SFTP_STUB_MODE || "copy";
let batch = null;
const bIdx = argv.indexOf("-b");
if (bIdx >= 0 && argv[bIdx + 1]) {
  try { batch = fs.readFileSync(argv[bIdx + 1], "utf8"); } catch {}
}
if (log) fs.appendFileSync(log, JSON.stringify({ argv, batch, pid: process.pid }) + "\\n");
if (mode === "fail") {
  process.stderr.write("stub: simulated auth failure\\nPermission denied (publickey).\\n");
  process.exit(1);
}
if (mode === "hang") {
  setInterval(() => {}, 1000);
  return;
}
if (mode === "late") {
  // 父 stub 立刻退出，子进程 250ms 后往同一个 stderr 写尾巴：
  // 只有等到 stdio 真正关闭（'close' / drain 兜底）才收得到，用 'exit' 直接收敛会丢掉这段
  require("node:child_process").spawn(
    process.execPath,
    ["-e", "setTimeout(function(){require('fs').writeSync(2,'LATE-TAIL-MARKER')},250)"],
    { stdio: ["ignore", 2, 2] }
  );
  process.exit(1);
}
const m = batch && batch.match(/^(put|get)\\s+"((?:[^"\\\\]|\\\\.)*)"\\s+"((?:[^"\\\\]|\\\\.)*)"\\s*$/);
if (m) {
  const unesc = (s) => s.replace(/\\\\(.)/g, "$1");
  const cmd = m[1], a = unesc(m[2]), b = unesc(m[3]);
  try {
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.copyFileSync(a, b);
  } catch (e) {
    process.stderr.write("stub copy error: " + e.message + "\\n");
    process.exit(1);
  }
}
process.exit(0);
`;

function readStubLog(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH：进程已消失
    }
    await sleep(150);
  }
  return false;
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dfr-ssh050-"));
  const remoteDir = path.join(work, "remote");
  fs.mkdirSync(remoteDir, { recursive: true });
  const logFile = path.join(work, "sftp.log");

  const stubDir = path.join(work, "bin");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, "sftp"), STUB_SCRIPT, { mode: 0o755 });

  const origPath = process.env.PATH;
  process.env.PATH = stubDir + path.delimiter + (process.env.PATH || "");
  const stubPath = process.env.PATH; // 含 stub 目录的 PATH；测完“sftp 缺失”要还原到这个，而不是 origPath
  process.env.SFTP_STUB_LOG = logFile;
  process.env.SFTP_STUB_MODE = "copy";

  await plugin.onLoad();
  const push = registered.get("push_desktop_file_to_remote").execute;
  const pull = registered.get("pull_remote_file_to_desktop").execute;

  const victim = path.join(work, "victim.bin");
  const victimContent = Buffer.from("hello desktop-file-reader 0.5.0 ssh\\n");
  fs.writeFileSync(victim, victimContent);
  const victimSha = sha(victimContent);

  const logCount = () => readStubLog(logFile).length;

  // ---- 注册 ---------------------------------------------------------------
  await t("注册 6 个工具", () => {
    assert.deepStrictEqual(
      [...registered.keys()].sort(),
      ["delete_desktop_file", "list_desktop_dir", "pull_remote_file_to_desktop", "push_desktop_file_to_remote", "read_desktop_file", "write_desktop_file"]
    );
  });

  // ---- mode 决议与参数校验（都不应 spawn sftp） ---------------------------
  await t("push: 无 host 无 remoteUrl 无 mode 被拒", async () => {
    const r = await push({ path: victim });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /transport target|remoteUrl|host/);
    assert.strictEqual(logCount(), 0);
  });

  await t("push: host 以 - 开头（ssh 选项注入）被拒", async () => {
    const r = await push({ path: victim, host: "-oProxyCommand=evil", remotePath: "/tmp/x" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /must not start with '-'/);
    assert.strictEqual(logCount(), 0);
  });

  await t("push: host 含空格被拒", async () => {
    const r = await push({ path: victim, host: "foo bar", remotePath: "/tmp/x" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /alias or user@host/);
    assert.strictEqual(logCount(), 0);
  });

  await t("push: host user@ 空主机名被拒", async () => {
    const r = await push({ path: victim, host: "user@", remotePath: "/tmp/x" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(logCount(), 0);
  });

  await t("push: remotePath 相对路径被拒", async () => {
    const r = await push({ path: victim, host: "testhost", remotePath: "tmp/x" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /absolute path/);
    assert.strictEqual(logCount(), 0);
  });

  await t("push: remotePath 含换行被拒", async () => {
    const r = await push({ path: victim, host: "testhost", remotePath: "/tmp/evil\nrm" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /control characters/);
    assert.strictEqual(logCount(), 0);
  });

  await t("push: remotePath 含 NUL 被拒", async () => {
    const r = await push({ path: victim, host: "testhost", remotePath: "/tmp/evil\u0000x" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /control characters/);
    assert.strictEqual(logCount(), 0);
  });

  await t("push: 本地 path 含控制字符被拒", async () => {
    const r = await push({ path: victim + "\n", host: "testhost", remotePath: "/tmp/x" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /control characters/);
    assert.strictEqual(logCount(), 0);
  });

  await t("push: port 非法被拒（0 / 70000 / 1.5）", async () => {
    for (const p of [0, 70000, 1.5]) {
      const r = await push({ path: victim, host: "testhost", remotePath: "/tmp/x", port: p });
      assert.strictEqual(r.ok, false, "port=" + p + " should fail");
      assert.match(r.error, /port/);
    }
    assert.strictEqual(logCount(), 0);
  });

  await t("push: mode 非法值被拒", async () => {
    const r = await push({ path: victim, host: "testhost", remotePath: "/tmp/x", mode: "ftp" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /mode must be 'ssh' or 'http'/);
    assert.strictEqual(logCount(), 0);
  });

  await t("push: host 与 remoteUrl 同时给出且无 mode 被拒（歧义）", async () => {
    const r = await push({ path: victim, host: "testhost", remotePath: "/tmp/x", remoteUrl: "http://127.0.0.1:9/push/x" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /ambiguous/);
    assert.strictEqual(logCount(), 0);
  });

  await t("pull: host 与 remoteUrl 同时给出且无 mode 被拒（歧义）", async () => {
    const r = await pull({ path: path.join(work, "out.bin"), host: "testhost", remotePath: "/tmp/x", remoteUrl: "http://127.0.0.1:9/pull/x" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /ambiguous/);
    assert.strictEqual(logCount(), 0);
  });

  await t("push: 缺 remotePath 被拒（有 host 走 ssh）", async () => {
    const r = await push({ path: victim, host: "testhost" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /remotePath is required/);
    assert.strictEqual(logCount(), 0);
  });

  await t("pull: 缺 remotePath 被拒（有 host 走 ssh）", async () => {
    const r = await pull({ path: path.join(work, "out.bin"), host: "testhost" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /remotePath is required/);
    assert.strictEqual(logCount(), 0);
  });

  await t("push: 本地文件不存在被拒", async () => {
    const r = await push({ path: path.join(work, "nope.bin"), host: "testhost", remotePath: "/tmp/x" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not found/);
    assert.strictEqual(logCount(), 0);
  });

  await t("push: 符号链接被拒", async () => {
    const link = path.join(work, "alink.bin");
    try { fs.unlinkSync(link); } catch {}
    fs.symlinkSync(victim, link);
    const r = await push({ path: link, host: "testhost", remotePath: "/tmp/x" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /symbolic link/);
    assert.strictEqual(logCount(), 0);
    fs.unlinkSync(link);
  });

  await t("push: expectedSha256 不匹配被拒（不 spawn）", async () => {
    const r = await push({ path: victim, host: "testhost", remotePath: "/tmp/x", expectedSha256: "0".repeat(64) });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /mismatch/);
    assert.strictEqual(logCount(), 0);
  });

  await t("push: 仅 remoteUrl 无 mode → 推断 HTTP（旧接口兼容，不 spawn sftp）", async () => {
    const r = await push({ path: victim, remoteUrl: "http://127.0.0.1:1/push/x", timeoutMs: 5000 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /network error|timeout/i);
    assert.strictEqual(logCount(), 0);
  });

  await t("push: 显式 mode:'http' 走 HTTP（不 spawn sftp）", async () => {
    const r = await push({ path: victim, remoteUrl: "http://127.0.0.1:1/push/x", mode: "http", timeoutMs: 5000 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /network error|timeout/i);
    assert.strictEqual(logCount(), 0);
  });

  // ---- push 成功与 argv/batch 拼装 -----------------------------------------
  await t("push ssh 成功：argv 与 batch 拼装正确", async () => {
    const remote = path.join(remoteDir, "pushed.bin");
    const r = await push({ path: victim, host: "testhost", remotePath: remote });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.transport, "ssh");
    assert.strictEqual(r.sha256, victimSha);
    assert.strictEqual(r.bytesSent, victimContent.length);
    assert.strictEqual(fs.readFileSync(remote).toString("hex"), victimContent.toString("hex"));

    const logs = readStubLog(logFile);
    const last = logs[logs.length - 1];
    assert.ok(last.argv.includes("-b"), "argv should include -b");
    const bIdx = last.argv.indexOf("-b");
    assert.ok(last.argv[bIdx + 1] && last.argv[bIdx + 1].startsWith(os.tmpdir()), "batch file should be in tmpdir");
    assert.deepStrictEqual(last.argv.slice(bIdx + 2), [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      "testhost",
    ]);
    assert.strictEqual(last.batch, 'put "' + victim + '" "' + remote + '"\n');
    // batch 文件已被插件删除
    assert.strictEqual(fs.existsSync(last.argv[bIdx + 1]), false, "batch file should be removed");
  });

  await t("push ssh 带 port：argv 含 -P", async () => {
    const remote = path.join(remoteDir, "port.bin");
    const r = await push({ path: victim, host: "testhost", remotePath: remote, port: 2222 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const logs = readStubLog(logFile);
    const last = logs[logs.length - 1];
    assert.ok(last.argv.includes("-P") && last.argv.includes("2222"), "argv should include -P 2222");
  });

  await t("push ssh：空格/引号/反斜杠文件名转义往返", async () => {
    const tricky = path.join(work, 'a b"c\\d.txt');
    const content = Buffer.from("tricky name bytes");
    fs.writeFileSync(tricky, content);
    const remote = path.join(remoteDir, 'a b"c\\d.txt');
    const r = await push({ path: tricky, host: "testhost", remotePath: remote });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(sha(fs.readFileSync(remote)), sha(content));

    const logs = readStubLog(logFile);
    const last = logs[logs.length - 1];
    const exp = 'put "' + tricky.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '" "' + remote.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"\n';
    assert.strictEqual(last.batch, exp);
  });

  await t("push ssh：remotePath 含 shell 元字符按字面处理（不被执行、不被拒绝）", async () => {
    const remote = path.join(remoteDir, "semi;dollar$back`tick.txt");
    const r = await push({ path: victim, host: "testhost", remotePath: remote });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(fs.existsSync(remote), true, "metachar path should be treated literally");
  });

  await t("push ssh：本地源路径含 glob 元字符被拒（sftp 会展开 put 的本地源）", async () => {
    for (const name of ["src[1].bin", "src*b.bin", "src?b.bin"]) {
      const p = path.join(work, name);
      fs.writeFileSync(p, "x");
      const before = logCount();
      const r = await push({ path: p, host: "testhost", remotePath: "/tmp/x" });
      assert.strictEqual(r.ok, false, name + " should be rejected");
      assert.match(r.error, /glob metacharacters/);
      assert.strictEqual(logCount(), before, "must not spawn sftp for " + name);
    }
  });

  await t("push ssh：remotePath 含 [ 不拦（目标侧不走 glob）", async () => {
    const remote = path.join(remoteDir, "dest[1].bin");
    const r = await push({ path: victim, host: "testhost", remotePath: remote });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(fs.existsSync(remote), true);
  });

  // ---- Windows 语义回归（复核 P0：Windows 本地绝对路径必然含反斜杠） ----------
  await t("Windows 语义：path.win32 的本地绝对路径不被 glob 拦截（拦截集恰为 * ? [）", async () => {
    const BS = String.fromCharCode(92);
    // 拦截集从源码提取，保证测试跟着实现走（不复制一份会漂移的常量）
    const src = fs.readFileSync(mainPath, "utf8");
    const m = src.match(/const SFTP_GLOB_META = (\[[^\]]*\]);/);
    assert.ok(m, "main.js should define SFTP_GLOB_META as an array literal");
    let META;
    try {
      META = JSON.parse(m[1]);
    } catch (e) {
      assert.fail("SFTP_GLOB_META must stay a plain JSON array literal in main.js (got " + m[1] + "): " + e.message);
    }
    assert.deepStrictEqual(META, ["*", "?", "["], "guard set must be exactly * ? [ — backslash must NOT be included");

    for (const p of ["C:/Users/me/report.pdf", "C:/Users/me/报告 2026.pdf", "C:/Users/me/a b.txt", "C:/Users/me/f" + BS + "g.txt"]) {
      const abs = path.win32.resolve(p);
      assert.ok(abs.indexOf(BS) >= 0, "path.win32.resolve must yield backslashes: " + abs);
      assert.deepStrictEqual(META.filter((c) => abs.indexOf(c) >= 0), [], "must NOT be flagged: " + abs);
    }
    for (const p of ["C:/Users/me/a*b.txt", "C:/Users/me/a?b.txt", "C:/Users/me/a[1].txt"]) {
      const abs = path.win32.resolve(p);
      assert.ok(META.some((c) => abs.indexOf(c) >= 0), "must be flagged: " + abs);
    }
  });

  await t("push ssh：本地路径含反斜杠（Windows 绝对路径同形状）可传输，且 batch 转义往返精确", async () => {
    const BS = String.fromCharCode(92);
    const winPath = path.join(work, "C:" + BS + "Users" + BS + "me" + BS + "report.pdf");
    const content = Buffer.from("windows-shaped local path content");
    fs.writeFileSync(winPath, content);
    const remote = path.join(remoteDir, "win-shaped.bin");
    const before = logCount();
    const r = await push({ path: winPath, host: "testhost", remotePath: remote });
    assert.strictEqual(r.ok, true, "a backslash in the local path must not be rejected: " + JSON.stringify(r));
    assert.strictEqual(sha(fs.readFileSync(remote)), sha(content), "uploaded bytes must match the source file");

    const logs = readStubLog(logFile);
    assert.strictEqual(logs.length, before + 1, "exactly one spawn");
    const batch = logs[logs.length - 1].batch;
    // quoteBatchArg 的文档语义：每个 \ 写成 \\、每个 " 写成 \"；逆变换必须逐字符还原
    const esc = (s) => '"' + s.replace(new RegExp(BS + BS, "g"), BS + BS).replace(/"/g, BS + '"') + '"';
    const unesc = (s) => s.replace(new RegExp(BS + BS + "(.)", "g"), "$1");
    assert.strictEqual(batch, "put " + esc(winPath) + " " + esc(remote) + "\n");
    const args = batch.replace(/^put /, "").replace(/\n$/, "").split('" "');
    assert.strictEqual(args.length, 2, "batch should carry exactly two quoted args: " + batch);
    assert.strictEqual(unesc(args[0].slice(1)), winPath, "unescaped local arg must equal the input path");
    assert.strictEqual(unesc(args[1].slice(0, -1)), remote, "unescaped remote arg must equal the input path");
  });

  // ---- 真实 sftp 解析验证（用 `-D` 指定本地假 SFTP 服务端，不发起任何网络连接）----
  // 目的：证明 quoteBatchArg 的转义经**真实 sftp** 的 makeargv + glob 之后仍是原路径
  // （反斜杠不被吃掉），以及目标侧 `[`/`*` 不被 glob 影响（undo_glob_escape 往返）。
  // 镜像里没有 OpenSSH 客户端时跳过（不失败）。
  await t("真实 sftp：转义后的 Windows 形状路径往返精确、目标侧 [ 不被 glob（无 sftp 则 SKIP）", async () => {
    const BS = String.fromCharCode(92);
    const NL = String.fromCharCode(10);
    // 注意：必须用 **未注入 stub 的** PATH——本文件前面把假 sftp 放进了 PATH，
    // 直接 spawn("sftp") 会命中 stub 而不是真实客户端，这个用例就失去意义了。
    const realEnv = Object.assign({}, process.env, { PATH: origPath });
    const hasSftp = cp.spawnSync("sh", ["-c", "command -v sftp"], { encoding: "utf8", env: realEnv }).status === 0;
    if (!hasSftp) {
      console.log("SKIP  真实 sftp 用例：本镜像没有 sftp（需 openssh-client）——不计入断言");
      return;
    }
    const realDir = path.join(work, "real-sftp");
    fs.mkdirSync(realDir, { recursive: true });
    const fakeLog = path.join(realDir, "fake.log");
    const server = path.join(realDir, "fake-sftp.js");
    // 最小 SFTP v3 服务端：记录 OPEN 路径与 WRITE 数据（实现里刻意不用任何反斜杠字面量）
    fs.writeFileSync(
      server,
      "#!/usr/bin/env node" + NL +
      "const fs = require('node:fs');" + NL +
      "const log = process.env.FAKE_LOG;" + NL +
      "let buf = Buffer.alloc(0);" + NL +
      "const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };" + NL +
      "const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };" + NL +
      "const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]); };" + NL +
      "const pkt = (t, p) => Buffer.concat([u32(p.length + 1), Buffer.from([t]), p]);" + NL +
      "const st = (id, code) => pkt(101, Buffer.concat([u32(id), u32(code), str(''), str('')]));" + NL +
      "const name = (id, nm) => pkt(104, Buffer.concat([u32(id), u32(1), str(nm), str(nm), u32(5), u64(0), u32(0o040755)]));" + NL +
      "const rec = (o) => log && fs.appendFileSync(log, JSON.stringify(o) + String.fromCharCode(10));" + NL +
      "process.stdin.on('data', (d) => {" + NL +
      "  buf = Buffer.concat([buf, d]);" + NL +
      "  for (;;) {" + NL +
      "    if (buf.length < 4) return;" + NL +
      "    const len = buf.readUInt32BE(0);" + NL +
      "    if (buf.length < 4 + len) return;" + NL +
      "    const body = buf.slice(4, 4 + len); buf = buf.slice(4 + len);" + NL +
      "    const t = body[0], rid = body.readUInt32BE(1);" + NL +
      "    let o = 5;" + NL +
      "    const s = () => { const n = body.readUInt32BE(o); o += 4; const v = body.slice(o, o + n).toString('utf8'); o += n; return v; };" + NL +
      "    if (t === 1) { process.stdout.write(pkt(2, u32(3))); continue; }" + NL +
      "    if (t === 3) { const p = s(); rec({ op: 'OPEN', path: p }); process.stdout.write(pkt(102, Buffer.concat([u32(rid), str('h1')]))); continue; }" + NL +
      "    if (t === 6) { s(); o += 8; const n = body.readUInt32BE(o); o += 4; rec({ op: 'WRITE', data: body.slice(o, o + n).toString('utf8') }); process.stdout.write(st(rid, 0)); continue; }" + NL +
      "    if (t === 7 || t === 17) { s(); process.stdout.write(st(rid, 2)); continue; }" + NL +
      "    if (t === 8) { process.stdout.write(pkt(105, Buffer.concat([u32(rid), u32(5), u64(0), u32(0o100644)]))); continue; }" + NL +
      "    if (t === 16) { s(); process.stdout.write(name(rid, '/')); continue; }" + NL +
      "    if (t === 4 || t === 9 || t === 15) { process.stdout.write(st(rid, 0)); continue; }" + NL +
      "    rec({ op: 'UNHANDLED', t }); process.stdout.write(st(rid, 0));" + NL +
      "  }" + NL +
      "});" + NL,
      { mode: 0o755 }
    );
    const esc = (s) => '"' + s.replace(new RegExp(BS + BS, "g"), BS + BS).replace(/"/g, BS + '"') + '"';
    const runSftp = (batchLine) => {
      fs.writeFileSync(fakeLog, "");
      const bf = path.join(realDir, "run.batch");
      fs.writeFileSync(bf, batchLine + NL);
      const r = cp.spawnSync("sftp", ["-b", bf, "-D", server, "fakehost"], {
        encoding: "utf8",
        env: Object.assign({}, realEnv, { FAKE_LOG: fakeLog }),
      });
      const entries = fs
        .readFileSync(fakeLog, "utf8")
        .trim()
        .split(NL)
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      return {
        status: r.status,
        stderr: (r.stderr || "").trim(),
        opens: entries.filter((e) => e.op === "OPEN").map((e) => e.path),
        data: entries.filter((e) => e.op === "WRITE").map((e) => e.data).join(""),
        unhandled: entries.filter((e) => e.op === "UNHANDLED").map((e) => e.t),
      };
    };

    // (1) Windows 形状的本地路径（basename 里带反斜杠）：真实 sftp 必须解析回同一个文件
    const winPath = path.join(realDir, "C:" + BS + "Users" + BS + "me" + BS + "report.pdf");
    fs.writeFileSync(winPath, "WINPATH-OK");
    const a = runSftp("put " + esc(winPath) + " " + esc("/dest/win.bin"));
    assert.strictEqual(a.status, 0, "sftp should exit 0; stderr=" + a.stderr);
    assert.deepStrictEqual(a.opens, ["/dest/win.bin"], "destination must reach the server literally");
    assert.strictEqual(a.data, "WINPATH-OK", "the backslash path must resolve to the same file (no backslash eaten)");

    // (2) 反斜杠 + 空格：同样必须往返精确
    const mixed = path.join(realDir, "d" + BS + "e f.txt");
    fs.writeFileSync(mixed, "MIXED-OK");
    const b = runSftp("put " + esc(mixed) + " " + esc("/dest/mixed.bin"));
    assert.strictEqual(b.status, 0, "sftp should exit 0; stderr=" + b.stderr);
    assert.strictEqual(b.data, "MIXED-OK");

    // (3) 目标侧含 [ 与 *：undo_glob_escape 必须还原成字面路径（远端不被 glob 影响）
    const dst = path.join(realDir, "src.bin");
    fs.writeFileSync(dst, "DST-OK");
    const weirdDst = "/dest/a[1]*b.bin";
    const c = runSftp("put " + esc(dst) + " " + esc(weirdDst));
    assert.strictEqual(c.status, 0, "sftp should exit 0; stderr=" + c.stderr);
    assert.deepStrictEqual(c.opens, [weirdDst], "destination with [ and * must arrive literally (undo_glob_escape)");
    assert.strictEqual(c.data, "DST-OK");
    assert.deepStrictEqual(c.unhandled, [], "fake server should have handled every request");
  });

  // ---- pull -----------------------------------------------------------------
  await t("pull ssh 成功（新建）：get → 临时文件 → 原子 rename", async () => {
    const srcRemote = path.join(remoteDir, "pull-src.bin");
    fs.writeFileSync(srcRemote, victimContent);
    const dest = path.join(work, "pulled.bin");
    const before = logCount();
    const r = await pull({ path: dest, host: "testhost", remotePath: srcRemote, allowCreate: true });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.transport, "ssh");
    assert.strictEqual(r.action, "created");
    assert.strictEqual(r.sha256, victimSha);
    assert.strictEqual(r.size, victimContent.length);
    assert.strictEqual(fs.readFileSync(dest).toString("hex"), victimContent.toString("hex"));

    const logs = readStubLog(logFile);
    assert.strictEqual(logs.length, before + 1, "exactly one spawn");
    const last = logs[logs.length - 1];
    const b = last.batch.replace(/\n$/, "");
    assert.match(b, /^get "/);
    const m = b.match(/\.tmp-([0-9a-f]+)"$/);
    assert.ok(m, "batch should reference the temp file: " + b);
    assert.ok(b.endsWith('.tmp-' + m[1] + '"'));
    // 目录内无 tmp 残留
    const leftovers = fs.readdirSync(work).filter((n) => n.includes(".tmp-"));
    assert.strictEqual(leftovers.length, 0, "tmp files should be gone: " + leftovers);
  });

  await t("pull ssh 成功（覆盖）：expectedSha256 乐观锁", async () => {
    const dest = path.join(work, "overwrite.bin");
    fs.writeFileSync(dest, "old content bytes");
    const oldSha = sha(Buffer.from("old content bytes"));
    const srcRemote = path.join(remoteDir, "pull-src2.bin");
    fs.writeFileSync(srcRemote, victimContent);
    const r = await pull({ path: dest, host: "testhost", remotePath: srcRemote, expectedSha256: oldSha });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.action, "overwritten");
    assert.strictEqual(r.sha256, victimSha);
  });

  await t("pull ssh：覆盖缺 expectedSha256 被拒", async () => {
    const dest = path.join(work, "overwrite2.bin");
    fs.writeFileSync(dest, "old");
    const r = await pull({ path: dest, host: "testhost", remotePath: "/tmp/whatever" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /expectedSha256/);
  });

  await t("pull ssh：expectedSha256 不匹配被拒", async () => {
    const dest = path.join(work, "overwrite3.bin");
    fs.writeFileSync(dest, "old");
    const r = await pull({ path: dest, host: "testhost", remotePath: "/tmp/whatever", expectedSha256: "0".repeat(64) });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /mismatch/);
  });

  await t("pull ssh：新建缺 allowCreate 被拒", async () => {
    const r = await pull({ path: path.join(work, "new-pull.bin"), host: "testhost", remotePath: "/tmp/whatever" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /allowCreate/);
  });

  await t("pull ssh：remotePath 含空格与引号转义正确", async () => {
    const srcRemote = path.join(remoteDir, 'space "q" name.bin');
    fs.writeFileSync(srcRemote, victimContent);
    const dest = path.join(work, "pull-tricky.bin");
    const r = await pull({ path: dest, host: "testhost", remotePath: srcRemote, allowCreate: true });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(sha(fs.readFileSync(dest)), victimSha);
    const logs = readStubLog(logFile);
    const last = logs[logs.length - 1];
    assert.ok(last.batch.includes('\\"'), "batch should escape quotes: " + last.batch);
  });

  await t("pull ssh：remotePath 含 glob 元字符被拒（sftp 会展开远端源，可能静默取错文件）", async () => {
    const dest = path.join(work, "glob-pull.bin");
    for (const bad of ["/tmp/a[1].bin", "/tmp/a*b.bin", "/tmp/a?b.bin"]) {
      const before = logCount();
      const r = await pull({ path: dest, host: "testhost", remotePath: bad, allowCreate: true });
      assert.strictEqual(r.ok, false, bad + " should be rejected");
      assert.match(r.error, /glob metacharacters/);
      assert.strictEqual(logCount(), before, "must not spawn sftp for " + bad);
    }
    assert.strictEqual(fs.existsSync(dest), false);
  });

  await t("pull ssh：本地目标路径含 [ 不拦（目标侧不走 glob）", async () => {
    const srcRemote = path.join(remoteDir, "bracket-src.bin");
    fs.writeFileSync(srcRemote, victimContent);
    const dest = path.join(work, "dest[1].bin");
    const r = await pull({ path: dest, host: "testhost", remotePath: srcRemote, allowCreate: true });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(sha(fs.readFileSync(dest)), victimSha);
  });

  await t("pull ssh：expectedRemoteSha256 命中→成功；不匹配→拒绝且不落盘、不留 tmp", async () => {
    const srcRemote = path.join(remoteDir, "ers-src.bin");
    fs.writeFileSync(srcRemote, victimContent);

    const okDest = path.join(work, "ers-ok.bin");
    const ok = await pull({
      path: okDest, host: "testhost", remotePath: srcRemote, allowCreate: true, expectedRemoteSha256: victimSha,
    });
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));

    const badDest = path.join(work, "ers-bad.bin");
    const bad = await pull({
      path: badDest, host: "testhost", remotePath: srcRemote, allowCreate: true, expectedRemoteSha256: "0".repeat(64),
    });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /expectedRemoteSha256 mismatch/);
    assert.strictEqual(fs.existsSync(badDest), false, "must not create the target on hash mismatch");
    const leftovers = fs.readdirSync(work).filter((n) => n.includes(".tmp-"));
    assert.strictEqual(leftovers.length, 0, "tmp files should be gone: " + leftovers);
  });

  await t("push ssh：expectedRemoteSha256 无法兑现 → 显式拒绝（不再静默忽略）", async () => {
    const before = logCount();
    const r = await push({ path: victim, host: "testhost", remotePath: "/tmp/x", expectedRemoteSha256: victimSha });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /expectedRemoteSha256 is not supported/);
    assert.strictEqual(logCount(), before, "must not spawn sftp");
  });

  // ---- 故障路径 -------------------------------------------------------------
  await t("sftp 非零退出：stderr 截断回传、exitCode 保留", async () => {
    process.env.SFTP_STUB_MODE = "fail";
    try {
      const r = await push({ path: victim, host: "testhost", remotePath: "/tmp/x" });
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /exit code 1/);
      assert.strictEqual(r.exitCode, 1);
      assert.match(r.sftpStderr, /Permission denied \(publickey\)/);
    } finally {
      process.env.SFTP_STUB_MODE = "copy";
    }
  });

  await t("超时：sftp 被杀死、错误明确、tmp 被清理", async () => {
    process.env.SFTP_STUB_MODE = "hang";
    try {
      const dest = path.join(work, "hang-pull.bin");
      const before = logCount();
      const t0 = Date.now();
      const r = await pull({ path: dest, host: "testhost", remotePath: "/tmp/hang-src", allowCreate: true, timeoutMs: 5000 });
      const elapsed = Date.now() - t0;
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /timed out/);
      assert.strictEqual(r.timedOut, true);
      assert.ok(elapsed < 12000, "should resolve well under the hard ceiling, took " + elapsed + "ms");
      assert.strictEqual(fs.existsSync(dest), false, "dest must not exist after timeout");

      const logs = readStubLog(logFile);
      const hangEntry = logs[before];
      assert.ok(hangEntry, "stub should have logged");
      const gone = await waitPidGone(hangEntry.pid, 8000);
      assert.ok(gone, "stub pid should be dead after timeout (no zombie)");
      const leftovers = fs.readdirSync(work).filter((n) => n.includes(".tmp-"));
      assert.strictEqual(leftovers.length, 0, "tmp files should be cleaned: " + leftovers);
    } finally {
      process.env.SFTP_STUB_MODE = "copy";
    }
  });

  await t("sftp 可执行文件缺失：明确报错", async () => {
    const emptyDir = path.join(work, "empty-bin");
    fs.mkdirSync(emptyDir, { recursive: true });
    process.env.PATH = emptyDir;
    try {
      const r = await push({ path: victim, host: "testhost", remotePath: "/tmp/x" });
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /sftp executable not found|failed to start/);
    } finally {
      process.env.PATH = stubPath;
    }
  });

  await t("batch 文件写不进去：返回结构化错误而不是抛异常", async () => {
    const origTmp = process.env.TMPDIR;
    process.env.TMPDIR = path.join(work, "no-such-tmpdir");
    const before = logCount();
    try {
      const r = await push({ path: victim, host: "testhost", remotePath: "/tmp/x" });
      assert.strictEqual(r.ok, false, JSON.stringify(r));
      assert.match(r.error, /could not write the sftp batch file/);
      assert.strictEqual(logCount(), before, "must not spawn sftp when the batch file cannot be written");
    } finally {
      if (origTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = origTmp;
    }
  });

  await t("stderr 尾巴：父 stub 退出后子进程续写的 stderr 也要收到（等 stdio 关闭再收敛）", async () => {
    process.env.SFTP_STUB_MODE = "late";
    try {
      const t0 = Date.now();
      const r = await push({ path: victim, host: "testhost", remotePath: "/tmp/x" });
      const elapsed = Date.now() - t0;
      assert.strictEqual(r.ok, false, "result: " + JSON.stringify(r));
      assert.strictEqual(r.exitCode, 1, "result: " + JSON.stringify(r));
      assert.ok(
        r.sftpStderr.includes("LATE-TAIL-MARKER"),
        "stderr written after the sftp process exited must be captured, got: " + JSON.stringify(r.sftpStderr)
      );
      assert.ok(elapsed < 5000, "should settle right after stdio closes, took " + elapsed + "ms");
    } finally {
      process.env.SFTP_STUB_MODE = "copy";
    }
  });

  // ---- unload ---------------------------------------------------------------
  await plugin.onUnload();
  await t("unload: 清空全部注册", () => {
    assert.strictEqual(registered.size, 0);
  });

  fs.rmSync(work, { recursive: true, force: true });

  console.log("\n" + pass + " passed, " + fail + " failed");
  if (fail) {
    console.log(failures.join("\n"));
    process.exit(1);
  }
})();
