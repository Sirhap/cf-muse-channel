"""One authenticated outbound socket and durable receipt-driven delivery."""
from __future__ import annotations

import asyncio
import fcntl
import json
import os
import random

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus, InvalidHandshake

from .store import Store


class PermanentFailure(RuntimeError):
    """Authorization, protocol or persistence needs operator attention."""


async def read_frames(socket, store):
    """Own the sole recv loop; persist inbound tasks before acknowledging them."""
    async for raw in socket:
        try:
            frame = json.loads(raw)
            if not isinstance(frame, dict):
                raise ValueError('invalid frame')
            kind = frame.get('type')
            if kind == 'message':
                if frame.get("kind") == "cancel":
                    store.receive_cancel(frame)
                else:
                    store.receive(frame)
                await socket.send(json.dumps({'type': 'received', 'id': frame['id'], 'source': 'user'}))
            elif kind in ('stored', 'delivered'):
                if kind == 'delivered' and frame.get('recipient') != 'user':
                    raise ValueError('invalid recipient')
                store.receipt(frame)
            elif kind == 'error':
                raise PermanentFailure('protocol rejected')
            elif kind not in ('pong', 'acknowledged'):
                raise ValueError('unknown frame')
        except (ValueError, TypeError, KeyError) as error:
            raise PermanentFailure('invalid protocol') from error
    raise ConnectionError('connection ended')


async def send_frames(socket, store):
    """Resend only after reconnect, always reusing the committed message IDs."""
    sent = set()
    loop = asyncio.get_running_loop()
    last_ping = loop.time()
    while True:
        for frame in store.pending():
            if frame['id'] not in sent:
                await socket.send(json.dumps(frame, ensure_ascii=False))
                sent.add(frame['id'])
        if loop.time() - last_ping >= 30:
            await socket.send(json.dumps({'type': 'ping'}))
            last_ping = loop.time()
        await asyncio.sleep(0.2)


async def session(config, store):
    """Authenticate, then independently read frames and drain durable output."""
    async with connect(config.socket_url, additional_headers={'Authorization': 'Bearer ' + config.muse_token},
                       open_timeout=15, close_timeout=5, max_size=65536,
                       ping_interval=20, ping_timeout=20, proxy=None if config.server_url.startswith('ws:') else True) as socket:
        ready = json.loads(await asyncio.wait_for(socket.recv(), timeout=15))
        if not isinstance(ready, dict) or ready.get('type') != 'ready' or ready.get('role') != 'muse' or ready.get('room') != config.room:
            raise PermanentFailure('invalid handshake')
        store.transport('connected')
        tasks = [asyncio.create_task(read_frames(socket, store)), asyncio.create_task(send_frames(socket, store))]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


async def run(config):
    """Keep a single connector; back off network failures, never reset task ownership."""
    store = Store(config.state_dir, config.room)
    lock = (config.state_dir / 'connector.lock').open('a')
    os.fchmod(lock.fileno(), 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise PermanentFailure('connector already running') from error
        attempts = 0
        while True:
            try:
                await session(config, store)
            except InvalidStatus as error:
                if error.response.status_code in (401, 403):
                    store.transport('authentication_failed')
                    raise PermanentFailure('authentication failed') from None
            except ConnectionClosed as error:
                if error.rcvd and error.rcvd.code == 4001:
                    store.transport('replaced')
                    raise PermanentFailure('connection replaced') from None
            except (OSError, asyncio.TimeoutError, ConnectionError, InvalidHandshake):
                pass
            except PermanentFailure:
                store.transport('operator_attention')
                raise
            attempts = min(attempts + 1, 7)
            store.transport('reconnecting')
            await asyncio.sleep(min(60, 2 ** attempts) + random.random())
    finally:
        lock.close()
        store.close()
