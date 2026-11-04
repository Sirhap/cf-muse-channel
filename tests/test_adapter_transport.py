"""Transport error classification and persistence-before-receipt ordering."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from muse_adapter.config import Config
from muse_adapter.store import Store
from muse_adapter.transport import PermanentFailure, read_frames, session


class FakeSocket:
    """Feed one inbound event through the real sole-reader implementation."""

    def __init__(self, frame):
        self.frame = frame
        self.done = False
        self.send = AsyncMock()

    def __aiter__(self):
        return self

    async def __anext__(self):
        """Terminate the artificial transport after one event."""
        if self.done:
            raise StopAsyncIteration
        self.done = True
        return json.dumps(self.frame)


class TransportTests(unittest.IsolatedAsyncioTestCase):
    """These checks never connect to a network or open private setup."""

    async def test_incoming_is_durable_at_ack_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory), 'main')
            self.addCleanup(store.close)
            socket = FakeSocket({'type': 'message', 'source': 'user', 'kind': 'task', 'id': 'one', 'content': 'work'})
            async def sent(raw):
                """The DB row must already exist when the ACK reaches the socket."""
                self.assertEqual(store.task('one')['status'], 'queued')
                self.assertEqual(json.loads(raw)['type'], 'received')
            socket.send.side_effect = sent
            with self.assertRaises(ConnectionError):
                await read_frames(socket, store)
            socket.send.assert_awaited_once()

    async def test_write_failure_prevents_transport_acknowledgement(self):
        socket = FakeSocket({'type': 'message', 'id': 'one'})
        store = Mock()
        store.receive.side_effect = OSError('sensitive disk failure')
        with self.assertRaises(OSError):
            await read_frames(socket, store)
        socket.send.assert_not_awaited()

    async def test_unknown_or_explicit_error_frame_fails_closed(self):
        for frame in ({'type': 'error', 'code': 'id_conflict'}, {'type': 'invented'}):
            with self.subTest(frame=frame), self.assertRaises(PermanentFailure):
                await read_frames(FakeSocket(frame), Mock())

    async def test_wrong_room_handshake_never_sends_pending_messages(self):
        socket = AsyncMock()
        socket.recv.return_value = json.dumps({'type': 'ready', 'role': 'muse', 'room': 'other'})
        manager = AsyncMock()
        manager.__aenter__.return_value = socket
        with tempfile.TemporaryDirectory() as directory:
            config = Config('wss://example.com', 'main', 'private-test-token', Path(directory))
            with patch('muse_adapter.transport.connect', return_value=manager) as connection:
                with self.assertRaises(PermanentFailure):
                    await session(config, Mock())
                self.assertIs(connection.call_args.kwargs['proxy'], True)
                socket.send.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
