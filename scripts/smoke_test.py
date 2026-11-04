#!/usr/bin/env python3
"""Exercise the real local Worker and Python adapter without invoking Muse AI."""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

from websockets.asyncio.client import connect

ROOT = Path(__file__).resolve().parents[1]
CHECKS = []


def check(name: str, condition: bool) -> None:
    """Report only a fixed test name and verdict."""
    if not condition:
        raise AssertionError(name)
    CHECKS.append(name)
    print('PASS ' + name, flush=True)


def free_port() -> int:
    """Reserve an unused local TCP listener for this isolated runtime."""
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def stop(process) -> None:
    """Stop only a process group created by this smoke test."""
    if process and process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)


def cli(config: Path, *args, expected=0):
    """Call the real CLI with bounded execution and sanitized failure output."""
    result = subprocess.run([sys.executable, '-m', 'muse_adapter', '--config', str(config), *args],
                            cwd=ROOT, capture_output=True, text=True, timeout=10,
                            env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))
    if result.returncode != expected:
        raise AssertionError('CLI failed: ' + args[0] + ' (exit ' + str(result.returncode) + ')')
    return json.loads(result.stdout) if result.stdout.strip() else {}


async def wait_health(base: str, process) -> None:
    """Wait for a real HTTP health response without any proxy routing."""
    def probe():
        """Keep loopback health traffic outside ambient HTTP proxies."""
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(base + '/health', timeout=1) as response:
            return response.status == 200
    for _ in range(150):
        if process.poll() is not None:
            raise AssertionError('Worker exited before readiness')
        try:
            if await asyncio.to_thread(probe):
                return
        except (urllib.error.URLError, OSError):
            pass
        await asyncio.sleep(0.2)
    raise AssertionError('Worker readiness timed out')


async def event(ws, kind: str, *, message_id=None):
    """Read past unrelated receipts, keeping every wait bounded."""
    async with asyncio.timeout(10):
        while True:
            row = json.loads(await ws.recv())
            if row.get('type') == kind and (message_id is None or row.get('id') == message_id):
                return row
            if row.get('type') == 'message':
                raise AssertionError('Unexpected incoming message while waiting for ' + kind)


async def task_poll(config: Path, task_id: str):
    """Wait for incoming persistence and a genuine CLI claim, not simulated dispatch."""
    for _ in range(60):
        payload = await asyncio.to_thread(cli, config, 'poll')
        if payload.get('count'):
            check('hook polling claims the exact task', payload['messages'][0]['msgid'] == task_id)
            return payload
        await asyncio.sleep(0.1)
    raise AssertionError('Adapter did not persist and expose incoming task')


async def run_roundtrip(base: str, config: Path, user_token: str):
    """Test transport, local state, formal results and retry idempotency together."""
    headers = {'Authorization': 'Bearer ' + user_token}
    async with connect(base.replace('http:', 'ws:') + '/ws/main?role=user',
                       additional_headers=headers, proxy=None, open_timeout=5, close_timeout=2) as user:
        check('user WebSocket authenticated', (await event(user, 'ready'))['role'] == 'user')
        task_id = 'smoke-task'
        task = {'type': 'message', 'id': task_id, 'kind': 'task', 'content': 'local adapter transport check'}
        await user.send(json.dumps(task))
        stored = await event(user, 'stored', message_id=task_id)
        check('CF accepts the task once', stored.get('duplicate') is False)
        await event(user, 'delivered', message_id=task_id)
        check('adapter confirms durable receipt', True)
        await task_poll(config, task_id)
        check('dispatched task is not polled twice', (await asyncio.to_thread(cli, config, 'poll')).get('count') == 0)
        await asyncio.to_thread(cli, config, 'start', '--msgid', task_id, '--run-id', 'local-smoke-not-real-muse')
        await asyncio.to_thread(cli, config, 'update', '--msgid', task_id, '--text', 'adapter progress proof')
        progress = await event(user, 'message')
        check('real adapter progress reaches user', progress.get('kind') == 'progress' and progress.get('reply_to') == task_id)
        await user.send(json.dumps({'type': 'received', 'id': progress['id'], 'source': 'muse'}))
        await event(user, 'acknowledged', message_id=progress['id'])
        first = await asyncio.to_thread(cli, config, 'reply', '--msgid', task_id, '--text', 'adapter result proof')
        repeated = await asyncio.to_thread(cli, config, 'reply', '--msgid', task_id, '--text', 'adapter result proof')
        check('formal reply is locally idempotent', first == repeated)
        result = await event(user, 'message')
        check('canonical formal result reaches user', result.get('id') == 'result:' + task_id and result.get('kind') == 'result')
        await user.send(json.dumps({'type': 'received', 'id': result['id'], 'source': 'muse'}))
        await event(user, 'acknowledged', message_id=result['id'])
        await user.send(json.dumps(task))
        duplicate = await event(user, 'stored', message_id=task_id)
        check('same task ID is not recreated after completion', duplicate.get('duplicate') is True)
        check('duplicate does not redispatch executed task', (await asyncio.to_thread(cli, config, 'poll')).get('count') == 0)
        await asyncio.sleep(0.3)
        receipts = await asyncio.to_thread(cli, config, 'results', '--msgid', task_id)
        serialized = json.dumps(receipts)
        check('delivery evidence distinguishes client reception', any(row['id'] == 'result:' + task_id and row['cf_stored'] and row['client_received'] for row in receipts['results']))


async def protocol_checks(base, user_token, muse_token):
    """Exercise authorization, browser handshakes and bounded replay on real sockets."""
    import base64
    from websockets.exceptions import InvalidStatus
    endpoint = base.replace('http:', 'ws:')
    for role, token, room in [('muse', user_token, 'main'), ('user', user_token, 'other')]:
        try:
            async with connect(endpoint + '/ws/' + room + '?role=' + role,
                               additional_headers={'Authorization': 'Bearer ' + token}, proxy=None):
                raise AssertionError('unauthorized connection accepted')
        except InvalidStatus as error:
            check('unauthorized role or room rejected: ' + role + '/' + room, error.response.status_code == 401)
    protocol_token = base64.urlsafe_b64encode(user_token.encode()).decode().rstrip('=')
    async with connect(endpoint + '/ws/main?role=user', subprotocols=['cf-muse-v1', 'auth.' + protocol_token], proxy=None) as user:
        await event(user, 'ready')
        check('browser subprotocol authenticated without echoing token', user.subprotocol == 'cf-muse-v1')
        for index in range(25):
            await user.send(json.dumps({'type': 'message', 'id': 'batch-' + str(index), 'content': 'bounded replay fixture'}))
            await event(user, 'stored')
        async with connect(endpoint + '/ws/main?role=muse', additional_headers={'Authorization': 'Bearer ' + muse_token}, proxy=None) as muse:
            await event(muse, 'ready')
            initial = [await event(muse, 'message') for _ in range(20)]
            try:
                await asyncio.wait_for(muse.recv(), timeout=0.2)
                raise AssertionError('replay exceeded in-flight window')
            except asyncio.TimeoutError:
                check('replay is bounded to twenty unacknowledged frames', True)
            for row in initial:
                await muse.send(json.dumps({'type': 'received', 'id': row['id'], 'source': 'user'}))
            received, acknowledgements = len(initial), 0
            while acknowledgements < 25:
                row = json.loads(await asyncio.wait_for(muse.recv(), timeout=5))
                if row['type'] == 'message':
                    received += 1
                    await muse.send(json.dumps({'type': 'received', 'id': row['id'], 'source': 'user'}))
                elif row['type'] == 'acknowledged':
                    acknowledgements += 1
            check('receipt refills replay window without dropping backlog', received == 25)
            await muse.send(json.dumps({'type': 'message', 'id': 'result:missing', 'kind': 'result', 'reply_to': 'missing', 'content': 'wrong route'}))
            check('result cannot refer to an unknown task', (await event(muse, 'error')).get('code') == 'unknown_task')
            await muse.send(json.dumps({'type': 'received', 'id': 'batch-0', 'source': 'muse'}))
            check('receiver cannot acknowledge its own role', (await event(muse, 'error')).get('code') == 'invalid_receipt')
    def api_security():
        """Verify the new API never falls through to public assets or accepts Muse keys."""
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        cases = [('/api/rooms/main/messages', None, None, 401),
                 ('/api/rooms/main/messages', muse_token, None, 401),
                 ('/api/rooms/other/messages', user_token, None, 401),
                 ('/api/rooms/main/messages?after=-1', user_token, None, 400),
                 ('/api/rooms/main/messages?limit=51', user_token, None, 400),
                 ('/api/rooms/main/tasks', user_token, b'x' * 65537, 400)]
        for index, (path, token, payload, expected) in enumerate(cases):
            headers = {'Authorization': 'Bearer ' + token} if token else {}
            request = urllib.request.Request(base + path, data=payload, headers=headers)
            try:
                with opener.open(request, timeout=5) as response:
                    code = response.status
            except urllib.error.HTTPError as error:
                code = error.code
            check('HTTP API authorization and bounds ' + str(index + 1), code == expected)
    await asyncio.to_thread(api_security)
    return None


async def main() -> None:
    """Use disposable credentials and clean up all child processes on failure."""
    wrangler = ROOT / 'node_modules/.bin/wrangler'
    executable = str(wrangler) if wrangler.exists() else shutil.which('wrangler')
    if not executable:
        raise SystemExit('Install npm dependencies before running this test.')
    with tempfile.TemporaryDirectory(prefix='cf-muse-smoke-') as temporary:
        folder = Path(temporary)
        port, inspector = free_port(), free_port()
        base = f'http://127.0.0.1:{port}'
        user_token, muse_token = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        (folder / '.dev.vars').write_text('USER_TOKEN=' + user_token + '\nMUSE_TOKEN=' + muse_token + '\n')
        (folder / '.dev.vars').chmod(0o600)
        worker = json.loads((ROOT / 'wrangler.jsonc').read_text())
        worker['main'] = str(ROOT / worker['main'])
        worker['assets']['directory'] = str(ROOT / 'public')
        (folder / 'wrangler.json').write_text(json.dumps(worker))
        config = folder / 'config.json'
        config.write_text(json.dumps({'server_url': base.replace('http:', 'ws:'), 'room': 'main',
                                      'muse_token': muse_token, 'state_dir': str(folder / 'adapter-state'),
                                      'allow_insecure_localhost': True}))
        config.chmod(0o600)
        environment = dict(os.environ, CI='true', WRANGLER_SEND_METRICS='false', PYTHONDONTWRITEBYTECODE='1')
        environment['NO_PROXY'] = environment.get('NO_PROXY', '') + ',127.0.0.1,localhost'
        worker_process, adapter = None, None
        with (folder / 'worker.log').open('w') as worker_log, (folder / 'adapter.log').open('w') as adapter_log:
            try:
                worker_process = subprocess.Popen([executable, 'dev', '--local', '--config', str(folder / 'wrangler.json'),
                    '--ip', '127.0.0.1', '--port', str(port), '--inspector-port', str(inspector),
                    '--persist-to', str(folder / 'cf-state'), '--show-interactive-dev-session=false', '--log-level', 'error'],
                    cwd=folder, env=environment, stdout=worker_log, stderr=subprocess.STDOUT, start_new_session=True)
                await wait_health(base, worker_process)
                await protocol_checks(base, user_token, muse_token)
                adapter = subprocess.Popen([sys.executable, '-m', 'muse_adapter', '--config', str(config), 'run'],
                    cwd=ROOT, env=environment, stdout=adapter_log, stderr=subprocess.STDOUT, start_new_session=True)
                await run_roundtrip(base, config, user_token)
                check('connector remains alive through receipt handling', adapter.poll() is None)
                stop(adapter)
                headers = {'Authorization': 'Bearer ' + user_token}
                async with connect(base.replace('http:', 'ws:') + '/ws/main?role=user', additional_headers=headers, proxy=None) as user:
                    await event(user, 'ready')
                    await user.send(json.dumps({'type': 'message', 'id': 'survive-restart', 'kind': 'task', 'content': 'restart test'}))
                    check('offline task is accepted while adapter is stopped', (await event(user, 'stored'))['id'] == 'survive-restart')
                stop(worker_process)
                worker_process = subprocess.Popen([executable, 'dev', '--local', '--config', str(folder / 'wrangler.json'),
                    '--ip', '127.0.0.1', '--port', str(port), '--inspector-port', str(inspector),
                    '--persist-to', str(folder / 'cf-state'), '--show-interactive-dev-session=false', '--log-level', 'error'],
                    cwd=folder, env=environment, stdout=worker_log, stderr=subprocess.STDOUT, start_new_session=True)
                await wait_health(base, worker_process)
                adapter = subprocess.Popen([sys.executable, '-m', 'muse_adapter', '--config', str(config), 'run'],
                    cwd=ROOT, env=environment, stdout=adapter_log, stderr=subprocess.STDOUT, start_new_session=True)
                await task_poll(config, 'survive-restart')
                check('queued task survives actual Worker and adapter restart', True)
                await asyncio.to_thread(cli, config, 'start', '--msgid', 'survive-restart', '--run-id', 'local-restart-fixture')
                stop(adapter)
                check('unknown execution ownership survives adapter exit', (await asyncio.to_thread(cli, config, 'poll'))['count'] == 0)
                await asyncio.to_thread(cli, config, 'reply', '--msgid', 'survive-restart', '--text', 'offline local result')
                adapter = subprocess.Popen([sys.executable, '-m', 'muse_adapter', '--config', str(config), 'run'],
                    cwd=ROOT, env=environment, stdout=adapter_log, stderr=subprocess.STDOUT, start_new_session=True)
                async with connect(base.replace('http:', 'ws:') + '/ws/main?role=user', additional_headers=headers, proxy=None) as user:
                    await event(user, 'ready')
                    reply = await event(user, 'message')
                    check('durable outbox reply survives connector restart', reply['id'] == 'result:survive-restart')
                    await user.send(json.dumps({'type': 'received', 'id': reply['id'], 'source': 'muse'}))
                    await event(user, 'acknowledged', message_id=reply['id'])
            finally:
                stop(adapter)
                stop(worker_process)
        print(f'{len(CHECKS)}/{len(CHECKS)} local integration checks passed; real Muse AI not invoked.', flush=True)


if __name__ == '__main__':
    asyncio.run(main())
