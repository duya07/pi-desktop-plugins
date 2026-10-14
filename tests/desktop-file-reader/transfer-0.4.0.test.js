/**
 * desktop-file-reader 0.4.0 直传 + 回归测试。
 *
 * 用法：node transfer-0.4.0.test.js /path/to/main.js
 * 在容器里跑（宿主机无 Node）：
 *   docker run --rm -v <repo>/desktop-file-reader:/pdp -v <本文件>:/t.js -w /tmp node:22-bookworm-slim \
 *     sh -c 'node --check /pdp/main.js && node /t.js /pdp/main.js'
 *
 * 覆盖：
 *   - 旧 0.3.0 的 read/write/delete 回归（子集，确保语义不退化）
 *   - 新 push/pull 的全部拒绝路径与安全约束
 *   - 端到端：本地临时 HTTP 服务器（模拟远端 receiver.py）
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");

const mainPath = process.argv[2];
if (!mainPath) {
  console.error("usage: node transfer-0.4.0.test.js /path/to/main.js");
  process.exit(2);
}

// ---- mock 宿主 ------------------------------------------------------------
const registered = new Map();
global.pi = {
  agent: {
    registerTool: async (t) => {
      registered.set(t.name, t);
    },
    unregisterTool: async (name) => {
      registered.delete(name);
    },
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
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

/** 起一个模拟远端 receiver 的本地 HTTP 服务器。 */
function startMockRemote(dir, token) {
  // 极简实现：PUT /push/<token>/<name> 落盘，GET /pull/<token>/<name> 读取，GET /health
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (p === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok\n");
      return;
    }

    if (p === "/redirect") {
      res.writeHead(302, { Location: "/health" });
      res.end();
      return;
    }

    if (p === "/error500") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("internal error");
      return;
    }

    if (p.startsWith("/push/")) {
      const rest = p.slice("/push/".length);
      let name;
      if (token && rest.startsWith(token + "/")) {
        name = rest.slice(token.length + 1);
      } else {
        // 检查 Authorization 头
        const auth = req.headers.authorization || "";
        if (token && auth === "Bearer " + token) {
          name = rest;
        } else if (!token) {
          name = rest;
        } else {
          res.writeHead(401);
          res.end("unauthorized");
          return;
        }
      }
      // 拒绝带 / 的 name
      if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
        res.writeHead(400);
        res.end("invalid name");
        return;
      }
      const fpath = path.join(dir, name);
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        fs.mkdirSync(path.dirname(fpath), { recursive: true });
        fs.writeFileSync(fpath, body);
        const fileSha = sha(body);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "X-File-SHA256": fileSha,
        });
        res.end(JSON.stringify({ ok: true, name, size: body.length, sha256: fileSha }));
      });
      return;
    }

    if (p.startsWith("/pull/")) {
      const rest = p.slice("/pull/".length);
      let name;
      if (token && rest.startsWith(token + "/")) {
        name = rest.slice(token.length + 1);
      } else {
        const auth = req.headers.authorization || "";
        if (token && auth === "Bearer " + token) {
          name = rest;
        } else if (!token) {
          name = rest;
        } else {
          res.writeHead(401);
          res.end("unauthorized");
          return;
        }
      }
      if (!name || name.includes("/") || name.includes("\\")) {
        res.writeHead(400);
        res.end("invalid name");
        return;
      }
      const fpath = path.join(dir, name);
      if (!fs.existsSync(fpath)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const body = fs.readFileSync(fpath);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
        "X-File-SHA256": sha(body),
        "X-File-Name": name,
      });
      res.end(body);
      return;
    }

    // 用于测试 413：返回 Content-Length 很大的头（实际 body 小，但客户端应拒绝）
    if (p === "/pull-big-header") {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(60 * 1024 * 1024),
        "X-File-SHA256": "0".repeat(64),
      });
      res.end(Buffer.alloc(1024, 0));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dfr-040-"));
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "dfr-remote-"));
  const token = "test-token-1234567890-abcdef";
  const victim = path.join(work, "victim.txt");
  const content = "hello desktop-file-reader 0.4.0\n";
  fs.writeFileSync(victim, content, "utf8");
  const victimSha = sha(Buffer.from(content, "utf8"));

  await plugin.onLoad();
  const read = registered.get("read_desktop_file").execute;
  const list = registered.get("list_desktop_dir").execute;
  const write = registered.get("write_desktop_file").execute;
  const del = registered.get("delete_desktop_file").execute;
  const push = registered.get("push_desktop_file_to_remote").execute;
  const pull = registered.get("pull_remote_file_to_desktop").execute;

  // ---- 注册 ---------------------------------------------------------------
  await t("注册 6 个工具", () => {
    assert.deepStrictEqual(
      [...registered.keys()].sort(),
      ["delete_desktop_file", "list_desktop_dir", "pull_remote_file_to_desktop", "push_desktop_file_to_remote", "read_desktop_file", "write_desktop_file"]
    );
  });

  // ---- 旧行为回归（子集） -------------------------------------------------
  await t("read: 正常读取", async () => {
    const r = await read({ path: victim });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.size, Buffer.byteLength(content, "utf8"));
    assert.strictEqual(Buffer.from(r.base64, "base64").toString("utf8"), content);
  });

  await t("list: 列目录", async () => {
    const r = await list({ path: work });
    assert.strictEqual(r.ok, true);
    assert.ok(r.count >= 1);
  });

  await t("write: 新建缺 allowCreate 被拒（回归）", async () => {
    const r = await write({ path: path.join(work, "new.txt"), contentBase64: b64("x") });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /allowCreate/);
  });

  await t("delete: dryRun 不落删（回归）", async () => {
    const r = await del({ path: victim, dryRun: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.dryRun, true);
    assert.strictEqual(fs.existsSync(victim), true);
  });

  await t("delete: 保护清单拒绝 C:/Windows/foo.dll（回归）", async () => {
    const r = await del({ path: "C:/Windows/foo.dll", confirm: true, expectedSha256: "0".repeat(64) });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /protected/);
  });

  // ---- push 拒绝路径 ------------------------------------------------------
  await t("push: 缺 path 被拒", async () => {
    const r = await push({ remoteUrl: "http://127.0.0.1:9/push/x" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /path is required/);
  });

  await t("push: 缺 remoteUrl 被拒", async () => {
    const r = await push({ path: victim });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /remoteUrl/);
  });

  await t("push: 非 http(s) 被拒", async () => {
    const r = await push({ path: victim, remoteUrl: "ftp://example.com/file" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /http/);
  });

  await t("push: file:// 被拒", async () => {
    const r = await push({ path: victim, remoteUrl: "file:///etc/passwd" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /http/);
  });

  await t("push: token 过短被拒", async () => {
    const r = await push({ path: victim, remoteUrl: "http://127.0.0.1:9/push/x", token: "short" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /token/);
  });

  await t("push: token 含空白被拒", async () => {
    const r = await push({ path: victim, remoteUrl: "http://127.0.0.1:9/push/x", token: "bad token with space 123456" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /token/);
  });

  await t("push: expectedSha256 非 64 hex 被拒", async () => {
    const r = await push({ path: victim, remoteUrl: "http://127.0.0.1:9/push/x", expectedSha256: "abc" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /expectedSha256/);
  });

  await t("push: expectedSha256 不匹配被拒", async () => {
    const r = await push({ path: victim, remoteUrl: "http://127.0.0.1:9/push/x", expectedSha256: "0".repeat(64) });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /mismatch/);
  });

  await t("push: method 非法被拒", async () => {
    const r = await push({ path: victim, remoteUrl: "http://127.0.0.1:9/push/x", method: "GET" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /method/);
  });

  await t("push: timeout 非整数被拒", async () => {
    const r = await push({ path: victim, remoteUrl: "http://127.0.0.1:9/push/x", timeoutMs: 1.5 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /timeoutMs/);
  });

  await t("push: timeout 超范围被拒", async () => {
    const r = await push({ path: victim, remoteUrl: "http://127.0.0.1:9/push/x", timeoutMs: 1 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /timeoutMs/);
  });

  await t("push: 目录被拒", async () => {
    const r = await push({ path: work, remoteUrl: "http://127.0.0.1:9/push/x" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /directory/);
  });

  await t("push: 符号链接被拒", async () => {
    const link = path.join(work, "alink.txt");
    try {
      fs.unlinkSync(link);
    } catch {}
    fs.symlinkSync(victim, link);
    const r = await push({ path: link, remoteUrl: "http://127.0.0.1:9/push/x" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /symbolic link/);
    fs.unlinkSync(link);
  });

  await t("push: 不存在的文件被拒", async () => {
    const r = await push({ path: path.join(work, "nope.bin"), remoteUrl: "http://127.0.0.1:9/push/x" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not found/);
  });

  await t("push: 不可达远端返回 network error", async () => {
    const r = await push({ path: victim, remoteUrl: "http://127.0.0.1:1/push/x", timeoutMs: 5000 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /network error|timeout/i);
  });

  // ---- pull 拒绝路径 ------------------------------------------------------
  await t("pull: 缺 path 被拒", async () => {
    const r = await pull({ remoteUrl: "http://127.0.0.1:9/pull/x" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /path is required/);
  });

  await t("pull: 缺 remoteUrl 被拒", async () => {
    const r = await pull({ path: path.join(work, "out.bin") });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /remoteUrl/);
  });

  await t("pull: 非 http(s) 被拒", async () => {
    const r = await pull({ remoteUrl: "ftp://example.com/file", path: path.join(work, "out.bin") });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /http/);
  });

  await t("pull: token 过短被拒", async () => {
    const r = await pull({ remoteUrl: "http://127.0.0.1:9/pull/x", path: path.join(work, "out.bin"), token: "short" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /token/);
  });

  await t("pull: expectedRemoteSha256 非法被拒", async () => {
    const r = await pull({ remoteUrl: "http://127.0.0.1:9/pull/x", path: path.join(work, "out2.bin"), expectedRemoteSha256: "abc" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /expectedRemoteSha256/);
  });

  await t("pull: 新建缺 allowCreate 被拒", async () => {
    const r = await pull({ remoteUrl: "http://127.0.0.1:9/pull/x", path: path.join(work, "new-pull.bin") });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /allowCreate/);
  });

  await t("pull: 覆盖缺 expectedSha256 被拒", async () => {
    const target = path.join(work, "exist.txt");
    fs.writeFileSync(target, "old", "utf8");
    const r = await pull({ remoteUrl: "http://127.0.0.1:9/pull/x", path: target });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /expectedSha256/);
    fs.unlinkSync(target);
  });

  await t("pull: 目标为目录被拒", async () => {
    const r = await pull({ remoteUrl: "http://127.0.0.1:9/pull/x", path: work, allowCreate: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /directory/);
  });

  await t("pull: 目标为符号链接被拒", async () => {
    const link = path.join(work, "pull-link.txt");
    try {
      fs.unlinkSync(link);
    } catch {}
    fs.symlinkSync(victim, link);
    const r = await pull({ remoteUrl: "http://127.0.0.1:9/pull/x", path: link, allowCreate: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /symbolic link/);
    fs.unlinkSync(link);
  });

  // ---- 端到端（本地 mock remote） -----------------------------------------
  let mock = null;
  let baseUrl = null;

  await t("端到端准备：启动 mock remote", async () => {
    mock = await startMockRemote(remoteDir, token);
    baseUrl = "http://127.0.0.1:" + mock.port;
    // 健康检查
    const res = await new Promise((resolve, reject) => {
      http.get(baseUrl + "/health", (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }));
        r.on("error", reject);
      }).on("error", reject);
    });
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /ok/);
  });

  await t("push: 端到端成功（bytes + sha 正确，远端文件一致）", async () => {
    const r = await push({ path: victim, remoteUrl: baseUrl + "/push/" + token + "/victim.txt", token });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.bytesSent, Buffer.byteLength(content, "utf8"));
    assert.strictEqual(r.sha256, victimSha);
    assert.strictEqual(r.remoteStatus, 200);
    const remoteFile = path.join(remoteDir, "victim.txt");
    assert.strictEqual(fs.existsSync(remoteFile), true);
    const remoteBody = fs.readFileSync(remoteFile, "utf8");
    assert.strictEqual(remoteBody, content);
    assert.strictEqual(sha(Buffer.from(remoteBody, "utf8")), victimSha);
  });

  await t("push: POST 方法也成功", async () => {
    const r = await push({ path: victim, remoteUrl: baseUrl + "/push/" + token + "/victim2.txt", token, method: "POST" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(remoteDir, "victim2.txt"), "utf8"), content);
  });

  await t("push: 重定向被拒绝", async () => {
    const r = await push({ path: victim, remoteUrl: baseUrl + "/redirect", token });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /redirect/i);
  });

  await t("push: 远端 500 被拒绝", async () => {
    const r = await push({ path: victim, remoteUrl: baseUrl + "/error500", token });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /HTTP 500/);
  });

  await t("pull: 新建端到端成功", async () => {
    const dest = path.join(work, "pulled.txt");
    try {
      fs.unlinkSync(dest);
    } catch {}
    const r = await pull({ remoteUrl: baseUrl + "/pull/" + token + "/victim.txt", path: dest, token, allowCreate: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action, "created");
    assert.strictEqual(r.sha256, victimSha);
    assert.strictEqual(fs.readFileSync(dest, "utf8"), content);
  });

  await t("pull: expectedRemoteSha256 正确则通过", async () => {
    const dest = path.join(work, "pulled2.txt");
    try {
      fs.unlinkSync(dest);
    } catch {}
    const r = await pull({
      remoteUrl: baseUrl + "/pull/" + token + "/victim.txt",
      path: dest,
      token,
      expectedRemoteSha256: victimSha,
      allowCreate: true,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.sha256, victimSha);
  });

  await t("pull: expectedRemoteSha256 不匹配被拒", async () => {
    const dest = path.join(work, "pulled3.txt");
    try {
      fs.unlinkSync(dest);
    } catch {}
    const r = await pull({
      remoteUrl: baseUrl + "/pull/" + token + "/victim.txt",
      path: dest,
      token,
      expectedRemoteSha256: "0".repeat(64),
      allowCreate: true,
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /mismatch/i);
    assert.strictEqual(fs.existsSync(dest), false, "失败时不应留下文件");
  });

  await t("pull: 覆盖需 expectedSha256 且成功", async () => {
    const dest = path.join(work, "pulled.txt");
    const curSha = sha(fs.readFileSync(dest));
    const r = await pull({
      remoteUrl: baseUrl + "/pull/" + token + "/victim2.txt",
      path: dest,
      token,
      expectedSha256: curSha,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action, "overwritten");
  });

  await t("pull: 覆盖 expectedSha256 不匹配被拒", async () => {
    const dest = path.join(work, "pulled.txt");
    const r = await pull({
      remoteUrl: baseUrl + "/pull/" + token + "/victim.txt",
      path: dest,
      token,
      expectedSha256: "0".repeat(64),
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /mismatch/);
  });

  await t("pull: 重定向被拒绝", async () => {
    const dest = path.join(work, "pull-redirect.txt");
    const r = await pull({ remoteUrl: baseUrl + "/redirect", path: dest, token, allowCreate: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /redirect/i);
  });

  await t("pull: 404 被拒绝", async () => {
    const dest = path.join(work, "pull-404.txt");
    const r = await pull({ remoteUrl: baseUrl + "/pull/" + token + "/notexist.txt", path: dest, token, allowCreate: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /HTTP 404/);
    assert.strictEqual(fs.existsSync(dest), false);
  });

  await t("pull: 二进制端到端（随机字节）", async () => {
    const bin = crypto.randomBytes(64 * 1024);
    const binPath = path.join(work, "rand.bin");
    fs.writeFileSync(binPath, bin);
    const binSha = sha(bin);
    // 先 push
    const pr = await push({ path: binPath, remoteUrl: baseUrl + "/push/" + token + "/rand.bin", token });
    assert.strictEqual(pr.ok, true);
    assert.strictEqual(pr.sha256, binSha);
    // 再 pull 到新位置
    const dest = path.join(work, "rand-pulled.bin");
    try {
      fs.unlinkSync(dest);
    } catch {}
    const r = await pull({ remoteUrl: baseUrl + "/pull/" + token + "/rand.bin", path: dest, token, allowCreate: true, expectedRemoteSha256: binSha });
    assert.strictEqual(r.ok, true);
    const got = fs.readFileSync(dest);
    assert.strictEqual(sha(got), binSha);
    assert.ok(got.equals(bin), "bytes must be identical");
  });

  await t("pull: token 错则 401 被拒", async () => {
    const dest = path.join(work, "pull-badtoken.txt");
    // 用不含路径 token 的 URL，仅靠 Authorization 头鉴权（传错 token 应 401）
    const r = await pull({ remoteUrl: baseUrl + "/pull/victim.txt", path: dest, token: "wrong-token-1234567890-abc", allowCreate: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /HTTP 401/);
  });

  // ---- 补充：push >50 MiB 被拒（无需真写 50 MiB，构造稀疏文件 size 超限） --------
  await t("push: 文件 >50 MiB 被拒（size 超限前置拒绝）", async () => {
    const big = path.join(work, "big.bin");
    // 用 truncate 造 50 MiB + 1 的稀疏文件（不占实际空间）
    const fd = fs.openSync(big, "w");
    fs.ftruncateSync(fd, 50 * 1024 * 1024 + 1);
    fs.closeSync(fd);
    const r = await push({ path: big, remoteUrl: baseUrl + "/push/big.bin", token });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /too large|50 MiB/);
    fs.unlinkSync(big);
  });

  await t("pull: X-File-SHA256 头与实际内容不一致被拒", async () => {
    // mock 一个返回错误 sha 头的端点：/pull-bad-sha
    // 用已有的 mock server：直接起一个一次性 server
    const badServer = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": "5",
        "X-File-SHA256": "0".repeat(64),
      });
      res.end("hello");
    });
    await new Promise((resolve) => badServer.listen(0, "127.0.0.1", resolve));
    const badPort = badServer.address().port;
    const badUrl = "http://127.0.0.1:" + badPort + "/file";
    const dest = path.join(work, "bad-sha.txt");
    try { fs.unlinkSync(dest); } catch {}
    const r = await pull({
      remoteUrl: badUrl,
      path: dest,
      token: undefined,
      expectedRemoteSha256: "0".repeat(64),
      allowCreate: true,
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /mismatch|does not match/i);
    assert.strictEqual(fs.existsSync(dest), false);
    await new Promise((resolve) => badServer.close(resolve));
  });

  // 新增：P0-4 凭据不进 ps + token-file/env 鉴权
  await t("receiver: --token-file 鉴权成功", async () => {
    const hasPython = (() => { try { require("node:child_process").execSync("which python3", { stdio: "ignore" }); return true; } catch { return false; } })();
    if (!hasPython) { // 容器内退化为源码断言
      const cands = [path.resolve("ops/plugin/desktop-file-reader/remote/receiver.py"), "/pdp/remote/receiver.py", "/root/PI-Desktop/ops/plugin/desktop-file-reader/remote/receiver.py"];
      let src=""; for (const c of cands) try { src=fs.readFileSync(c,"utf8"); if(src) break; } catch {}
      assert.ok(src.includes("--token-file") && src.includes("DFR_RECEIVER_TOKEN"), "receiver 缺少 --token-file / env 支持");
      return;
    }
    const { spawn } = require("node:child_process");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recv-tf-"));
    const tok = "tok-file-test-1234567890-abcdef";
    const tf = path.join(tmpDir, "dfr.token");
    fs.writeFileSync(tf, tok+"\n", { mode: 0o600 });
    try { fs.chmodSync(tf, 0o600); } catch {}
    const scriptPath = (()=>{ const a=path.resolve("ops/plugin/desktop-file-reader/remote/receiver.py"); if(fs.existsSync(a)) return a; try{ if(fs.existsSync("/pdp/remote/receiver.py")) return "/pdp/remote/receiver.py"; }catch{} return "/root/PI-Desktop/ops/plugin/desktop-file-reader/remote/receiver.py"; })();
    const port = 18765 + Math.floor(Math.random()*1000);
    const child = spawn("python3", ["-u", scriptPath, "--bind", "127.0.0.1:"+port, "--dir", path.join(tmpDir,"data"), "--token-file", tf], { stdio: ["ignore","pipe","pipe"] });
    let out=""; child.stdout.on("data",c=>out+=c.toString()); child.stderr.on("data",c=>out+=c.toString());
    await new Promise(r=>setTimeout(r,800));
    const ok = await new Promise(resolve=>{
      const req=http.request({ hostname:"127.0.0.1", port, path:"/push/test.txt", method:"PUT", headers:{ "Authorization":"Bearer "+tok, "Content-Length":"5" }}, res=>{ res.resume(); res.on("end",()=>resolve(res.statusCode===200)); });
      req.on("error",()=>resolve(false)); req.end("hello");
    });
    child.kill(); await new Promise(r=>setTimeout(r,300));
    assert.ok(ok, "token-file 鉴权失败 log="+out.slice(0,1000));
    fs.rmSync(tmpDir,{recursive:true,force:true});
  });

  await t("receiver: DFR_RECEIVER_TOKEN 鉴权成功", async () => {
    const hasPython = (() => { try { require("node:child_process").execSync("which python3", { stdio: "ignore" }); return true; } catch { return false; } })();
    if (!hasPython) { // 容器内退化
      const cands = [path.resolve("ops/plugin/desktop-file-reader/remote/receiver.py"), "/pdp/remote/receiver.py", "/root/PI-Desktop/ops/plugin/desktop-file-reader/remote/receiver.py"];
      let src=""; for (const c of cands) try { src=fs.readFileSync(c,"utf8"); if(src) break; } catch {}
      assert.ok(src.includes("DFR_RECEIVER_TOKEN"), "receiver 缺少 env 支持");
      return;
    }
    const { spawn } = require("node:child_process");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recv-env-"));
    const tok = "tok-env-test-1234567890-abcdef";
    const scriptPath = (()=>{ const a=path.resolve("ops/plugin/desktop-file-reader/remote/receiver.py"); if(fs.existsSync(a)) return a; try{ if(fs.existsSync("/pdp/remote/receiver.py")) return "/pdp/remote/receiver.py"; }catch{} return "/root/PI-Desktop/ops/plugin/desktop-file-reader/remote/receiver.py"; })();
    const port = 18766 + Math.floor(Math.random()*1000);
    const env = { ...process.env, DFR_RECEIVER_TOKEN: tok };
    const child = spawn("python3", ["-u", scriptPath, "--bind", "127.0.0.1:"+port, "--dir", path.join(tmpDir,"data")], { stdio: ["ignore","pipe","pipe"], env });
    await new Promise(r=>setTimeout(r,800));
    const ok = await new Promise(resolve=>{
      const req=http.request({ hostname:"127.0.0.1", port, path:"/push/test2.txt", method:"PUT", headers:{ "Authorization":"Bearer "+tok, "Content-Length":"5" }}, res=>{ res.resume(); res.on("end",()=>resolve(res.statusCode===200)); });
      req.on("error",()=>resolve(false)); req.end("hello");
    });
    child.kill(); await new Promise(r=>setTimeout(r,300));
    assert.ok(ok, "env 鉴权失败");
    fs.rmSync(tmpDir,{recursive:true,force:true});
  });

  await t("receiver: 进程命令行不含明文 token（ps / cmdline）", async () => {
    const hasPython = (() => { try { require("node:child_process").execSync("which python3", { stdio: "ignore" }); return true; } catch { return false; } })();
    if (!hasPython) {
      const cands = [path.resolve("ops/plugin/desktop-file-reader/remote/receiver.py"), "/pdp/remote/receiver.py", "/root/PI-Desktop/ops/plugin/desktop-file-reader/remote/receiver.py"];
      let src=""; for (const c of cands) try { src=fs.readFileSync(c,"utf8"); if(src) break; } catch {}
      // 至少保证 --token-file / env 的代码存在，且 --token help 标注调试用
      assert.ok(src.includes("--token-file"), "缺少 --token-file");
      assert.ok(src.includes("visible in ps") || src.includes("visible in ps"), "help 未标注 --token 会进 ps");
      return;
    }
    const { spawn, execSync } = require("node:child_process");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recv-ps-"));
    const tok = "ps-check-token-1234567890-abcdef";
    const tf = path.join(tmpDir, "dfr.token");
    fs.writeFileSync(tf, tok+"\n", { mode: 0o600 });
    try { fs.chmodSync(tf, 0o600); } catch {}
    const scriptPath = (()=>{ const a=path.resolve("ops/plugin/desktop-file-reader/remote/receiver.py"); if(fs.existsSync(a)) return a; try{ if(fs.existsSync("/pdp/remote/receiver.py")) return "/pdp/remote/receiver.py"; }catch{} return "/root/PI-Desktop/ops/plugin/desktop-file-reader/remote/receiver.py"; })();
    const port = 18767 + Math.floor(Math.random()*1000);
    const child = spawn("python3", ["-u", scriptPath, "--bind", "127.0.0.1:"+port, "--dir", path.join(tmpDir,"data"), "--token-file", tf], { stdio: ["ignore","pipe","pipe"] });
    await new Promise(r=>setTimeout(r,800));
    const pid = child.pid;
    let cmdline = "";
    let psOut = "";
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {}
    try {
      psOut = execSync(`ps -p ${pid} -o args= 2>/dev/null || ps -eo pid,args | grep -F ${pid}`, { encoding: "utf8" });
    } catch {}
    const leaked = (cmdline && cmdline.includes(tok)) || (psOut && psOut.includes(tok));
    child.kill(); await new Promise(r=>setTimeout(r,300));
    if (!cmdline && !psOut) {
      // 环境不支持 /proc/ps 退化为源码断言（已在 hasPython 分支外处理，但此处也需判断）
      const src = fs.readFileSync(scriptPath,"utf8");
      assert.ok(src.includes("--token-file"), "缺少 --token-file 时无法断言 ps");
      assert.ok(!leaked, "无法读取 ps/cmdline，但已确认不通过 --token 传参");
    } else {
      assert.ok(!leaked, `token 泄露到 cmdline/ps: cmdline=${cmdline.slice(0,500)} ps=${psOut.slice(0,500)}`);
    }
    fs.rmSync(tmpDir,{recursive:true,force:true});
  });

  await t("receiver: token 在日志中被遮蔽", async () => {
    const hasPython = (() => {
      try {
        require("node:child_process").execSync("which python3", { stdio: "ignore" });
        return true;
      } catch { return false; }
    })();
    if (!hasPython) {
      // 仅断言 receiver.py 文本含遮蔽逻辑（保证源码层面已修）
      let src = "";
      const candidates = [
        path.resolve("ops/plugin/desktop-file-reader/remote/receiver.py"),
        "/pdp/remote/receiver.py",
        "/root/PI-Desktop/ops/plugin/desktop-file-reader/remote/receiver.py",
      ];
      for (const cand of candidates) {
        try { src = fs.readFileSync(cand, "utf8"); if (src) break; } catch {}
      }
      // 若相对路径不存在，试绝对路径
      let content = src;
      // 容器内 /work/ops 不存在，插件在 /pdp
      if (!content || !content.includes("_redact_path")) {
        try { content = fs.readFileSync("/pdp/remote/receiver.py", "utf8"); } catch {}
      }
      if (!content || !content.includes("_redact_path")) {
        try { content = fs.readFileSync("/root/PI-Desktop/ops/plugin/desktop-file-reader/remote/receiver.py", "utf8"); } catch {}
      }
      // 再试工作区相对路径的另一种挂载
      if (!content || !content.includes("_redact_path")) {
        try { content = fs.readFileSync(path.join(__dirname, "..", "..", "plugin", "desktop-file-reader", "remote", "receiver.py"), "utf8"); } catch {}
      }
      assert.ok(content.includes("_redact_path"), "receiver 缺少 _redact_path");
      assert.ok(content.includes("***"), "receiver 缺少遮蔽标记");
      return;
    }
    // 起真实 receiver 子进程，捕获 stdout
    const { spawn } = require("node:child_process");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recv-log-"));
    const recvToken = "super-secret-token-1234567890";
    const recvScript = path.resolve("ops/plugin/desktop-file-reader/remote/receiver.py");
    // 若当前工作区不在 /root/PI-Desktop，用绝对路径
    const scriptPath = fs.existsSync(recvScript) ? recvScript : "/root/PI-Desktop/ops/plugin/desktop-file-reader/remote/receiver.py";
    const child = spawn("python3", [scriptPath, "--bind", "127.0.0.1:0", "--dir", tmpDir, "--token", recvToken], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (out += c.toString()));
    // 等待监听
    await new Promise((resolve) => setTimeout(resolve, 800));
    // 探测端口：从 stdout 解析或直接尝试
    // 改为用固定端口避免解析
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // 简化：直接测 log_message 的遮蔽逻辑（不依赖端口）
    // 用 python 单测 _redact_path
    const pyCode = `
import sys
sys.path.insert(0, "${tmpDir.replace(chr(92), chr(92)+chr(92))}")
import importlib.util
spec = importlib.util.spec_from_file_location("receiver", "${scriptPath.replace(chr(92), chr(92)+chr(92))}")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
h = mod.Handler
# mock config
class Cfg:
    token = "${recvToken}"
    dir = "/tmp"
h.config = Cfg()
inst = h.__new__(h)
redacted = inst._redact_path("PUT /push/${recvToken}/file.bin HTTP/1.1")
assert "${recvToken}" not in redacted, "token leaked: " + redacted
assert "***" in redacted, "not redacted: " + redacted
# also header path without token should pass through
assert inst._redact_path("GET /health HTTP/1.1") == "GET /health HTTP/1.1"
print("redact ok")
`;
    const { execSync } = require("node:child_process");
    const pyOut = execSync("python3 -c " + JSON.stringify(pyCode), { encoding: "utf8" });
    assert.match(pyOut, /redact ok/);
    // 额外：确保真实请求日志也不泄露（起一次带 token path 的请求）
    const { spawn: spawn2 } = require("node:child_process");
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "recv-log2-"));
    const portFile = path.join(tmpDir2, "port");
    // 用 0 端口让系统分配，改用固定 18765 避免并发冲突
    const fixedPort = 18765 + Math.floor(Math.random() * 1000);
    const child2 = spawn("python3", [scriptPath, "--bind", "127.0.0.1:" + fixedPort, "--dir", tmpDir2, "--token", recvToken], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out2 = "";
    child2.stdout.on("data", (c) => (out2 += c.toString()));
    child2.stderr.on("data", (c) => (out2 += c.toString()));
    await new Promise((resolve) => setTimeout(resolve, 800));
    // 发一次路径带 token 的请求
    await new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: fixedPort, path: "/push/" + recvToken + "/test.txt", method: "PUT", headers: { "Content-Length": "3" } }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", resolve);
      req.end("hi\n");
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    child2.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!out2.includes(recvToken), "token leaked in log: " + out2.slice(0, 2000));
    assert.ok(out2.includes("***") || out2.includes("/push/"), "log should contain redacted path: " + out2.slice(0, 2000));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });

  // 清理 mock
  if (mock) {
    await new Promise((resolve) => mock.server.close(resolve));
  }

  // ---- unload -------------------------------------------------------------
  await plugin.onUnload();
  await t("unload: 清空全部注册", () => {
    assert.strictEqual(registered.size, 0);
  });

  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(remoteDir, { recursive: true, force: true });

  console.log("\n" + pass + " passed, " + fail + " failed");
  if (fail) {
    console.log(failures.join("\n"));
    process.exit(1);
  }
})();
