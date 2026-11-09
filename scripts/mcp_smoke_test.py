#!/usr/bin/env python3
"""Real stdio MCP → local CF Worker → real adapter integration, with no AI execution."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from websockets.asyncio.client import connect
from scripts.smoke_test import check, cli, event, free_port, stop, task_poll, wait_health, CHECKS


async def call(session, name, args):
    """Exercise a genuine tools/call exchange rather than invoking server functions."""
    result = await session.call_tool(name, args)
    if result.isError:
        raise AssertionError('MCP tool failed: ' + name)
    return result.structuredContent or json.loads(result.content[0].text)


async def main():
    """Use private disposable files and always terminate the created child processes."""
    executable = ROOT / 'node_modules/.bin/wrangler'
    with tempfile.TemporaryDirectory(prefix='cf-muse-mcp-smoke-') as temporary:
        folder = Path(temporary)
        port = free_port()
        base = f'http://127.0.0.1:{port}'
        user_token, muse_token = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        (folder / '.dev.vars').write_text('USER_TOKEN=' + user_token + '\nMUSE_TOKEN=' + muse_token + '\n')
        (folder / '.dev.vars').chmod(0o600)
        worker = json.loads((ROOT / 'wrangler.jsonc').read_text())
        worker['main'] = str(ROOT / worker['main'])
        worker['assets']['directory'] = str(ROOT / 'public')
        (folder / 'wrangler.json').write_text(json.dumps(worker))
        config = folder / 'adapter.json'
        config.write_text(json.dumps({'server_url': base.replace('http:', 'ws:'), 'room': 'main',
                                      'muse_token': muse_token, 'state_dir': str(folder / 'state'),
                                      'allow_insecure_localhost': True}))
        mcp_config = folder / 'mcp.json'
        mcp_config.write_text(json.dumps({'server_url': base, 'room': 'main', 'user_token': user_token,
                                          'allow_insecure_localhost': True}))
        for path in (config, mcp_config):
            path.chmod(0o600)
        environment = dict(os.environ, CI='true', WRANGLER_SEND_METRICS='false', PYTHONDONTWRITEBYTECODE='1',
                           CF_MUSE_MCP_CONFIG=str(mcp_config))
        worker_process = adapter = None
        with (folder / 'server.log').open('w') as output:
            try:
                worker_process = subprocess.Popen([str(executable), 'dev', '--local', '--config', str(folder / 'wrangler.json'),
                    '--port', str(port), '--ip', '127.0.0.1', '--inspector-port', str(free_port()),
                    '--persist-to', str(folder / 'cf-state'), '--show-interactive-dev-session=false', '--log-level', 'error'],
                    cwd=folder, env=environment, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
                await wait_health(base, worker_process)
                adapter = subprocess.Popen([sys.executable, '-m', 'muse_adapter', '--config', str(config), 'run'],
                    cwd=ROOT, env=environment, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
                params = StdioServerParameters(command=sys.executable, args=[str(ROOT / 'scripts/run_mcp.py')], cwd=str(folder), env=environment)
                async with stdio_client(params, errlog=output) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        names = {tool.name for tool in (await session.list_tools()).tools}
                        check('official SDK stdio handshake exposes five tools', names == {'send_message', 'get_task', 'get_messages', 'cancel_task', 'wait_for_task'})
                        invalid = await session.call_tool('send_message', {'task_id': '../bad', 'content': 'text'})
                        check('invalid tool arguments return an MCP error', invalid.isError)
                        invalid_wait = await session.call_tool('wait_for_task', {'task_id': '../bad'})
                        check('wait_for_task invalid argument returns an MCP error', invalid_wait.isError)
                        async with connect(base.replace('http:', 'ws:') + '/ws/main?role=user',
                                           additional_headers={'Authorization': 'Bearer ' + user_token}, proxy=None) as user:
                            await event(user, 'ready')
                            first = await call(session, 'send_message', {'task_id': 'mcp-one', 'content': 'test MCP adapter path'})
                            check('send_message persists a real CF task', first['cf_stored'] and not first['duplicate'])
                            repeated = await call(session, 'send_message', {'task_id': 'mcp-one', 'content': 'test MCP adapter path'})
                            check('same tool ID is idempotent', repeated['duplicate'])
                            conflict = await session.call_tool('send_message', {'task_id': 'mcp-one', 'content': 'different'})
                            check('same ID with different task is rejected', conflict.isError)
                            await user.send(json.dumps({'type': 'ping'}))
                            await event(user, 'pong')
                            check('MCP calls do not replace the browser socket', True)
                            await task_poll(config, 'mcp-one')
                            await asyncio.to_thread(cli, config, 'start', '--msgid', 'mcp-one', '--run-id', 'local-mcp-smoke-fixture')
                            await asyncio.to_thread(cli, config, 'update', '--msgid', 'mcp-one', '--text', 'MCP progress')
                            await event(user, 'message')
                            snap = await call(session, 'wait_for_task', {'task_id': 'mcp-one', 'timeout_seconds': 1.0, 'poll_interval': 0.5})
                            check('wait_for_task returns snapshot on timeout', snap.get('timeout') is True and snap.get('completed') is False and snap.get('task_id') == 'mcp-one')
                            await asyncio.to_thread(cli, config, 'reply', '--msgid', 'mcp-one', '--text', 'MCP final result')
                            await event(user, 'message')
                            task = await call(session, 'wait_for_task', {'task_id': 'mcp-one', 'timeout_seconds': 5.0, 'poll_interval': 0.5})
                            check('wait_for_task returns actual formal result and receipt evidence', task['result']['content'] == 'MCP final result' and task['muse_received'] and not task.get('timeout'))
                            task_get = await call(session, 'get_task', {'task_id': 'mcp-one'})
                            check('get_task returns actual formal result and receipt evidence', task_get['result']['content'] == 'MCP final result' and task_get['muse_received'])
                            page = await call(session, 'get_messages', {'after': 0, 'limit': 1, 'task_id': 'mcp-one'})
                            check('message pagination is bounded and read-only', len(page['messages']) == 1 and page['has_more'] and not page['receipt_changed'])
                            more = await call(session, 'get_messages', {'after': page['next_cursor'], 'limit': 1, 'task_id': 'mcp-one'})
                            check('cursor advances to next formal message without duplication', more['messages'][0]['kind'] == 'result' and more['next_cursor'] > page['next_cursor'])
                            # Reading over HTTP must not ACK or hide these from the webpage.
                        async with connect(base.replace('http:', 'ws:') + '/ws/main?role=user',
                                           additional_headers={'Authorization': 'Bearer ' + user_token}, proxy=None) as user:
                            await event(user, 'ready')
                            check('MCP reads preserve unacknowledged webpage messages', (await event(user, 'message'))['kind'] == 'progress')
                        await call(session, 'send_message', {'task_id': 'mcp-cancel', 'content': 'cancel this test task'})
                        await task_poll(config, 'mcp-cancel')
                        await asyncio.to_thread(cli, config, 'start', '--msgid', 'mcp-cancel', '--run-id', 'local-cancel-fixture')
                        cancel = await call(session, 'cancel_task', {'task_id': 'mcp-cancel'})
                        check('cancel_task only registers a durable request', cancel['cancel_requested'] and not cancel['stopped'])
                        cancel_wait = await call(session, 'wait_for_task', {'task_id': 'mcp-cancel', 'timeout_seconds': 5.0, 'poll_interval': 0.5})
                        check('wait_for_task returns promptly on cancellation', cancel_wait['cancel_requested'] and not cancel_wait.get('timeout'))
                        for _ in range(60):
                            state = await asyncio.to_thread(cli, config, 'cancelled', '--msgid', 'mcp-cancel')
                            if state['cancel_requested']:
                                break
                            await asyncio.sleep(0.1)
                        check('cancel control reaches the actual Muse adapter', state['cancel_requested'])
                        repeated = await call(session, 'cancel_task', {'task_id': 'mcp-cancel'})
                        check('repeated cancellation does not create a second control', repeated['duplicate'])
                        task = await call(session, 'get_task', {'task_id': 'mcp-cancel'})
                        check('cancellation does not invent execution completion', task['execution_state'] == 'unknown' and not task['stopped'])
            finally:
                stop(adapter)
                stop(worker_process)
        print(f'{len(CHECKS)}/{len(CHECKS)} MCP integration checks passed; real Muse AI not invoked.')


if __name__ == '__main__':
    asyncio.run(main())
