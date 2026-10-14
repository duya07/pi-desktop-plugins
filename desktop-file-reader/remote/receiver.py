#!/usr/bin/env python3
"""
一次性文件接收/发送端（仅标准库）。

用途：配合 desktop-file-reader 的 push/pull 直传。**0.5.0 起 push/pull 默认走 SSH（sftp）直传，
本脚本不是默认路径**——只有远端**已经存在**一个可达的 HTTP 文件端点时，才用 `mode:"http"` 配合它。
  - PUT/POST /push/<name>  → 落盘到 --dir（鉴权用 Authorization 头）
  - GET /pull/<name>       → 从 --dir 读取（同上）
  - 兼容：/push/<token>/<name> / /pull/<token>/<name> （token 在路径，易进日志，不推荐）
  - GET /health            → 健康检查

安全：
  - 推荐：一次性 token 走 `Authorization: Bearer <token>` 头（不进访问日志）
  - 兼容：token 放路径（会进访问日志，已做遮蔽，不推荐）
  - 路径白名单：仅 push/pull + health
  - 大小上限 --max-bytes（默认 50 MiB）
  - 超时由客户端控制，服务端仅限制 Content-Length
  - 凭据不进命令行：优先 --token-file / DFR_RECEIVER_TOKEN，--token 仅调试用（会出现在 ps）

用法（仅 `mode:"http"`；端点由调用方自己的环境提供，本插件不代为搭建）：
  # 远端（token 不进 ps；监听回环，不要绑公网）：
  #   umask 077 && openssl rand -hex 16 > /tmp/dfr.token
  #   python3 receiver.py --bind 127.0.0.1:9876 --dir /tmp/dfr --token-file /tmp/dfr.token
  # 插件：push_desktop_file_to_remote({ path, mode: "http", remoteUrl: "http://127.0.0.1:9876/push/file.bin", token: "<从 cat /tmp/dfr.token 取值>" })
  #
  # 若远端已有反代/网关指向该回环端口，remoteUrl 换成对应 https URL 即可（属于调用方既有环境，
  # 本文档不再给出任何“先让用户配一遍”的步骤——0.4.0 那套 ssh -L / 改反代的落地指引已被用户否决）。
  #
  # 不推荐：公网直连（需防火墙放行，暴露面大）
  #   umask 077 && openssl rand -hex 16 > /tmp/dfr.token
  #   python3 receiver.py --bind 0.0.0.0:8765 --dir /tmp/dfr --token-file /tmp/dfr.token

关闭：Ctrl-C 或 kill <pid>
回滚：不需要改任何系统配置，停掉进程即回滚。

注意：本脚本**不要**监听 0.0.0.0 除非你明确知道公网暴露风险。
"""

import argparse
import hashlib
import os
import posixpath
import stat
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

MAX_BODY_LOG = 4096


def parse_bind(s: str):
    if ":" not in s:
        raise ValueError("bind must be host:port")
    host, port_s = s.rsplit(":", 1)
    return host, int(port_s)


def load_token_from_file(path: str) -> str:
    """从文件读取 token，去首尾空白。"""
    with open(path, "r", encoding="utf-8") as f:
        return f.read().strip()


def resolve_token(args) -> tuple[str, str]:
    """
    解析 token，优先级：--token-file > DFR_RECEIVER_TOKEN > --token。
    返回 (token, source_desc) ，source_desc 用于横幅展示（如 "file /tmp/dfr.token"）。
    若 token 文件权限允许 group/other 读，则打印警告但不拒绝。
    """
    # 1. --token-file
    if getattr(args, "token_file", None):
        tf = args.token_file
        try:
            st = os.stat(tf)
            if st.st_mode & (stat.S_IRGRP | stat.S_IROTH):
                print(f"WARNING: token file {tf} is group/other readable (mode {oct(st.st_mode & 0o777)}); consider chmod 600", flush=True)
        except OSError as e:
            print(f"WARNING: cannot stat token file {tf}: {e}", flush=True)
        try:
            tok = load_token_from_file(tf)
        except OSError as e:
            raise SystemExit(f"failed to read --token-file {tf}: {e}")
        if not tok:
            print(f"WARNING: token file {tf} is empty", flush=True)
        return tok, f"file {tf}"
    # 2. env
    env_tok = os.environ.get("DFR_RECEIVER_TOKEN", "")
    if env_tok:
        # 去首尾空白，与文件保持一致
        env_tok = env_tok.strip()
        if env_tok:
            return env_tok, "env DFR_RECEIVER_TOKEN"
    # 3. --token（会出现在 ps，仅调试用）
    tok = getattr(args, "token", "") or ""
    if tok:
        return tok, "arg --token (visible in ps; debug only)"
    return "", "none"


class Handler(BaseHTTPRequestHandler):
    # 由 make_handler 注入
    config = None  # type: ignore

    def _redact_path(self, p: str) -> str:
        """遮蔽路径中的 token，避免日志泄露。"""
        cfg = self.config
        if cfg.token and cfg.token in p:
            return p.replace(cfg.token, "***")
        return p

    def log_message(self, fmt, *args):
        # 遮蔽 token：BaseHTTPRequestHandler 默认会把 requestline（含 URL）打到日志
        if args and isinstance(args[0], str):
            # requestline 形如 "PUT /push/<token>/file HTTP/1.1"
            redacted = self._redact_path(args[0])
            args = (redacted,) + args[1:]
        print("%s - - [%s] %s" % (self.client_address[0], self.log_date_time_string(), fmt % args), flush=True)

    def _check_auth(self) -> bool:
        cfg = self.config
        if not cfg.token:
            return True
        auth = self.headers.get("Authorization", "")
        # 期望 "Bearer <token>"
        if auth == "Bearer " + cfg.token:
            return True
        return False

    def _safe_name(self, raw: str) -> str | None:
        # 仅允许单级文件名，拒绝路径穿越
        name = posixpath.basename(raw)
        if not name or name in (".", ".."):
            return None
        # 拒绝包含 / 或 \
        if "/" in raw or "\\" in raw:
            # raw 已是单段，仍拒绝带斜杠的原始值
            if raw != name:
                return None
        # 拒绝隐藏的临时文件前缀
        if name.startswith("."):
            return None
        return name

    def do_GET(self):
        cfg = self.config
        parsed = urllib.parse.urlparse(self.path)
        p = parsed.path

        if p == "/health" or p == "/health/":
            body = b"ok " + cfg.dir.encode() + b"\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # /pull/<token>/<name> 或 /pull/<name>（无 token 模式）
        if p.startswith("/pull/"):
            rest = p[len("/pull/") :]
            if cfg.token:
                # 优先：路径 token 兼容；推荐：Authorization 头
                if rest.startswith(cfg.token + "/"):
                    raw_name = rest[len(cfg.token) + 1 :]
                elif self._check_auth():
                    raw_name = rest
                else:
                    self.send_error(401, "unauthorized")
                    return
            else:
                if not self._check_auth():
                    self.send_error(401, "unauthorized")
                    return
                raw_name = rest

            name = self._safe_name(raw_name)
            if not name:
                self.send_error(400, "invalid file name")
                return

            fpath = os.path.join(cfg.dir, name)
            if not os.path.isfile(fpath):
                self.send_error(404, "not found")
                return

            try:
                st = os.stat(fpath)
            except OSError as e:
                self.send_error(500, str(e))
                return

            if st.st_size > cfg.max_bytes:
                self.send_error(413, "file too large")
                return

            # 计算 sha256 供客户端校验（流式读一次）
            sha = hashlib.sha256()
            try:
                with open(fpath, "rb") as f:
                    for chunk in iter(lambda: f.read(1024 * 1024), b""):
                        sha.update(chunk)
            except OSError as e:
                self.send_error(500, str(e))
                return

            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(st.st_size))
            self.send_header("X-File-SHA256", sha.hexdigest())
            self.send_header("X-File-Name", name)
            self.end_headers()
            try:
                with open(fpath, "rb") as f:
                    for chunk in iter(lambda: f.read(1024 * 1024), b""):
                        self.wfile.write(chunk)
            except BrokenPipeError:
                pass
            return

        self.send_error(404, "not found")

    def do_PUT(self):
        self._handle_push()

    def do_POST(self):
        self._handle_push()

    def _handle_push(self):
        cfg = self.config
        parsed = urllib.parse.urlparse(self.path)
        p = parsed.path

        if not p.startswith("/push/"):
            self.send_error(404, "not found")
            return

        rest = p[len("/push/") :]
        # 鉴权：优先路径 token（兼容），推荐 Authorization 头
        raw_name = None
        if cfg.token:
            if rest.startswith(cfg.token + "/"):
                raw_name = rest[len(cfg.token) + 1 :]
            elif self._check_auth():
                raw_name = rest
            else:
                self.send_error(401, "unauthorized")
                return
        else:
            if not self._check_auth():
                self.send_error(401, "unauthorized")
                return
            raw_name = rest

        name = self._safe_name(raw_name or "")
        if not name:
            self.send_error(400, "invalid file name")
            return

        clen = self.headers.get("Content-Length")
        if clen is not None:
            try:
                n = int(clen)
            except ValueError:
                self.send_error(400, "invalid Content-Length")
                return
            if n > cfg.max_bytes:
                self.send_error(413, "payload too large")
                return
            if n < 0:
                self.send_error(400, "invalid Content-Length")
                return
        else:
            # 无 Content-Length 时仍限制为 max_bytes（边读边计数）
            n = None

        # 可选：客户端声明的 sha
        client_sha = self.headers.get("X-File-SHA256", "").strip().lower() or None
        if client_sha and not (len(client_sha) == 64 and all(c in "0123456789abcdef" for c in client_sha)):
            # 非致命，仅记录
            client_sha = None

        os.makedirs(cfg.dir, exist_ok=True)
        fpath = os.path.join(cfg.dir, name)
        tmp = fpath + ".tmp-" + os.urandom(6).hex()

        sha = hashlib.sha256()
        total = 0
        try:
            with open(tmp, "wb") as out:
                remaining = n
                while True:
                    if remaining is not None:
                        if remaining <= 0:
                            break
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                    else:
                        chunk = self.rfile.read(1024 * 1024)
                        if not chunk:
                            break

                    total += len(chunk)
                    if total > cfg.max_bytes:
                        out.close()
                        try:
                            os.unlink(tmp)
                        except OSError:
                            pass
                        self.send_error(413, "payload too large")
                        return
                    sha.update(chunk)
                    out.write(chunk)

                # 若声明了 Content-Length，需读满
                if n is not None and total != n:
                    out.close()
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass
                    self.send_error(400, "incomplete body: expected %d got %d" % (n, total))
                    return
        except OSError as e:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            self.send_error(500, str(e))
            return

        got_sha = sha.hexdigest()
        if client_sha and client_sha != got_sha:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            self.send_error(400, "X-File-SHA256 mismatch: expected %s got %s" % (client_sha, got_sha))
            return

        try:
            os.rename(tmp, fpath)
        except OSError as e:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            self.send_error(500, str(e))
            return

        body = ('{"ok":true,"name":"%s","size":%d,"sha256":"%s"}\n' % (name, total, got_sha)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-File-SHA256", got_sha)
        self.end_headers()
        self.wfile.write(body)


def make_handler(cfg):
    class CfgHandler(Handler):
        config = cfg

    return CfgHandler


def main():
    ap = argparse.ArgumentParser(description="desktop-file-reader 0.4.0 一次性 receiver")
    ap.add_argument("--bind", default="127.0.0.1:8765", help="host:port (default 127.0.0.1:8765)")
    ap.add_argument("--dir", default="/tmp/dfr", help="storage directory")
    ap.add_argument("--token", default="", help="bearer token (path and header); empty means no auth (only for mesh). WARNING: visible in ps output; use --token-file or DFR_RECEIVER_TOKEN instead (debug only)")
    ap.add_argument("--token-file", dest="token_file", default="", help="read bearer token from file (trimmed); warns if file is group/other readable. Takes precedence over DFR_RECEIVER_TOKEN and --token")
    ap.add_argument("--max-bytes", type=int, default=50 * 1024 * 1024, help="max file size (default 50MiB)")
    args = ap.parse_args()

    host, port = parse_bind(args.bind)
    token, token_source = resolve_token(args)
    # 将解析结果写回 args，供后续 Handler 使用
    args.token = token

    # 安全提示
    if host == "0.0.0.0" and not token:
        print("WARNING: listening on 0.0.0.0 without token — anyone can write!", flush=True)
    if host == "0.0.0.0":
        print("WARNING: 0.0.0.0 exposes to public internet; prefer 127.0.0.1 (via SSH -L) or <mesh-ip> (mesh)", flush=True)
    if token_source.startswith("arg --token"):
        print("WARNING: token via --token is visible in ps; prefer --token-file or DFR_RECEIVER_TOKEN", flush=True)

    os.makedirs(args.dir, exist_ok=True)
    # 横幅只打印掩码与来源，不得回显明文
    token_display = f"*** (from {token_source})" if token else "(none)"
    print(f"receiver listening on {host}:{port} dir={args.dir} token={token_display} max_bytes={args.max_bytes}", flush=True)
    print(f"  PUT /push/<name>  (Authorization: Bearer <token>) -> {args.dir}/<name>", flush=True)
    print(f"  GET /pull/<name>  (Authorization: Bearer <token>) -> {args.dir}/<name>", flush=True)
    print("  兼容：/push/<token>/<name> 与 /pull/<token>/<name>（会进日志，不推荐）", flush=True)
    print("  GET /health", flush=True)
    print(f"stop: kill {os.getpid()}", flush=True)

    handler = make_handler(args)
    httpd = HTTPServer((host, port), handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
