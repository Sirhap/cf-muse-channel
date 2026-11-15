#!/usr/bin/env python3
"""Bounded deployment checks. Manual refresh and ONE test chat require explicit flags."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "client"))
import probe


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--renew", action="store_true", help="Perform one real Cookie renewal")
    parser.add_argument("--chat", action="store_true", help="Create one independent Muse test session and send one harmless message")
    parser.add_argument("--receipt", type=Path, default=ROOT / ".local/comprehensive-live-chat.json")
    parser.add_argument("--report", type=Path, default=ROOT / "artifacts/live-smoke.json")
    args = parser.parse_args()
    try:
        probe.worker_origin(args.url)
    except ValueError:
        parser.error("Expected a plain HTTPS Worker origin")
    key = os.environ.get("DEMO_KEY", "")
    if not 32 <= len(key) <= 512 or any(char.isspace() for char in key):
        parser.error("Set DEMO_KEY in the environment")
    origin = args.url.rstrip("/")
    checks = []

    def check(name, operation):
        started = time.monotonic()
        try:
            operation()
            result = {"name": name, "passed": True}
        except Exception as error:
            # Never expose raw exceptions, HTTP bodies, authorization values or SDK URLs.
            result = {"name": name, "passed": False, "error_type": type(error).__name__}
        result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
        checks.append(result)
        print(("PASS " if result["passed"] else "FAIL ") + name, flush=True)
        return result["passed"]

    def http(path, method="GET", status=200, authorization=None, validate=None):
        headers = {} if authorization is None else {"Authorization": authorization}
        response = probe.requests.request(method, origin + path, headers=headers,
                                          timeout=30, allow_redirects=False)
        assert response.status_code == status
        if validate:
            assert response.headers.get("Content-Type", "").startswith("application/json")
            validate(response.json())
        return response

    def assert_health(body):
        assert body.get("ok") is True and body.get("service") == "cf-muse-channel"

    # Do not send the test key until the public endpoint identifies the intended service.
    if not check("public deployment identity", lambda: http("/health", validate=assert_health)):
        parser.exit(1, "Health identity failed; no authenticated requests were attempted.\n")
    token = "Bearer " + key
    for name, path, method, expected, authorization in [
        ("status requires authentication", "/credentials/status", "GET", 401, None),
        ("renewal requires authentication", "/credentials/refresh", "POST", 401, None),
        ("websocket requires authentication", "/ws", "GET", 401, None),
        ("wrong key is rejected", "/probe/cookie", "POST", 401, "Bearer deliberately-invalid-test-key"),
        ("Basic authentication is rejected", "/credentials/status", "GET", 401, "Basic invalid"),
        ("query credentials are rejected", "/credentials/status?token=synthetic-test-only", "GET", 400, None),
        ("unsupported method cannot renew", "/credentials/refresh", "GET", 404, token),
        ("websocket needs Upgrade", "/ws", "GET", 426, token),
        ("unknown endpoint is rejected", "/nonexistent-test-endpoint", "GET", 404, token),
    ]:
        check(name, lambda p=path, m=method, s=expected, a=authorization: http(p, m, s, a))

    states = []
    def assert_status(body):
        allowed = {"ok", "configured", "needs_login", "last_checked_at", "last_verified_at", "last_rotated_at", "last_error"}
        assert set(body) <= allowed and body.get("configured") is True
        assert body.get("needs_login") is False
        states.append(body)

    check("credential status is private and sanitized", lambda: http("/credentials/status", authorization=token, validate=assert_status))
    def cache_headers():
        response = http("/health")
        assert response.headers.get("Cache-Control") == "no-store"
        assert response.headers.get("X-Content-Type-Options") == "nosniff"
    check("diagnostics are not cached", cache_headers)

    if args.renew:
        def renewal():
            response = http("/credentials/refresh", "POST", authorization=token)
            body = response.json()
            assert_status(body)
            assert body.get("ok") is True and body.get("last_verified_at") and body.get("last_rotated_at")
        check("real Cookie renewal", renewal)
        def persisted():
            previous = states[-1]
            body = http("/credentials/status", authorization=token).json()
            assert_status(body)
            assert body.get("last_verified_at", 0) >= previous.get("last_verified_at", 0)
            assert body.get("last_rotated_at", 0) >= previous.get("last_rotated_at", 0)
        check("rotated credential state can be read back", persisted)

    def rpc():
        client = probe.RelayGateway(origin, key)
        try:
            result = client.call_json("sessions.list", timeout=15)
            assert isinstance(result, (dict, list))
        finally:
            client.close()
    connected = check("real Noise handshake and read-only RPC", rpc)

    marker = "CF_SMOKE_" + uuid.uuid4().hex[:12]
    if args.chat and connected:
        def chat():
            client = probe.RelayGateway(origin, key)
            try:
                message = (f"这是通信回显测试，不代表任何项目已通过验收。请只原样回复标记 {marker}。"
                           "不要检查项目、查询历史状态或执行其他操作。")
                result = probe.chat_once(client, message, 120, args.receipt)
                assert result.get("state") == "succeeded" and result.get("submission_confirmed") is True
                assert marker in result.get("text", "")
            finally:
                client.close()
        completed = check("one real test message and correlated reply", chat)
        if completed:
            def recovery():
                saved = json.loads(args.receipt.read_text())
                saved["state"] = "result_unknown"
                saved.pop("text", None)
                recovery_path = args.receipt.with_name(args.receipt.stem + "-read-only-recovery.json")
                probe.write_receipt(recovery_path, saved)
                client = probe.RelayGateway(origin, key)
                try:
                    result = probe.wait_result(client, 30, recovery_path)
                    assert result.get("state") == "succeeded" and marker in result.get("text", "")
                finally:
                    client.close()
            check("new connection recovers the existing reply without resending", recovery)

    report = {"url": origin, "tested_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
              "working_tree_dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT).strip()),
              "working_tree_fixes_deployed": False, "renewal_requested": args.renew,
              "chat_requested": args.chat, "chat_marker": marker if args.chat else None, "checks": checks,
              "passed": sum(check["passed"] for check in checks), "total": len(checks)}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"{report['passed']}/{report['total']} real-deployment checks passed.")
    return int(report["passed"] != report["total"])


if __name__ == "__main__":
    raise SystemExit(main())
