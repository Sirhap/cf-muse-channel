"""The live-test runner must honor opt-ins and stop sending after connection failures."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location("live_smoke", Path(__file__).resolve().parents[1] / "scripts/live_smoke.py")
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)
KEY = "test-key-with-more-than-thirty-two-characters"


def response(method, url, headers, **kwargs):
    path = urlsplit(url).path
    status = 200
    body = {"ok": True, "configured": True, "needs_login": False,
            "last_verified_at": 1000, "last_rotated_at": 1000}
    if path == "/health":
        body = {"ok": True, "service": "cf-muse-channel"}
    elif urlsplit(url).query:
        status = 400
    elif headers.get("Authorization") != "Bearer " + KEY:
        status = 401
    elif path == "/credentials/refresh" and method != "POST":
        status = 404
    elif path == "/ws":
        status = 426
    elif path == "/nonexistent-test-endpoint":
        status = 404
    result = Mock(status_code=status, headers={"Content-Type": "application/json", "Cache-Control": "no-store",
                                               "X-Content-Type-Options": "nosniff"})
    result.json.return_value = body
    return result


class LiveRunnerTests(unittest.TestCase):
    def run_smoke(self, folder, *flags, request=response, gateway=None):
        report = Path(folder) / "report.json"
        receipt = Path(folder) / "receipt.json"
        args = ["live_smoke.py", "--url", "https://demo.test", "--report", str(report), "--receipt", str(receipt), *flags]
        output = io.StringIO()
        with patch.object(live.sys, "argv", args), patch.dict(os.environ, DEMO_KEY=KEY), \
                patch.object(live.probe.requests, "request", side_effect=request), \
                patch.object(live.probe, "RelayGateway", gateway or Mock(return_value=Mock())), \
                patch.object(live.subprocess, "check_output", return_value=b"test-commit"), contextlib.redirect_stdout(output):
            code = live.main()
        return code, report, receipt, output.getvalue()

    def test_defaults_never_create_a_chat_or_a_manual_refresh(self):
        seen = []
        def tracked(*args, **kwargs):
            seen.append((args[0], urlsplit(args[1]).path, kwargs["headers"]))
            return response(*args, **kwargs)
        gateway = Mock(return_value=Mock())
        gateway.return_value.call_json.return_value = {"sessions": []}
        with tempfile.TemporaryDirectory() as folder, patch.object(live.probe, "chat_once") as chat:
            code, report, receipt, _ = self.run_smoke(folder, request=tracked, gateway=gateway)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(report.read_text())["total"], 13)
            self.assertFalse(receipt.exists())
            chat.assert_not_called()
            self.assertFalse(any(method == "POST" and path == "/credentials/refresh" and
                                 headers.get("Authorization") == "Bearer " + KEY for method, path, headers in seen))

    def test_wrong_health_identity_prevents_transmitting_the_key(self):
        seen = []
        def wrong(*args, **kwargs):
            seen.append(kwargs["headers"])
            result = response(*args, **kwargs)
            result.json.return_value = {"ok": True, "service": "other-service"}
            return result
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            self.run_smoke(folder, request=wrong)
        self.assertEqual(seen, [{}])

    def test_failed_rpc_never_submits_a_chat_and_redacts_the_exception(self):
        gateway = Mock(side_effect=ConnectionError("Authorization: Bearer do-not-print"))
        with tempfile.TemporaryDirectory() as folder, patch.object(live.probe, "chat_once") as chat:
            code, report, _, output = self.run_smoke(folder, "--chat", gateway=gateway)
            self.assertEqual(code, 1)
            chat.assert_not_called()
            self.assertNotIn("do-not-print", output + report.read_text())

    def test_explicit_chat_sends_one_marker_and_recovers_only_by_reading(self):
        marker = "CF_SMOKE_" + "a" * 12
        def chat(client, message, timeout, receipt):
            self.assertIn(marker, message)
            result = {"state": "succeeded", "submission_confirmed": True, "text": marker,
                      "session_id": "fixture-session", "baseline_seq": 0, "anchor_seq": 1}
            live.probe.write_receipt(receipt, result)
            return result
        gateway = Mock(return_value=Mock())
        gateway.return_value.call_json.return_value = {"sessions": []}
        with tempfile.TemporaryDirectory() as folder, patch.object(live.uuid, "uuid4", return_value=Mock(hex="a" * 32)), \
                patch.object(live.probe, "chat_once", side_effect=chat) as send, \
                patch.object(live.probe, "wait_result", return_value={"state": "succeeded", "text": marker}) as read:
            code, report, _, _ = self.run_smoke(folder, "--renew", "--chat", gateway=gateway)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(report.read_text())["total"], 17)
            send.assert_called_once()
            read.assert_called_once()
