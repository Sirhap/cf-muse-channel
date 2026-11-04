"""Check durable ownership, recovery gates, cancellation and receipt reconciliation."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import sqlite3
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from muse_adapter.store import Store


class StoreTests(unittest.TestCase):
    """Exercise actual SQLite transactions shared by independent CLI processes."""

    def setUp(self):
        """Each case owns one private directory and real database."""
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.store = Store(self.directory, 'main')
        self.addCleanup(self.store.close)

    def receive(self, task_id='one', text='task'):
        """Use a canonical CF task frame."""
        self.store.receive({'type': 'message', 'source': 'user', 'kind': 'task', 'id': task_id, 'content': text})

    def started(self):
        """Claim and bind a task to a real-shaped fixture run ID."""
        self.receive()
        self.store.poll()
        self.store.start('one', 'run-test')

    def test_queued_task_dispatches_while_another_task_runs(self):
        """A long task must not serialise later messages in the same room."""
        self.started()
        self.receive('two', 'quick reply please')
        claimed = self.store.poll()
        self.assertEqual(claimed['count'], 1)
        self.assertEqual(claimed['messages'][0]['msgid'], 'two')
        self.assertEqual(self.store.task('two')['status'], 'dispatched')
        self.assertEqual(self.store.start('two', 'run-two')['status'], 'running')
        self.assertEqual(self.store.task('one')['status'], 'running')
        self.assertEqual(self.store.poll()['count'], 0)

    def test_media_result_carries_reference_not_bytes(self):
        self.started()
        media = {'id': 'media-1', 'filename': 'intro.mp4', 'mime': 'video/mp4', 'size': 1172525}
        result = self.store.enqueue('one', '视频已生成', 'result', media=media)
        payload = json.loads(self.store.db.execute('SELECT payload FROM outbox WHERE id=?', (result['id'],)).fetchone()[0])
        self.assertEqual(payload['media'], media)
        self.assertEqual(self.store.task('one')['status'], 'replying')

    def test_invalid_media_reference_rejected(self):
        self.started()
        for media in [{'id': 'media-1', 'filename': '../x.mp4', 'mime': 'video/mp4', 'size': 10},
                      {'id': 'media-1', 'filename': 'x.mp4', 'mime': 'application/octet-stream', 'size': 10},
                      {'id': 'media-1', 'filename': 'x.mp4', 'mime': 'video/mp4', 'size': 11 * 1024 * 1024}]:
            with self.assertRaises(ValueError):
                self.store.enqueue('one', 'bad media', 'result', media=media)
        with self.assertRaises(ValueError):
            self.store.enqueue('one', 'progress media', 'progress',
                               media={'id': 'media-1', 'filename': 'x.mp4', 'mime': 'video/mp4', 'size': 10})

    def test_replay_never_resets_execution_state(self):
        self.started()
        self.receive()
        self.assertEqual(self.store.task('one')['status'], 'running')
        self.assertEqual(self.store.poll()['count'], 0)
        with self.assertRaises(ValueError):
            self.receive(text='changed text')

    def test_claim_is_exclusive_across_database_connections(self):
        self.receive()
        def poll():
            """Represent another independent platform poller."""
            store = Store(self.directory, 'main')
            try:
                return store.poll()['count']
            finally:
                store.close()
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(lambda _: poll(), range(2))), [0, 1])

    def test_restart_preserves_unknown_execution_without_automatic_retry(self):
        self.started()
        other = Store(self.directory, 'main')
        try:
            self.assertEqual(other.poll()['count'], 0)
            self.assertEqual(other.task('one')['run_id'], 'run-test')
        finally:
            other.close()

    def test_different_worker_cannot_take_over_running_task(self):
        self.started()
        with self.assertRaises(ValueError):
            self.store.start('one', 'other-run')
        self.assertEqual(self.store.start('one', 'run-test')['status'], 'running')

    def test_missing_run_identifier_does_not_start_task(self):
        self.receive()
        self.store.poll()
        with self.assertRaises(ValueError):
            self.store.start('one', '')
        self.assertEqual(self.store.task('one')['status'], 'dispatched')

    def test_one_canonical_formal_reply_in_same_commit(self):
        self.started()
        first = self.store.enqueue('one', 'answer', 'result')
        self.assertEqual(first['id'], 'result:one')
        self.assertEqual(self.store.enqueue('one', 'answer', 'result'), first)
        with self.assertRaises(ValueError):
            self.store.enqueue('one', 'different answer', 'result')
        self.assertEqual(len(self.store.pending()), 1)
        self.assertEqual(self.store.task('one')['status'], 'replying')

    def test_receipt_stages_are_distinct_and_reconcilable_after_disconnect(self):
        self.started()
        self.store.enqueue('one', 'answer', 'result')
        self.store.receipt({'type': 'stored', 'id': 'result:one', 'received': False})
        result = self.store.results()[0]
        self.assertTrue(result['cf_stored'])
        self.assertFalse(result['client_received'])
        self.assertEqual(self.store.task('one')['status'], 'completed')
        self.assertEqual(len(self.store.pending()), 1)  # Query same ID again after reconnect.
        self.store.receipt({'type': 'stored', 'id': 'result:one', 'received': True})
        self.assertEqual(self.store.pending(), [])
        self.assertTrue(self.store.results()[0]['client_received'])

    def test_receipt_for_unknown_id_does_not_finish_task(self):
        self.started()
        with self.assertRaises(ValueError):
            self.store.receipt({'type': 'stored', 'id': 'result:unknown'})
        self.assertEqual(self.store.task('one')['status'], 'running')

    def test_progress_does_not_mark_task_completed(self):
        self.started()
        progress = self.store.enqueue('one', 'working', 'progress')
        self.store.receipt({'type': 'stored', 'id': progress['id']})
        self.assertEqual(self.store.task('one')['status'], 'running')

    def test_running_cancel_is_cooperative_and_requires_cancellation_final(self):
        self.started()
        self.assertFalse(self.store.cancel('one')['stopped'])
        with self.assertRaises(ValueError):
            self.store.enqueue('one', 'still working', 'progress')
        with self.assertRaises(ValueError):
            self.store.enqueue('one', 'normal success', 'result')
        self.store.enqueue('one', 'stopped', 'result', cancelled=True)
        self.assertEqual(self.store.task('one')['status'], 'replying')

    def test_cancel_before_dispatch_never_runs_task(self):
        self.receive()
        self.store.cancel('one')
        self.assertEqual(self.store.poll()['count'], 0)
        with self.assertRaises(ValueError):
            self.store.start('one', 'a-run')
        self.assertEqual(self.store.pending()[0]['kind'], 'result')

    def test_recover_requires_explicit_operator_and_retains_audit(self):
        self.started()
        with self.assertRaises(ValueError):
            self.store.recover('one', False)
        self.store.recover('one', True)
        self.assertEqual(self.store.poll()['count'], 1)
        self.assertIsNone(self.store.task('one')['run_id'])
        self.assertEqual(self.store.db.execute('SELECT run_id FROM audit').fetchone()[0], 'run-test')

    def test_recover_after_result_is_forbidden(self):
        self.started()
        self.store.enqueue('one', 'answer', 'result')
        with self.assertRaises(ValueError):
            self.store.recover('one', True)

    def test_room_isolation_in_shared_database(self):
        self.receive()
        other = Store(self.directory, 'other')
        try:
            self.assertEqual(other.poll()['count'], 0)
            with self.assertRaises(ValueError):
                other.task('one')
        finally:
            other.close()

    def test_oversize_reply_does_not_commit_outbox_or_state(self):
        self.started()
        with self.assertRaises(ValueError):
            self.store.enqueue('one', '汉' * 22000, 'result')
        self.assertEqual(self.store.pending(), [])
        self.assertEqual(self.store.task('one')['status'], 'running')

    def test_private_permissions_and_fail_closed_corrupt_database(self):
        self.assertEqual((self.directory / 'channel.sqlite3').stat().st_mode & 0o777, 0o600)
        with tempfile.TemporaryDirectory() as other:
            path = Path(other)
            (path / 'channel.sqlite3').write_text('not a sqlite file')
            with self.assertRaises(sqlite3.DatabaseError):
                Store(path, 'main')
            self.assertEqual((path / 'channel.sqlite3').read_text(), 'not a sqlite file')


    def test_remote_cancel_receipt_is_atomic_and_idempotent(self):
        self.started()
        frame = {'type': 'message', 'source': 'user', 'kind': 'cancel', 'id': 'cancel:one',
                 'reply_to': 'one', 'content': 'cancel_requested'}
        self.store.receive_cancel(frame)
        self.store.receive_cancel(frame)
        self.assertTrue(self.store.task('one')['cancel_requested'])
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM controls').fetchone()[0], 1)
        with self.assertRaises(ValueError):
            self.store.enqueue('one', 'keep executing', 'progress')

    def test_invalid_remote_cancel_does_not_modify_task(self):
        self.started()
        with self.assertRaises(ValueError):
            self.store.receive_cancel({'source': 'muse', 'kind': 'cancel', 'id': 'cancel:one',
                                       'reply_to': 'one', 'content': 'cancel_requested'})
        self.assertFalse(self.store.task('one')['cancel_requested'])

    def test_queued_remote_cancel_generates_one_formal_result_without_dispatch(self):
        self.receive()
        frame = {'type': 'message', 'source': 'user', 'kind': 'cancel', 'id': 'cancel:one',
                 'reply_to': 'one', 'content': 'cancel_requested'}
        self.store.receive_cancel(frame)
        self.store.receive_cancel(frame)
        self.assertEqual(len(self.store.pending()), 1)
        self.assertEqual(self.store.poll()['count'], 0)


if __name__ == '__main__':
    unittest.main()
