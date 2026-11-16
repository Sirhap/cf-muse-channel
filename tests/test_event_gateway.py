import importlib.util
import json
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("cf_events", Path(__file__).resolve().parents[1] / "client/events.py")
events = importlib.util.module_from_spec(spec)
spec.loader.exec_module(events)


class EventGatewayTests(unittest.TestCase):
    def setUp(self):
        self.client = Mock()
        self.client.call_json.return_value = {"chat_events": [{"seq": 1}]}
        self.gateway = events.EventGateway(self.client, Mock())
        self.gateway._watch = Mock()
        self.addCleanup(self.gateway.close)

    def notify(self, session="sid", event="delta.message_done"):
        self.gateway._record(json.dumps({"event": event, "payload": {"session_id": session}}).encode(), "sid")

    def test_idle_reads_cache_until_a_matching_completion(self):
        self.assertEqual(self.gateway.history_snapshot("sid"), [{"seq": 1}])
        for _ in range(8):
            self.gateway.history_snapshot("sid")
        self.assertEqual(self.client.call_json.call_count, 1)
        self.notify("other")
        self.gateway.history_snapshot("sid")
        self.assertEqual(self.client.call_json.call_count, 1)
        self.notify()
        self.client.call_json.return_value = {"chat_events": [{"seq": 2}, {"seq": 1}]}
        self.assertEqual(self.gateway.history_snapshot("sid"), [{"seq": 1}, {"seq": 2}])
        self.assertEqual(self.client.call_json.call_count, 2)
        self.client._open.assert_not_called()

    def test_pre_submission_always_reads_fresh_history(self):
        self.gateway.history_snapshot("sid")
        self.gateway.history_snapshot("sid", limit=5, fresh=True)
        self.assertEqual(self.client.call_json.call_count, 2)

    def test_missing_events_reconcile_at_the_deadline(self):
        with patch.object(events.time, "monotonic", return_value=1):
            self.gateway.history_snapshot("sid")
        with patch.object(events.time, "monotonic", return_value=17):
            self.gateway.history_snapshot("sid")
        self.assertEqual(self.client.call_json.call_count, 2)

    def test_completion_during_history_read_is_not_lost(self):
        def read(*args, **kwargs):
            self.notify()
            return {"chat_events": []}
        self.client.call_json.side_effect = read
        self.gateway.history_snapshot("sid")
        self.client.call_json.side_effect = None
        self.gateway.history_snapshot("sid")
        self.assertEqual(self.client.call_json.call_count, 2)

    def test_disconnect_invalidates_cache_and_close_unblocks_both_connections(self):
        self.gateway.history_snapshot("sid")
        self.gateway._changed()
        self.gateway.history_snapshot("sid")
        self.assertEqual(self.client.call_json.call_count, 2)
        subscription = Mock()
        self.gateway._subscription = subscription
        self.gateway.close()
        subscription.close.assert_called_once()
        self.client.close.assert_called_once()

    def test_initial_snapshot_respects_requested_history_limit(self):
        self.gateway.history_snapshot("sid", limit=5, fresh=True)
        self.gateway.history_snapshot("sid", limit=40)
        self.assertEqual(self.client.call_json.call_count, 2)

    def test_failed_subscription_retries_do_not_expire_history_early(self):
        self.gateway._session = "sid"
        self.gateway._factory.side_effect = ConnectionError("offline")
        with patch.object(events.time, "monotonic", return_value=1):
            self.gateway.history_snapshot("sid")
        with patch.object(self.gateway._stopped, "wait", side_effect=[False, False, True]):
            self.gateway._observe("sid")
        self.assertEqual(self.gateway._factory.call_count, 3)
        with patch.object(events.time, "monotonic", return_value=10):
            self.gateway.history_snapshot("sid")
        self.assertEqual(self.client.call_json.call_count, 1)
        with patch.object(events.time, "monotonic", return_value=16):
            self.gateway.history_snapshot("sid")
        self.assertEqual(self.client.call_json.call_count, 2)

    def test_subscription_joins_split_records_and_uses_its_own_reader(self):
        self.gateway._session = "sid"
        connection = Mock()
        connection._open.return_value = 3
        payload = json.dumps({"event": "delta.message_done", "payload": {"session_id": "sid"}}).encode()
        def frame(kind, data, end=False):
            response = SimpleNamespace(status=200, body=data, data=data, end_body=end)
            return SimpleNamespace(stream_id=3, WhichOneof=lambda _: kind, **{kind: response})
        connection._read_frame.side_effect = [
            frame("response", payload[:10]),
            frame("body_chunk", payload[10:] + b"\n", True),
        ]
        connection.close.side_effect = self.gateway._stopped.set
        self.gateway._factory = Mock(return_value=connection)
        self.gateway._observe("sid")
        self.assertEqual(self.gateway._revision, 2)
        self.assertTrue(self.gateway._wake.is_set())
        self.assertEqual(connection._read_frame.call_count, 2)
        self.client._read_frame.assert_not_called()
        connection.close.assert_called_once()
        self.gateway._subscription = None
