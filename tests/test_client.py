"""Check single-submission safety and the real SDK history event shape offline."""
import importlib.util
import json
from pathlib import Path
import tempfile
from concurrent.futures import ThreadPoolExecutor
import threading
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("probe", Path(__file__).resolve().parents[1] / "client/probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ChatTests(unittest.TestCase):
    def test_concurrent_calls_claim_the_receipt_before_any_external_operation(self):
        barrier = threading.Barrier(2)
        client = Mock()
        client.call_json.side_effect = [
            {"session_id": "demo-session"}, {"chat_events": []},
            {"chat_events": [
                {"seq": 1, "event_name": "message.user"},
                {"seq": 2, "event_name": "message.assistant", "payload": {
                    "status": "completed", "display_text": "Only one send"}},
            ]},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            def attempt():
                barrier.wait(timeout=5)
                try:
                    return probe.chat_once(client, "test", 1, path)["state"]
                except ValueError:
                    return "already_claimed"
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(lambda _: attempt(), range(2)))
            self.assertCountEqual(results, ["succeeded", "already_claimed"])
            client._open.assert_called_once()

    def test_uses_real_history_shape_and_submits_only_once(self):
        client = Mock()
        client.call_json.side_effect = [
            {"session_id": "demo-session"},
            {"chat_events": [{"seq": 1, "event_name": "message.assistant", "payload": {
                "status": "completed", "display_text": "Earlier answer"}}]},
            {"chat_events": [
                {"seq": 1, "event_name": "message.assistant", "payload": {
                    "status": "completed", "display_text": "Earlier answer"}},
                {"seq": 2, "event_name": "message.user"},
                {"seq": 3, "event_name": "message.assistant", "payload": {
                    "status": "completed", "display_text": "CF demo OK"}},
            ]},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            result = probe.chat_once(client, "test", 1, path)
            self.assertEqual(result["state"], "succeeded")
            self.assertEqual(result["text"], "CF demo OK")
            client._open.assert_called_once()
            with self.assertRaises(ValueError):
                probe.chat_once(client, "test", 1, path)
            client._open.assert_called_once()

    def test_uncertain_send_leaves_a_receipt_and_is_not_retried(self):
        client = Mock()
        client.call_json.return_value = {"session_id": "demo-session"}
        client._open.side_effect = TimeoutError("unknown submission")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            with self.assertRaises(TimeoutError):
                probe.chat_once(client, "test", 1, path)
            self.assertEqual(json.loads(path.read_text())["state"], "submission_unknown")
            self.assertFalse(json.loads(path.read_text())["retry_safe"])
            client._open.assert_called_once()

    def test_result_check_recovers_a_reply_without_creating_or_sending_anything(self):
        client = Mock()
        client.call_json.return_value = {"chat_events": [
            {"seq": 4, "event_name": "message.user"},
            {"seq": 5, "event_name": "message.assistant", "payload": {
                "status": "completed", "display_text": "Recovered result"}},
        ]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            probe.write_receipt(path, {"state": "submission_unknown", "session_id": "bound-session",
                                       "baseline_seq": 3, "retry_safe": False})
            result = probe.wait_result(client, 1, path)
            self.assertEqual(result["state"], "succeeded")
            self.assertEqual(result["text"], "Recovered result")
            self.assertTrue(result["submission_confirmed"])
            self.assertEqual(client.call_json.call_args.args[0], "chat.history")
            self.assertEqual(client.call_json.call_args.kwargs["body"]["session_id"], "bound-session")
            client._open.assert_not_called()

    def test_result_check_uses_recorded_success_without_polling(self):
        client = Mock()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            probe.write_receipt(path, {"state": "succeeded", "text": "Saved result"})
            self.assertEqual(probe.wait_result(client, 1, path)["text"], "Saved result")
            client.call_json.assert_not_called()
            client._open.assert_not_called()

    def test_receipt_without_submission_binding_never_replays_a_task(self):
        client = Mock()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            probe.write_receipt(path, {"state": "preparing_session", "retry_safe": False})
            with self.assertRaises(ValueError):
                probe.wait_result(client, 1, path)
            client.call_json.assert_not_called()
            client._open.assert_not_called()


if __name__ == "__main__":
    unittest.main()
