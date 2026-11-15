"""Exercise malformed responses, uncertain submissions and offline CLI boundaries."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from test_client import probe


class ClientBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "receipt.json"
        self.client = Mock()

    def seed(self, **changes):
        data = {"state": "awaiting_result", "session_id": "test-session", "baseline_seq": 10,
                "retry_safe": False, **changes}
        probe.write_receipt(self.path, data)

    def poll_once(self, events):
        self.client.call_json.return_value = {"chat_events": events}
        with patch.object(probe.time, "monotonic", side_effect=[0, 0, 2]), patch.object(probe.time, "sleep"):
            return probe.wait_result(self.client, 1, self.path)

    def test_empty_chat_is_rejected_before_creating_a_session(self):
        for text in ("", " \n\t"):
            with self.subTest(text=repr(text)), self.assertRaises(ValueError):
                probe.chat_once(self.client, text, 1, self.path)
        self.client.call_json.assert_not_called()
        self.client._open.assert_not_called()
        self.assertFalse(self.path.exists())

    def test_invalid_baseline_never_opens_a_chat_stream(self):
        for seq in (True, -1, "not-an-integer"):
            with self.subTest(sequence_type=type(seq).__name__):
                path = self.path.with_name(f"invalid-{type(seq).__name__}.json")
                client = Mock()
                client.call_json.side_effect = [{"session_id": "session"}, {"chat_events": [{"seq": seq}]}]
                with self.assertRaises(ValueError):
                    probe.chat_once(client, "test", 1, path)
                client._open.assert_not_called()

    def test_missing_session_id_leaves_a_non_replayable_claim(self):
        self.client.call_json.return_value = {}
        with self.assertRaises(ValueError):
            probe.chat_once(self.client, "test", 1, self.path)
        self.assertEqual(json.loads(self.path.read_text())["state"], "preparing_session")
        self.client._open.assert_not_called()

    def test_receipt_write_failure_never_sends_a_task(self):
        self.client.call_json.side_effect = [{"session_id": "session"}, {"chat_events": []}]
        with patch.object(probe, "write_receipt", side_effect=OSError("disk unavailable")):
            with self.assertRaises(OSError):
                probe.chat_once(self.client, "test", 1, self.path)
        self.client._open.assert_not_called()

    def test_stream_observes_a_durable_uncertain_receipt_before_sending(self):
        self.client.call_json.side_effect = [{"session_id": "session"}, {"chat_events": []}]
        def send(*args, **kwargs):
            self.assertEqual(json.loads(self.path.read_text())["state"], "submission_unknown")
            raise ConnectionError("connection lost during send")
        self.client._open.side_effect = send
        with self.assertRaises(ConnectionError):
            probe.chat_once(self.client, "test", 1, self.path)
        self.client._open.assert_called_once()

    def test_old_assistant_reply_cannot_complete_a_new_submission(self):
        self.seed()
        result = self.poll_once([{"seq": 9, "event_name": "message.assistant", "payload": {
            "status": "completed", "display_text": "Old reply"}}])
        self.assertEqual(result["state"], "result_unknown")
        self.assertFalse(result.get("submission_confirmed", False))
        self.client._open.assert_not_called()

    def test_assistant_without_a_confirmed_user_anchor_stays_unknown(self):
        self.seed()
        result = self.poll_once([{"seq": 12, "event_name": "message.assistant", "payload": {
            "status": "completed", "display_text": "Uncorrelated reply"}}])
        self.assertEqual(result["state"], "result_unknown")

    def test_recorded_anchor_survives_history_window_truncation(self):
        self.seed(anchor_seq=11, submission_confirmed=True)
        result = self.poll_once([{"seq": 150, "event_name": "message.assistant", "payload": {
            "status": "completed", "display_text": "Late reply"}}])
        self.assertEqual(result["text"], "Late reply")
        self.client._open.assert_not_called()

    def test_all_completed_text_parts_in_one_snapshot_are_preserved(self):
        self.seed()
        result = self.poll_once([
            {"seq": 13, "event_name": "message.assistant", "payload": {"status": "completed", "display_text": "Second part"}},
            {"seq": 11, "event_name": "message.user"},
            {"seq": 12, "event_name": "message.assistant", "payload": {"status": "completed", "display_text": "First part"}},
        ])
        self.assertEqual(result["text"], "First part\nSecond part")

    def test_completed_progress_is_not_final_while_another_reply_is_streaming(self):
        self.seed()
        result = self.poll_once([
            {"seq": 11, "event_name": "message.user"},
            {"seq": 12, "event_name": "message.assistant", "payload": {"status": "completed", "display_text": "Working"}},
            {"seq": 13, "event_name": "message.assistant", "payload": {"status": "streaming", "display_text": "Partial"}},
        ])
        self.assertEqual(result["state"], "result_unknown")

    def test_explicit_failed_or_cancelled_result_is_not_reported_as_timeout(self):
        for status in ("failed", "cancelled"):
            with self.subTest(status=status):
                self.seed()
                result = self.poll_once([
                    {"seq": 11, "event_name": "message.user"},
                    {"seq": 12, "event_name": "message.assistant", "payload": {"status": status}},
                ])
                self.assertEqual(result["state"], status)
                self.client._open.assert_not_called()

    def test_invalid_receipt_fields_never_read_or_send(self):
        for changes in ({"baseline_seq": True}, {"baseline_seq": -1}, {"anchor_seq": 9}, {"session_id": ""}):
            with self.subTest(changes=changes):
                self.seed(**changes)
                with self.assertRaises(ValueError):
                    probe.wait_result(self.client, 1, self.path)
        self.client.call_json.assert_not_called()
        self.client._open.assert_not_called()

    def test_receipt_atomic_replace_failure_preserves_previous_contents(self):
        self.seed()
        before = self.path.read_bytes()
        with patch.object(Path, "replace", side_effect=OSError("rename failed")):
            with self.assertRaises(OSError):
                probe.write_receipt(self.path, {"state": "succeeded"})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.glob("*.tmp")), [])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)


class CliBoundaryTests(unittest.TestCase):
    def invoke(self, *arguments):
        output = io.StringIO()
        with patch.object(probe.sys, "argv", ["probe.py", *arguments]), patch.dict(os.environ, {
            "DEMO_KEY": "test-key-with-more-than-thirty-two-characters"}), contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            result = probe.main()
        return result, output.getvalue()

    def test_invalid_origins_are_rejected_before_network_access(self):
        urls = ["https://:password@demo.test", "https://@demo.test", "https://user:pass@demo.test",
                "https://demo.test:bad", "https://demo.test:70000", "https://demo.test/private",
                "https://demo.test/?token=secret", "https://demo.test/#secret", "http://public.test", "file:///tmp/test"]
        with patch.object(probe.requests, "request") as request:
            for url in urls:
                with self.subTest(url=url), self.assertRaises(SystemExit):
                    self.invoke("status", "--url", url)
            request.assert_not_called()

    def test_timeout_limits_are_checked_before_network_access(self):
        with patch.object(probe.requests, "request") as request:
            for timeout in ("0", "-1", "601"):
                with self.subTest(timeout=timeout), self.assertRaises(SystemExit):
                    self.invoke("status", "--url", "https://demo.test", "--timeout", timeout)
            request.assert_not_called()

    def test_non_json_response_is_not_echoed_or_retried(self):
        response = Mock(status_code=502, headers={"Content-Type": "text/html"}, text="private upstream details")
        with patch.object(probe.requests, "request", return_value=response) as request:
            code, output = self.invoke("renew", "--url", "https://demo.test")
        self.assertEqual(code, 1)
        self.assertNotIn("private upstream details", output)
        request.assert_called_once()

    def test_exception_details_and_secrets_are_redacted(self):
        with patch.object(probe.requests, "request", side_effect=ConnectionError("Authorization: Bearer private-secret")) as request:
            code, output = self.invoke("renew", "--url", "https://demo.test")
        self.assertEqual(code, 1)
        self.assertNotIn("private-secret", output)
        self.assertEqual(json.loads(output)["error_type"], "ConnectionError")
        request.assert_called_once()
