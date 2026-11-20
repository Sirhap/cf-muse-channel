#!/usr/bin/env python3
"""Cloudflare Workers 并发部署、防驻留回收、安全 DO 即时切版与健康验收脚本。

核心优化：
1. 强制设置 WRANGLER_HIDE_BANNER=true 与 WRANGLER_SEND_METRICS=false，从根源跳过
   printWranglerBanner() -> updateCheck() 对 registry.npmjs.org 的未释放后台请求。
2. 支持多份 Wrangler 配置并发部署（ThreadPoolExecutor），将总耗时从 T1+T2 压缩至 max(T1, T2)。
3. 流式监控 Wrangler 输出：一旦捕获 Current Version ID（或 --dry-run 完成标志），
   仅等待极短宽限期（默认 2.0 秒）即自动终止残留 Node 进程，彻底杜绝部署后挂死。
4. 可选安全 immediate DO 切版：切版前先检查 /admin/managed/status 在途任务与待投递队列，
   绝不强杀正在执行的任务或投递；支持部署后自动 /health 与托管状态验收。
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
from typing import Any, Callable, Iterable, Mapping
import urllib.error
import urllib.request

try:
    from curl_cffi import requests as curl_requests  # type: ignore
except Exception:  # pragma: no cover - 无 curl_cffi 时平滑降级到标准库
    curl_requests = None

ROOT = Path(__file__).resolve().parents[1]
PROXY_ENV_KEYS = (
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
)
VERSION_ID_RE = re.compile(r"Current Version ID:\s*([0-9a-fA-F-]{36})")
UPLOADED_RE = re.compile(r"Uploaded\s+.+?\(([\d.]+\s*sec)\)")
DEPLOYED_TRIGGERS_RE = re.compile(r"Deployed\s+.+?\s+triggers\s*\(([\d.]+\s*sec)\)")
BEARER_REDACT_RE = re.compile(r"(Bearer\s+)[^\s\"',;]+", re.IGNORECASE)
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


@dataclass(frozen=True)
class WranglerTarget:
    """解析后的 Wrangler 部署目标元数据。"""

    config_path: Path
    name: str
    account_id: str | None = None
    custom_domain: str | None = None
    owns_managed_do: bool = False
    owns_credentials_do: bool = False


@dataclass
class DeployResult:
    """单个 Worker 的部署执行结果。"""

    name: str
    config_path: str
    ok: bool
    elapsed_sec: float
    version_id: str | None = None
    upload_time: str | None = None
    triggers_time: str | None = None
    terminated_hanging_process: bool = False
    dry_run: bool = False
    error: str | None = None
    output_tail: list[str] = field(default_factory=list)


@dataclass
class ImmediateResult:
    """单个 Worker 的 immediate DO 代码切版结果。"""

    name: str
    ok: bool
    skipped: bool
    elapsed_sec: float
    version_id: str | None = None
    mode: str = "settled"
    reason: str | None = None


@dataclass
class VerifyResult:
    """单个 Worker 的线上健康检查结果。"""

    name: str
    origin: str
    ok: bool
    elapsed_sec: float
    health_ok: bool = False
    managed_checked: bool = False
    runtime_version: str | None = None
    enabled_channels: int = 0
    active_tasks: int = 0
    pending_outbound: int = 0
    last_pump_error: str | None = None
    error: str | None = None


def strip_jsonc(raw: str) -> str:
    """安全剥离 JSONC 字符串字面量之外的 // 行注释、/* */ 块注释与末尾多余逗号。"""
    out: list[str] = []
    i = 0
    n = len(raw)
    in_string = False
    escape = False

    while i < n:
        ch = raw[i]
        if in_string:
            out.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            i += 1
            continue

        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue

        if ch == "/" and i + 1 < n and raw[i + 1] == "/":
            i += 2
            while i < n and raw[i] not in ("\n", "\r"):
                i += 1
            continue

        if ch == "/" and i + 1 < n and raw[i + 1] == "*":
            i += 2
            while i + 1 < n and not (raw[i] == "*" and raw[i + 1] == "/"):
                i += 1
            i += 2
            continue

        out.append(ch)
        i += 1

    without_comments = "".join(out)
    # 剥离对象或数组闭合前的尾随逗号（仅匹配非字符串闭合符号前）
    return _strip_trailing_commas(without_comments)


def _strip_trailing_commas(text: str) -> str:
    """在不破坏字符串字面量的前提下移除 JSON 尾随逗号。"""
    chars = list(text)
    in_string = False
    escape = False
    n = len(chars)
    i = 0
    while i < n:
        ch = chars[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            i += 1
            continue
        if ch == ",":
            j = i + 1
            while j < n and chars[j] in (" ", "\t", "\r", "\n"):
                j += 1
            if j < n and chars[j] in ("}", "]"):
                chars[i] = ""
        i += 1
    return "".join(chars)


def load_wrangler_config(path: Path) -> WranglerTarget:
    """加载并解析 Wrangler JSON/JSONC 配置文件。"""
    resolved = path.resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"配置文件不存在: {path}")
    data = json.loads(strip_jsonc(resolved.read_text(encoding="utf-8")))
    name = str(data.get("name") or "").strip()
    if not name:
        raise ValueError(f"配置文件缺少有效的 name 字段: {path}")
    account_id = data.get("account_id")
    account_str = str(account_id).strip() if account_id else None

    custom_domain: str | None = None
    routes = data.get("routes")
    if isinstance(routes, list):
        for item in routes:
            if isinstance(item, dict) and item.get("custom_domain") and item.get("pattern"):
                custom_domain = str(item["pattern"]).strip()
                break
        if not custom_domain:
            for item in routes:
                if isinstance(item, dict) and item.get("pattern"):
                    pattern = str(item["pattern"]).strip().split("/")[0]
                    if pattern and "*" not in pattern:
                        custom_domain = pattern
                        break

    bindings = data.get("durable_objects", {}).get("bindings", [])
    owns_managed_do = False
    owns_credentials_do = False
    if isinstance(bindings, list):
        for binding in bindings:
            if not isinstance(binding, dict):
                continue
            if binding.get("script_name"):
                continue
            cls = binding.get("class_name")
            if cls == "ManagedChannels":
                owns_managed_do = True
            elif cls == "MuseCredentials":
                owns_credentials_do = True

    return WranglerTarget(
        config_path=resolved,
        name=name,
        account_id=account_str,
        custom_domain=custom_domain,
        owns_managed_do=owns_managed_do,
        owns_credentials_do=owns_credentials_do,
    )


def build_wrangler_env(
    base_env: Mapping[str, str] | None = None,
    *,
    keep_proxy: bool = False,
) -> dict[str, str]:
    """构造净化的 Wrangler 子进程运行环境变量。"""
    env = dict(os.environ if base_env is None else base_env)
    if not keep_proxy:
        for key in PROXY_ENV_KEYS:
            env.pop(key, None)
    env["WRANGLER_HIDE_BANNER"] = "true"
    env["WRANGLER_SEND_METRICS"] = "false"
    env["CI"] = "true"
    return env


def redact_sensitive(text: str, secrets: Iterable[str] = ()) -> str:
    """对输出文本或错误摘要进行敏感凭证脱敏。"""
    if not text:
        return text
    cleaned = BEARER_REDACT_RE.sub(r"\1[REDACTED]", text)
    for secret in secrets:
        token = (secret or "").strip()
        if len(token) >= 6 and token in cleaned:
            cleaned = cleaned.replace(token, "[REDACTED]")
    return cleaned


def resolve_wrangler_command(root: Path = ROOT) -> list[str]:
    """优先定位项目本地 node_modules 中的 Wrangler CLI。"""
    local_cli = root / "node_modules" / "wrangler" / "wrangler-dist" / "cli.js"
    if local_cli.is_file():
        return ["node", str(local_cli)]
    return ["npx", "wrangler"]


def _terminate_process(proc: subprocess.Popen[str]) -> None:
    """优雅终止子进程，超时未退则强制 kill。"""
    if proc.poll() is not None:
        return
    try:
        proc.terminate()
    except OSError:
        return
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return
        time.sleep(0.05)
    if proc.poll() is None:
        try:
            proc.kill()
        except OSError:
            pass


def deploy_target(
    target: WranglerTarget,
    *,
    profile: str | None = None,
    keep_vars: bool = True,
    message: str | None = None,
    dry_run: bool = False,
    keep_proxy: bool = False,
    timeout_sec: float = 120.0,
    exit_grace_sec: float = 2.0,
    wrangler_cmd: list[str] | None = None,
    base_env: Mapping[str, str] | None = None,
    secrets_to_redact: Iterable[str] = (),
) -> DeployResult:
    """部署单个 Wrangler 目标，并在捕获完成信号后自动回收驻留进程。"""
    started = time.monotonic()
    env = build_wrangler_env(base_env, keep_proxy=keep_proxy)
    base_cmd = list(wrangler_cmd) if wrangler_cmd is not None else resolve_wrangler_command()
    cmd = base_cmd + ["deploy", "--config", str(target.config_path)]

    if profile:
        cmd.extend(["--profile", profile])
    if keep_vars and not dry_run:
        cmd.append("--keep-vars")
    if message and not dry_run:
        cmd.extend(["--message", message])

    temp_outdir: str | None = None
    if dry_run:
        temp_outdir = tempfile.mkdtemp(prefix=f"cf-muse-dry-{target.name}-")
        cmd.extend(["--dry-run", "--outdir", temp_outdir])

    lines: list[str] = []
    line_queue: queue.Queue[str | None] = queue.Queue()
    version_id: str | None = None
    upload_time: str | None = None
    triggers_time: str | None = None
    dry_run_done = False
    completion_seen_at: float | None = None
    terminated_hanging = False
    timed_out = False

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except Exception as exc:
        if temp_outdir:
            shutil.rmtree(temp_outdir, ignore_errors=True)
        return DeployResult(
            name=target.name,
            config_path=str(target.config_path),
            ok=False,
            elapsed_sec=round(time.monotonic() - started, 2),
            dry_run=dry_run,
            error=redact_sensitive(f"spawn_failed:{type(exc).__name__}", secrets_to_redact),
        )

    def _reader() -> None:
        assert proc.stdout is not None
        try:
            for raw_line in proc.stdout:
                line_queue.put(raw_line.rstrip("\r\n"))
        except Exception:
            pass
        finally:
            line_queue.put(None)

    reader_thread = threading.Thread(target=_reader, daemon=True)
    reader_thread.start()
    eof_seen = False

    try:
        while True:
            while True:
                try:
                    item = line_queue.get_nowait()
                except queue.Empty:
                    break
                if item is None:
                    eof_seen = True
                    continue
                safe_line = redact_sensitive(item, secrets_to_redact)
                lines.append(safe_line)

                m_up = UPLOADED_RE.search(safe_line)
                if m_up:
                    upload_time = m_up.group(1).strip()

                m_tr = DEPLOYED_TRIGGERS_RE.search(safe_line)
                if m_tr:
                    triggers_time = m_tr.group(1).strip()

                m_ver = VERSION_ID_RE.search(safe_line)
                if m_ver:
                    version_id = m_ver.group(1).strip()
                    if not dry_run and completion_seen_at is None:
                        completion_seen_at = time.monotonic()

                if "--dry-run: exiting now." in safe_line:
                    dry_run_done = True
                    if dry_run and completion_seen_at is None:
                        completion_seen_at = time.monotonic()

            now = time.monotonic()
            rc = proc.poll()
            if rc is not None and (eof_seen or line_queue.empty()):
                break

            if completion_seen_at is not None and (now - completion_seen_at) >= exit_grace_sec:
                if proc.poll() is None:
                    terminated_hanging = True
                    _terminate_process(proc)
                break

            if (now - started) >= timeout_sec:
                timed_out = True
                _terminate_process(proc)
                break

            time.sleep(0.04)
    finally:
        if proc.stdout is not None:
            try:
                proc.stdout.close()
            except Exception:
                pass
        try:
            proc.wait(timeout=1.0)
        except Exception:
            pass
        if temp_outdir:
            shutil.rmtree(temp_outdir, ignore_errors=True)

    # 排空残余输出行
    while True:
        try:
            rem = line_queue.get_nowait()
        except queue.Empty:
            break
        if rem is not None:
            lines.append(redact_sensitive(rem, secrets_to_redact))
            if version_id is None:
                m_ver = VERSION_ID_RE.search(rem)
                if m_ver:
                    version_id = m_ver.group(1).strip()
            if "--dry-run: exiting now." in rem:
                dry_run_done = True

    elapsed = round(time.monotonic() - started, 2)
    rc = proc.poll()

    if timed_out:
        return DeployResult(
            name=target.name,
            config_path=str(target.config_path),
            ok=False,
            elapsed_sec=elapsed,
            version_id=version_id,
            upload_time=upload_time,
            triggers_time=triggers_time,
            terminated_hanging_process=terminated_hanging,
            dry_run=dry_run,
            error=f"timeout_after_{timeout_sec:.0f}s",
            output_tail=lines[-12:],
        )

    if dry_run:
        ok = dry_run_done or (rc == 0)
    else:
        ok = (version_id is not None and (rc == 0 or terminated_hanging)) or (
            rc == 0 and version_id is not None
        )

    error: str | None = None
    if not ok:
        error = f"wrangler_exit_{rc}" if rc is not None else "wrangler_incomplete"

    return DeployResult(
        name=target.name,
        config_path=str(target.config_path),
        ok=ok,
        elapsed_sec=elapsed,
        version_id=version_id,
        upload_time=upload_time,
        triggers_time=triggers_time,
        terminated_hanging_process=terminated_hanging,
        dry_run=dry_run,
        error=error,
        output_tail=lines[-12:],
    )


def deploy_targets(
    targets: list[WranglerTarget],
    *,
    sequential: bool = False,
    **kwargs: Any,
) -> list[DeployResult]:
    """并发或串行部署多个 Wrangler 目标，保持返回顺序与输入一致。"""
    if not targets:
        return []
    if sequential or len(targets) == 1:
        return [deploy_target(t, **kwargs) for t in targets]
    with ThreadPoolExecutor(max_workers=len(targets)) as pool:
        futures = [pool.submit(deploy_target, t, **kwargs) for t in targets]
        return [f.result() for f in futures]


def load_cloudflare_token(
    profile: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
    config_dir: Path | None = None,
) -> str:
    """读取 Cloudflare API / OAuth Token（优先环境变量，其次 Wrangler Profile 配置）。"""
    source_env = os.environ if env is None else env
    for key in ("CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"):
        val = (source_env.get(key) or "").strip()
        if val:
            return val

    prof = (profile or source_env.get("WRANGLER_PROFILE") or "default").strip()
    candidates: list[Path] = []
    if config_dir is not None:
        candidates.append(config_dir / f"{prof}.toml")
    else:
        home = Path.home()
        candidates.append(home / "Library" / "Preferences" / ".wrangler" / "config" / f"{prof}.toml")
        candidates.append(home / ".config" / ".wrangler" / "config" / f"{prof}.toml")

    for path in candidates:
        if path.is_file():
            parsed = tomllib.loads(path.read_text(encoding="utf-8"))
            token = str(parsed.get("oauth_token") or "").strip()
            if token:
                return token

    raise RuntimeError(f"未找到 Cloudflare OAuth/API 凭证（profile={prof}）")


def load_admin_key(
    admin_key_file: Path | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> str | None:
    """从指定文件或环境变量加载 MUSE_ADMIN_KEY。"""
    source_env = os.environ if env is None else env
    if admin_key_file is not None:
        resolved = admin_key_file.expanduser().resolve()
        if not resolved.is_file():
            raise FileNotFoundError(f"管理密钥文件不存在: {admin_key_file}")
        value = resolved.read_text(encoding="utf-8").strip()
        return value or None
    env_val = (source_env.get("MUSE_ADMIN_KEY") or "").strip()
    if env_val:
        return env_val
    default_file = Path.home() / ".config" / "cf-muse-channel" / "muse-admin-key.txt"
    if default_file.is_file():
        return default_file.read_text(encoding="utf-8").strip() or None
    return None


def default_http_json(
    method: str,
    url: str,
    *,
    headers: Mapping[str, str] | None = None,
    json_body: Any = None,
    timeout: float = 20.0,
) -> tuple[int, dict[str, Any]]:
    """发送 HTTP 请求并解析 JSON，优先使用 curl_cffi 规避 Cloudflare WAF 403。"""
    req_headers = {"Accept": "application/json", "User-Agent": BROWSER_UA}
    if headers:
        req_headers.update(headers)

    if curl_requests is not None:
        resp = curl_requests.request(
            method=method.upper(),
            url=url,
            headers=req_headers,
            json=json_body,
            timeout=timeout,
            impersonate="chrome",
            allow_redirects=False,
        )
        try:
            payload = resp.json()
        except Exception:
            payload = {}
        return int(resp.status_code), payload if isinstance(payload, dict) else {}

    data_bytes: bytes | None = None
    if json_body is not None:
        req_headers["Content-Type"] = "application/json"
        data_bytes = json.dumps(json_body).encode("utf-8")

    request = urllib.request.Request(url, data=data_bytes, headers=req_headers, method=method.upper())
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
            payload = json.loads(raw) if raw else {}
            return int(response.status), payload if isinstance(payload, dict) else {}
    except urllib.error.HTTPError as err:
        try:
            raw = err.read().decode("utf-8", errors="replace")
            payload = json.loads(raw) if raw else {}
        except Exception:
            payload = {}
        return int(err.code), payload if isinstance(payload, dict) else {}


def check_managed_safe_for_reset(status_body: Mapping[str, Any], mode: str = "settled") -> tuple[bool, str]:
    """校验托管渠道状态是否满足 immediate DO 代码切版的安全门禁。"""
    if mode == "force":
        return True, "forced"

    channels = status_body.get("channels")
    tasks = status_body.get("tasks")
    outbound = status_body.get("outbound")
    if not isinstance(channels, dict) or not isinstance(tasks, list) or not isinstance(outbound, list):
        return False, "invalid_managed_status_payload"

    if mode == "idle":
        any_enabled = any(isinstance(v, dict) and bool(v.get("enabled")) for v in channels.values())
        if any_enabled or tasks or outbound:
            return False, "not_isolated_and_idle"
        return True, "idle_ok"

    if mode == "settled":
        outbound_ok = all(
            isinstance(o, dict) and o.get("state") in ("delivered", "unknown") for o in outbound
        )
        tasks_ok = all(
            isinstance(t, dict) and t.get("state") in ("succeeded", "failed", "cancelled") for t in tasks
        )
        if not outbound_ok or not tasks_ok:
            return False, "in_flight_tasks_or_outbound"
        return True, "settled_ok"

    if mode == "recover":
        outbound_ok = all(isinstance(o, dict) and o.get("state") == "delivered" for o in outbound)
        tasks_ok = all(
            isinstance(t, dict)
            and t.get("state") in ("queued", "running", "succeeded", "failed", "cancelled")
            for t in tasks
        )
        if not outbound_ok or not tasks_ok:
            return False, "ambiguous_submission_or_delivery"
        return True, "recover_ok"

    return False, f"unsupported_mode:{mode}"


HttpCallable = Callable[..., tuple[int, dict[str, Any]]]


def apply_immediate_deployment(
    target: WranglerTarget,
    *,
    expected_version_id: str | None = None,
    mode: str = "settled",
    cf_token: str | None = None,
    admin_key: str | None = None,
    origin_override: str | None = None,
    http_json: HttpCallable = default_http_json,
) -> ImmediateResult:
    """对指定 Worker 执行安全的 immediate DO 代码切版。"""
    started = time.monotonic()
    if not target.account_id:
        return ImmediateResult(
            name=target.name,
            ok=False,
            skipped=True,
            elapsed_sec=round(time.monotonic() - started, 2),
            mode=mode,
            reason="missing_account_id",
        )

    origin = (origin_override or (f"https://{target.custom_domain}" if target.custom_domain else "")).rstrip("/")

    if target.owns_managed_do and mode != "force":
        if not admin_key:
            return ImmediateResult(
                name=target.name,
                ok=False,
                skipped=True,
                elapsed_sec=round(time.monotonic() - started, 2),
                mode=mode,
                reason="missing_admin_key",
            )
        if not origin:
            return ImmediateResult(
                name=target.name,
                ok=False,
                skipped=True,
                elapsed_sec=round(time.monotonic() - started, 2),
                mode=mode,
                reason="missing_worker_origin",
            )
        status_code, status_body = http_json(
            "GET",
            f"{origin}/admin/managed/status",
            headers={"Authorization": f"Bearer {admin_key}"},
            timeout=20.0,
        )
        if status_code != 200:
            return ImmediateResult(
                name=target.name,
                ok=False,
                skipped=True,
                elapsed_sec=round(time.monotonic() - started, 2),
                mode=mode,
                reason=f"managed_status_http_{status_code}",
            )
        safe, reason = check_managed_safe_for_reset(status_body, mode=mode)
        if not safe:
            return ImmediateResult(
                name=target.name,
                ok=False,
                skipped=True,
                elapsed_sec=round(time.monotonic() - started, 2),
                mode=mode,
                reason=reason,
            )

    if not cf_token:
        return ImmediateResult(
            name=target.name,
            ok=False,
            skipped=True,
            elapsed_sec=round(time.monotonic() - started, 2),
            mode=mode,
            reason="missing_cloudflare_token",
        )

    api_url = (
        f"https://api.cloudflare.com/client/v4/accounts/"
        f"{target.account_id}/workers/scripts/{target.name}/deployments"
    )
    auth_headers = {"Authorization": f"Bearer {cf_token}"}

    versions: list[dict[str, Any]] | None = None
    active_version_id: str | None = None
    for attempt in range(3):
        code, body = http_json("GET", api_url, headers=auth_headers, timeout=20.0)
        if code != 200 or not body.get("success"):
            return ImmediateResult(
                name=target.name,
                ok=False,
                skipped=False,
                elapsed_sec=round(time.monotonic() - started, 2),
                mode=mode,
                reason=f"get_deployments_http_{code}",
            )
        deployments = body.get("result", {}).get("deployments", [])
        if not isinstance(deployments, list) or not deployments:
            return ImmediateResult(
                name=target.name,
                ok=False,
                skipped=False,
                elapsed_sec=round(time.monotonic() - started, 2),
                mode=mode,
                reason="empty_deployments",
            )
        candidate = deployments[0].get("versions", [])
        if (
            not isinstance(candidate, list)
            or len(candidate) != 1
            or candidate[0].get("percentage") != 100
        ):
            return ImmediateResult(
                name=target.name,
                ok=False,
                skipped=False,
                elapsed_sec=round(time.monotonic() - started, 2),
                mode=mode,
                reason="non_single_100_deployment",
            )
        versions = candidate
        active_version_id = str(candidate[0].get("version_id") or "")
        if not expected_version_id or active_version_id == expected_version_id or attempt == 2:
            break
        time.sleep(0.5)

    if expected_version_id and active_version_id != expected_version_id:
        return ImmediateResult(
            name=target.name,
            ok=False,
            skipped=True,
            elapsed_sec=round(time.monotonic() - started, 2),
            version_id=active_version_id,
            mode=mode,
            reason="version_mismatch",
        )

    post_code, post_body = http_json(
        "POST",
        api_url,
        headers=auth_headers,
        json_body={
            "strategy": "percentage",
            "versions": versions,
            "code_update_strategy": {"mode": "immediate"},
        },
        timeout=20.0,
    )
    ok = post_code == 200 and bool(post_body.get("success"))
    return ImmediateResult(
        name=target.name,
        ok=ok,
        skipped=False,
        elapsed_sec=round(time.monotonic() - started, 2),
        version_id=active_version_id,
        mode=mode,
        reason="applied" if ok else f"post_deployments_http_{post_code}",
    )


def verify_target(
    target: WranglerTarget,
    *,
    admin_key: str | None = None,
    origin_override: str | None = None,
    http_json: HttpCallable = default_http_json,
) -> VerifyResult:
    """对已部署的 Worker 执行 /health 与可选 /admin/managed/status 健康检查。"""
    started = time.monotonic()
    origin = (origin_override or (f"https://{target.custom_domain}" if target.custom_domain else "")).rstrip("/")
    if not origin:
        return VerifyResult(
            name=target.name,
            origin="",
            ok=False,
            elapsed_sec=0.0,
            error="missing_origin",
        )

    try:
        h_code, h_body = http_json("GET", f"{origin}/health", timeout=15.0)
    except Exception as exc:
        return VerifyResult(
            name=target.name,
            origin=origin,
            ok=False,
            elapsed_sec=round(time.monotonic() - started, 2),
            error=f"health_request_failed:{type(exc).__name__}",
        )

    health_ok = h_code == 200 and h_body.get("ok") is True and h_body.get("service") == "cf-muse-channel"
    if not health_ok:
        return VerifyResult(
            name=target.name,
            origin=origin,
            ok=False,
            elapsed_sec=round(time.monotonic() - started, 2),
            health_ok=False,
            error=f"health_http_{h_code}",
        )

    if not target.owns_managed_do or not admin_key:
        return VerifyResult(
            name=target.name,
            origin=origin,
            ok=True,
            elapsed_sec=round(time.monotonic() - started, 2),
            health_ok=True,
        )

    try:
        m_code, m_body = http_json(
            "GET",
            f"{origin}/admin/managed/status",
            headers={"Authorization": f"Bearer {admin_key}"},
            timeout=15.0,
        )
    except Exception as exc:
        return VerifyResult(
            name=target.name,
            origin=origin,
            ok=False,
            elapsed_sec=round(time.monotonic() - started, 2),
            health_ok=True,
            managed_checked=True,
            error=f"managed_status_failed:{type(exc).__name__}",
        )

    if m_code != 200:
        return VerifyResult(
            name=target.name,
            origin=origin,
            ok=False,
            elapsed_sec=round(time.monotonic() - started, 2),
            health_ok=True,
            managed_checked=True,
            error=f"managed_status_http_{m_code}",
        )

    channels = m_body.get("channels") if isinstance(m_body.get("channels"), dict) else {}
    tasks = m_body.get("tasks") if isinstance(m_body.get("tasks"), list) else []
    outbound = m_body.get("outbound") if isinstance(m_body.get("outbound"), list) else []
    enabled_count = sum(1 for v in channels.values() if isinstance(v, dict) and v.get("enabled"))
    active_tasks = sum(
        1 for t in tasks if isinstance(t, dict) and t.get("state") in ("queued", "running")
    )
    pending_out = sum(
        1 for o in outbound if isinstance(o, dict) and o.get("state") in ("pending", "sending")
    )
    pump_err = m_body.get("last_pump_error")
    runtime_ver = m_body.get("runtime_version")

    return VerifyResult(
        name=target.name,
        origin=origin,
        ok=True,
        elapsed_sec=round(time.monotonic() - started, 2),
        health_ok=True,
        managed_checked=True,
        runtime_version=str(runtime_ver) if runtime_ver else None,
        enabled_channels=enabled_count,
        active_tasks=active_tasks,
        pending_outbound=pending_out,
        last_pump_error=str(pump_err) if pump_err else None,
    )


def resolve_config_paths(
    configs: list[str] | None,
    *,
    all_local: bool = False,
    root: Path = ROOT,
) -> list[Path]:
    """根据 CLI 参数解析待部署的 Wrangler 配置文件列表。"""
    if configs:
        return [(root / c).resolve() if not Path(c).is_absolute() else Path(c).resolve() for c in configs]
    if all_local:
        found: list[Path] = []
        for candidate in ("wrangler.production.jsonc", "wrangler.managed.local.jsonc"):
            p = (root / candidate).resolve()
            if p.is_file():
                found.append(p)
        if not found:
            raise FileNotFoundError(
                "未找到 wrangler.production.jsonc 或 wrangler.managed.local.jsonc，请使用 --config 指定配置文件"
            )
        return found
    return [(root / "wrangler.jsonc").resolve()]


def build_parser() -> argparse.ArgumentParser:
    """构建命令行参数解析器。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        "-c",
        action="append",
        dest="configs",
        help="Wrangler 配置文件路径（可多次传入以并发部署多个 Worker）",
    )
    parser.add_argument(
        "--all-local",
        action="store_true",
        help="自动并发部署当前目录下已存在的本地生产与托管配置（wrangler.production.jsonc + wrangler.managed.local.jsonc）",
    )
    parser.add_argument("--profile", help="Wrangler 认证 Profile 名称")
    parser.add_argument("--message", help="Wrangler 版本部署备注")
    parser.add_argument("--dry-run", action="store_true", help="仅执行本地打包预检，不修改线上资源")
    parser.add_argument("--sequential", action="store_true", help="禁用并发，按顺序逐个部署")
    parser.add_argument("--check", action="store_true", help="部署前先执行 npm run check 类型检查")
    parser.add_argument("--no-keep-vars", action="store_true", help="部署时不附加 --keep-vars")
    parser.add_argument("--keep-proxy", action="store_true", help="保留当前环境中的 HTTP/HTTPS/ALL_PROXY 变量")
    parser.add_argument("--timeout", type=float, default=120.0, help="单个 Worker 部署硬超时秒数（默认 120）")
    parser.add_argument(
        "--exit-grace-sec",
        type=float,
        default=2.0,
        help="检测到 Current Version ID 后等待进程自然退出的宽限秒数（默认 2.0）",
    )
    parser.add_argument(
        "--immediate",
        action="store_true",
        help="部署成功后对拥有本地 ManagedChannels DO 的 Worker 执行安全 immediate 代码切版",
    )
    parser.add_argument(
        "--immediate-all",
        action="store_true",
        help="对本次部署的所有 Worker 执行 immediate 代码切版",
    )
    parser.add_argument(
        "--immediate-mode",
        choices=("settled", "idle", "recover", "force"),
        default="settled",
        help="immediate 切版前的在途任务安全门禁模式（默认 settled）",
    )
    parser.add_argument("--admin-key-file", type=Path, help="MUSE_ADMIN_KEY 文件路径")
    parser.add_argument("--verify", action="store_true", help="部署后自动请求 /health 与托管状态进行线上验收")
    parser.add_argument("--json-report", type=Path, help="输出脱敏 JSON 部署报告到指定路径")
    return parser


def main(argv: list[str] | None = None) -> int:
    """命令行主入口。"""
    parser = build_parser()
    args = parser.parse_args(argv)
    overall_start = time.monotonic()

    try:
        config_paths = resolve_config_paths(args.configs, all_local=args.all_local)
        targets = [load_wrangler_config(p) for p in config_paths]
    except Exception as exc:
        print(f"FAIL 配置解析失败: {exc}", file=sys.stderr)
        return 2

    secrets: list[str] = []
    admin_key: str | None = None
    try:
        admin_key = load_admin_key(args.admin_key_file)
        if admin_key:
            secrets.append(admin_key)
    except Exception as exc:
        print(f"FAIL 读取管理密钥失败: {exc}", file=sys.stderr)
        return 2

    if args.check:
        t0 = time.monotonic()
        chk = subprocess.run(
            ["npm", "run", "check"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=60,
        )
        dt = time.monotonic() - t0
        if chk.returncode != 0:
            print(f"FAIL npm run check 未通过 ({dt:.2f}s)", file=sys.stderr)
            if chk.stdout:
                print(redact_sensitive(chk.stdout, secrets), file=sys.stderr)
            if chk.stderr:
                print(redact_sensitive(chk.stderr, secrets), file=sys.stderr)
            return 1
        print(f"PASS typecheck ({dt:.2f}s)", flush=True)

    mode_label = "DRY-RUN" if args.dry_run else ("SEQUENTIAL" if args.sequential or len(targets) == 1 else "PARALLEL")
    print(
        f"==> 开始部署 [{mode_label}] 目标数={len(targets)}: "
        + ", ".join(f"{t.name} ({t.config_path.name})" for t in targets),
        flush=True,
    )

    deploy_results = deploy_targets(
        targets,
        sequential=args.sequential,
        profile=args.profile,
        keep_vars=not args.no_keep_vars,
        message=args.message,
        dry_run=args.dry_run,
        keep_proxy=args.keep_proxy,
        timeout_sec=args.timeout,
        exit_grace_sec=args.exit_grace_sec,
        secrets_to_redact=secrets,
    )

    all_deployed_ok = True
    for res in deploy_results:
        status = "PASS" if res.ok else "FAIL"
        extra: list[str] = [f"{res.elapsed_sec:.2f}s"]
        if res.version_id:
            extra.append(f"version={res.version_id}")
        if res.upload_time:
            extra.append(f"upload={res.upload_time}")
        if res.triggers_time:
            extra.append(f"triggers={res.triggers_time}")
        if res.terminated_hanging_process:
            extra.append("reaped_hanging_wrangler=true")
        if res.error:
            extra.append(f"error={res.error}")
        print(f"{status} deploy {res.name} ({', '.join(extra)})", flush=True)
        if not res.ok:
            all_deployed_ok = False
            for line in res.output_tail:
                print(f"  | {redact_sensitive(line, secrets)}", file=sys.stderr)

    immediate_results: list[ImmediateResult] = []
    if (args.immediate or args.immediate_all) and not args.dry_run and all_deployed_ok:
        cf_token: str | None = None
        try:
            cf_token = load_cloudflare_token(args.profile)
            secrets.append(cf_token)
        except Exception:
            cf_token = None

        result_by_name = {r.name: r for r in deploy_results}
        for target in targets:
            if not args.immediate_all and not target.owns_managed_do:
                continue
            dep_res = result_by_name.get(target.name)
            imm = apply_immediate_deployment(
                target,
                expected_version_id=dep_res.version_id if dep_res else None,
                mode=args.immediate_mode,
                cf_token=cf_token,
                admin_key=admin_key,
            )
            immediate_results.append(imm)
            tag = "PASS" if imm.ok else ("SKIP" if imm.skipped else "FAIL")
            print(
                f"{tag} immediate {imm.name} ({imm.elapsed_sec:.2f}s, mode={imm.mode}, "
                f"reason={imm.reason}, version={imm.version_id or '-'})",
                flush=True,
            )
            if not imm.ok:
                all_deployed_ok = False

    verify_results: list[VerifyResult] = []
    if args.verify and not args.dry_run and all_deployed_ok:
        for target in targets:
            if not target.custom_domain:
                continue
            ver = verify_target(target, admin_key=admin_key)
            verify_results.append(ver)
            tag = "PASS" if ver.ok else "FAIL"
            details = [f"{ver.elapsed_sec:.2f}s", f"health={ver.health_ok}"]
            if ver.managed_checked:
                details.append(f"channels={ver.enabled_channels}")
                details.append(f"active_tasks={ver.active_tasks}")
                details.append(f"pending_outbound={ver.pending_outbound}")
                if ver.runtime_version:
                    details.append(f"runtime={ver.runtime_version}")
                if ver.last_pump_error:
                    details.append(f"pump_err={ver.last_pump_error}")
            if ver.error:
                details.append(f"error={ver.error}")
            print(f"{tag} verify {ver.name} ({', '.join(details)})", flush=True)
            if not ver.ok:
                all_deployed_ok = False

    total_elapsed = round(time.monotonic() - overall_start, 2)
    summary_tag = "PASS" if all_deployed_ok else "FAIL"
    print(f"==> {summary_tag} 总耗时 {total_elapsed:.2f}s", flush=True)

    if args.json_report:
        report_payload = {
            "ok": all_deployed_ok,
            "dry_run": bool(args.dry_run),
            "total_elapsed_sec": total_elapsed,
            "deploy": [
                {
                    **asdict(r),
                    "config_path": Path(r.config_path).name,
                    "output_tail": [redact_sensitive(line, secrets) for line in r.output_tail],
                }
                for r in deploy_results
            ],
            "immediate": [asdict(i) for i in immediate_results],
            "verify": [asdict(v) for v in verify_results],
        }
        report_path = args.json_report.expanduser().resolve()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        serialized = redact_sensitive(json.dumps(report_payload, ensure_ascii=False, indent=2), secrets)
        report_path.write_text(serialized + "\n", encoding="utf-8")

    return 0 if all_deployed_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
