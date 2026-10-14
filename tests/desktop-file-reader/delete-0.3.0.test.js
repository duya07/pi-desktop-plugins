/**
 * desktop-file-reader 0.3.0 隔离运行时测试。
 *
 * 用法：node delete-0.3.0.test.js /path/to/main.js
 * 在容器里跑（宿主机无 Node）：
 *   docker run --rm -v <repo>/desktop-file-reader:/pdp -v <本文件>:/t.js -w /tmp node:22-bookworm-slim \
 *     sh -c 'node --check /pdp/main.js && node /t.js /pdp/main.js'
 *
 * 只 mock 宿主 API（pi.agent.*），文件操作全部打在 os.tmpdir() 下的真实文件上。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const mainPath = process.argv[2];
if (!mainPath) {
  console.error("usage: node delete-0.3.0.test.js /path/to/main.js");
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
    failures.push(name + " :: " + e.message);
    console.log("FAIL  " + name + " :: " + e.message);
  }
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dfr-"));
  const victim = path.join(work, "victim.txt");
  const content = "hello desktop-file-reader 0.3.0\n";
  fs.writeFileSync(victim, content, "utf8");
  const victimSha = sha(Buffer.from(content, "utf8"));
  const victimSize = Buffer.byteLength(content, "utf8");

  const subdir = path.join(work, "adir");
  fs.mkdirSync(subdir);
  const linkPath = path.join(work, "alink.txt");
  fs.symlinkSync(victim, linkPath);

  await plugin.onLoad();
  const read = registered.get("read_desktop_file").execute;
  const list = registered.get("list_desktop_dir").execute;
  const write = registered.get("write_desktop_file").execute;
  const del = registered.get("delete_desktop_file").execute;

  // ---- 注册 ---------------------------------------------------------------
  // 0.4.0 起新增 2 个直传工具，旧测试仅校验旧 4 个仍存在（不做精确等式，避免因新增工具误判回归失败）
  await t("注册 4 个工具", () => {
    const expectedOld = ["delete_desktop_file", "list_desktop_dir", "read_desktop_file", "write_desktop_file"];
    for (const k of expectedOld) assert.ok(registered.has(k), "missing " + k);
    // 0.4.0 新增：若为新版，顺带校验新工具也已注册
    if (registered.size === 6) {
      assert.ok(registered.has("push_desktop_file_to_remote"));
      assert.ok(registered.has("pull_remote_file_to_desktop"));
    } else {
      assert.strictEqual(registered.size, 4);
    }
  });

  // ---- read 回归 ----------------------------------------------------------
  await t("read: 正常读取（ok/size/eof/base64 一致）", async () => {
    const r = await read({ path: victim });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.size, victimSize);
    assert.strictEqual(r.eof, true);
    assert.strictEqual(Buffer.from(r.base64, "base64").toString("utf8"), content);
  });

  await t("read: 分块（offset/length 拼回原内容）", async () => {
    const a = await read({ path: victim, offset: 0, length: 6 });
    const b = await read({ path: victim, offset: 6, length: 1024 });
    assert.strictEqual(a.eof, false);
    assert.strictEqual(b.eof, true);
    const joined = Buffer.from(a.base64, "base64").toString("utf8") + Buffer.from(b.base64, "base64").toString("utf8");
    assert.strictEqual(joined, content);
  });

  await t("list: 列目录（目录排在文件前）", async () => {
    const r = await list({ path: work });
    assert.strictEqual(r.ok, true);
    assert.ok(r.count >= 3);
    assert.strictEqual(r.entries[0].dir, true);
  });

  // ---- write 回归 ---------------------------------------------------------
  const newFile = path.join(work, "created.txt");

  await t("write: 新建缺 allowCreate 被拒", async () => {
    const r = await write({ path: newFile, contentBase64: b64("x") });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /allowCreate/);
  });

  await t("write: 新建成功且 after.sha256 正确", async () => {
    const r = await write({ path: newFile, contentBase64: b64("abc"), allowCreate: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action, "created");
    assert.strictEqual(r.after.sha256, sha(Buffer.from("abc", "utf8")));
  });

  await t("write: 覆盖缺 expectedSha256 被拒", async () => {
    const r = await write({ path: newFile, contentBase64: b64("zzz") });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /expectedSha256/);
  });

  await t("write: 覆盖 sha 不匹配被拒", async () => {
    const r = await write({ path: newFile, contentBase64: b64("zzz"), expectedSha256: "0".repeat(64) });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /mismatch/);
  });

  await t("write: 覆盖成功", async () => {
    const cur = sha(Buffer.from("abc", "utf8"));
    const r = await write({ path: newFile, contentBase64: b64("abcd"), expectedSha256: cur });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action, "overwritten");
  });

  // ---- delete：第 1 道门（保护清单） --------------------------------------
  const protectedCases = [
    ["盘根 C:/", "C:/"],
    ["盘根 C:\\", "C:\\"],
    ["盘根 /", "/"],
    ["C:/Windows/system32/foo.dll", "C:/Windows/system32/foo.dll"],
    ["C:/Program Files/app/x.txt", "C:/Program Files/app/x.txt"],
    ["C:/Program Files (x86)/app/x.txt", "C:/Program Files (x86)/app/x.txt"],
    ["C:/ProgramData/x.txt", "C:/ProgramData/x.txt"],
    ["C:/Users/me/.ssh/id_rsa", "C:/Users/me/.ssh/id_rsa"],
    ["C:/Users/me/.gnupg/secring.gpg", "C:/Users/me/.gnupg/secring.gpg"],
    ["C:/Users/me/.aws/credentials", "C:/Users/me/.aws/credentials"],
    ["C:/Users/me/.pi-desktop/plugins/registry.json", "C:/Users/me/.pi-desktop/plugins/registry.json"],
    ["C:/pagefile.sys", "C:/pagefile.sys"],
    ["C:/hiberfil.sys", "C:/hiberfil.sys"],
    ["C:/swapfile.sys", "C:/swapfile.sys"],
    ["C:/bootmgr", "C:/bootmgr"],
    ["C:/$MFT", "C:/$MFT"],
  ];
  for (const [label, p] of protectedCases) {
    await t("delete: 保护清单拒绝 " + label, async () => {
      const r = await del({ path: p, confirm: true, expectedSha256: "0".repeat(64) });
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /protected|filesystem root/);
    });
  }

  await t("delete: 保护清单不误伤同名普通目录 C:/Users/me/Windows/notes.txt", async () => {
    const r = await del({ path: "C:/Users/me/Windows/notes.txt", confirm: true, expectedSize: 1 });
    assert.strictEqual(r.ok, false);
    assert.doesNotMatch(r.error, /protected/);
  });

  // ---- delete：第 2 道门（类型） ------------------------------------------
  await t("delete: 空 path 被拒", async () => {
    const r = await del({ path: "" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /path is required/);
  });

  await t("delete: 不存在的路径被拒（不静默成功）", async () => {
    const r = await del({ path: path.join(work, "nope.txt"), confirm: true, expectedSize: 1 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /does not exist/);
  });

  await t("delete: 目录被拒（不做递归）", async () => {
    const r = await del({ path: subdir, confirm: true, expectedSize: 1 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /directory/);
  });

  await t("delete: 符号链接被拒（不跟随）", async () => {
    const r = await del({ path: linkPath, confirm: true, expectedSize: 1 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /symbolic link/);
    assert.strictEqual(fs.existsSync(victim), true, "链接目标不应被删");
  });

  // ---- delete：第 3 道门（confirm） ---------------------------------------
  await t("delete: 缺 confirm 被拒", async () => {
    const r = await del({ path: victim, expectedSha256: victimSha });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /confirm/);
  });

  await t("delete: confirm 为字符串 'true' 也被拒（严格布尔）", async () => {
    const r = await del({ path: victim, confirm: "true", expectedSha256: victimSha });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /confirm/);
  });

  // ---- delete：第 4 道门（内容绑定） --------------------------------------
  await t("delete: 既无 expectedSha256 也无 expectedSize 被拒", async () => {
    const r = await del({ path: victim, confirm: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /expectedSha256 .*or expectedSize/);
  });

  await t("delete: expectedSha256 非 64 位 hex 被拒", async () => {
    const r = await del({ path: victim, confirm: true, expectedSha256: "abc" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /64 hex/);
  });

  await t("delete: expectedSha256 不匹配被拒", async () => {
    const r = await del({ path: victim, confirm: true, expectedSha256: "0".repeat(64) });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /mismatch/);
  });

  await t("delete: expectedSize 不匹配被拒", async () => {
    const r = await del({ path: victim, confirm: true, expectedSize: victimSize + 1 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /expectedSize mismatch/);
  });

  await t("delete: expectedSize 非整数被拒", async () => {
    const r = await del({ path: victim, confirm: true, expectedSize: 1.5 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /non-negative integer/);
  });

  await t("delete: dryRun 只预演，文件仍在", async () => {
    const r = await del({ path: victim, dryRun: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.dryRun, true);
    assert.strictEqual(r.wouldDelete.size, victimSize);
    assert.strictEqual(fs.existsSync(victim), true);
  });

  // ---- delete：正常路径 ---------------------------------------------------
  await t("delete: 用 expectedSha256 成功删除（before 正确 + verifiedGone）", async () => {
    const target = path.join(work, "del-sha.txt");
    fs.writeFileSync(target, content, "utf8");
    const r = await del({ path: target, confirm: true, expectedSha256: victimSha });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.deleted, true);
    assert.strictEqual(r.verifiedGone, true);
    assert.strictEqual(r.before.sha256, victimSha);
    assert.strictEqual(fs.existsSync(target), false);
  });

  await t("delete: 用 expectedSize 成功删除（大文件路径）", async () => {
    const target = path.join(work, "del-size.bin");
    fs.writeFileSync(target, Buffer.alloc(4096, 7));
    const r = await del({ path: target, confirm: true, expectedSize: 4096 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.before.sha256, null, "只给 size 时不算 sha");
    assert.strictEqual(fs.existsSync(target), false);
  });

  await t("delete: sha 与 size 同时给出且都匹配 → 成功", async () => {
    const target = path.join(work, "del-both.txt");
    fs.writeFileSync(target, content, "utf8");
    const r = await del({ path: target, confirm: true, expectedSha256: victimSha, expectedSize: victimSize });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.verifiedGone, true);
    assert.strictEqual(fs.existsSync(target), false);
  });

  await t("delete: 删除后文件确实消失（目录条目减少）", async () => {
    const before = (await list({ path: work })).count;
    const target = path.join(work, "del-count.txt");
    fs.writeFileSync(target, "z", "utf8");
    await del({ path: target, confirm: true, expectedSize: 1 });
    const after = (await list({ path: work })).count;
    assert.strictEqual(after, before);
  });

  // ---- unload -------------------------------------------------------------
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
