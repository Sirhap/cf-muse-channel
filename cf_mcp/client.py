"""Bounded authenticated HTTP calls that never take over the browser's socket."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import time
from urllib.parse import urlsplit

try:
    import httpx
except ImportError:  # pragma: no cover
    class _HttpxStub:
        class HTTPError(Exception): pass
        class InvalidURL(Exception): pass
        class ReadTimeout(HTTPError): pass
        class Timeout:
            def __init__(self, *args, **kwargs): pass
        class AsyncClient:
            def __init__(self, *args, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
    httpx = _HttpxStub()

ID = re.compile(r'[A-Za-z0-9_.:-]{1,96}')


class ChannelError(RuntimeError):
    """An allowlisted failure safe for MCP tool output and SDK logs."""


def task_id(value: str) -> str:
    """Require a stable caller-chosen ID so retries cannot create new tasks."""
    if not isinstance(value, str) or not ID.fullmatch(value) or value.startswith('cancel:') or value in ('.', '..'):
        raise ChannelError('invalid_task_id')
    return value


@dataclass(frozen=True)
class Settings:
    """Private user-side credentials, separate from Muse and Cloudflare account keys."""
    server_url: str
    room: str
    user_token: str

    @classmethod
    def load(cls):
        """Read explicit setup on tool invocation, never on module import."""
        try:
            path = Path(os.environ.get('CF_MUSE_MCP_CONFIG', '~/.config/cf-muse-channel/mcp.json')).expanduser()
            data = json.loads(path.read_text(encoding='utf-8'))
            url = urlsplit(data['server_url'])
            _ = url.port  # Validate malformed ports before passing the URL to the transport.
            local = url.hostname in ('127.0.0.1', 'localhost', '::1')
            if (not url.hostname or url.username or url.password or url.query or url.fragment
                    or url.path not in ('', '/') or url.scheme not in ('http', 'https')
                    or (url.scheme == 'http' and not (local and data.get('allow_insecure_localhost') is True))):
                raise ValueError('endpoint')
            room, token = data.get('room', 'main'), data['user_token']
            if not isinstance(room, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', room):
                raise ValueError('room')
            if not isinstance(token, str) or not 32 <= len(token) <= 512 or any(char.isspace() for char in token) or token.startswith('REPLACE_'):
                raise ValueError('credential')
            return cls(data['server_url'].rstrip('/'), room, token)
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            raise ChannelError('private_mcp_configuration_invalid') from None


class ChannelClient:
    """No secret is accepted through tool arguments or returned in tool results."""

    def __init__(self, settings=None, transport=None):
        """Allow HTTP transport injection for deterministic protocol tests."""
        self.settings = settings or Settings.load()
        self.transport = transport

    def _create_client(self):
        """创建复用连接池的 AsyncClient。"""
        return httpx.AsyncClient(
            transport=self.transport,
            timeout=httpx.Timeout(15, connect=8),
            follow_redirects=False,
            trust_env=not self.settings.server_url.startswith('http:'),
        )

    async def _parse_response(self, response):
        """校验并解析响应体，限制大小与状态码转换。"""
        if response.status_code >= 300:
            codes = {401: 'authentication_failed', 403: 'authentication_failed', 404: 'unknown_task_or_endpoint',
                     409: 'id_conflict_or_task_completed', 507: 'capacity_reached'}
            raise ChannelError(codes.get(response.status_code, 'channel_request_rejected'))
        content = bytearray()
        async for block in response.aiter_bytes():
            content.extend(block)
            if len(content) > 4 * 1024 * 1024:
                raise ChannelError('channel_response_too_large')
        result = json.loads(content)
        if not isinstance(result, dict):
            raise ChannelError('channel_response_invalid')
        return result

    async def request(self, method, path, *, payload=None, params=None, client=None):
        """Bound duration and response size, reject redirects and sanitize failures."""
        endpoint = self.settings.server_url + '/api/rooms/' + self.settings.room + path
        try:
            if client is not None:
                async with client.stream(method, endpoint, json=payload, params=params,
                                         headers={'Authorization': 'Bearer ' + self.settings.user_token}) as response:
                    return await self._parse_response(response)
            else:
                async with self._create_client() as new_client:
                    async with new_client.stream(method, endpoint, json=payload, params=params,
                                                 headers={'Authorization': 'Bearer ' + self.settings.user_token}) as response:
                        return await self._parse_response(response)
        except ChannelError:
            raise
        except (httpx.HTTPError, httpx.InvalidURL, ValueError, TypeError):
            raise ChannelError('connection_or_response_failed; submission_may_have_succeeded; retry_same_task_id_only') from None

    async def send_message(self, identifier: str, content: str):
        """Store one task, preserving the same ID and exact text across retries."""
        identifier = task_id(identifier)
        if not isinstance(content, str) or not content.strip():
            raise ChannelError('content_required')
        message = {'type': 'message', 'id': identifier, 'source': 'user', 'kind': 'task', 'content': content}
        if len(json.dumps(message, ensure_ascii=False).encode()) > 65536:
            raise ChannelError('message_too_large')
        return await self.request('POST', '/tasks', payload={'task_id': identifier, 'content': content})

    async def get_task(self, identifier: str, *, client=None):
        """Return CF evidence; no result or progress alone proves a worker is alive."""
        return await self.request('GET', '/tasks/' + task_id(identifier), client=client)

    async def get_messages(self, after: int = 0, limit: int = 20, identifier: str | None = None):
        """Read a bounded page without ACKing or hiding messages from the webpage."""
        if isinstance(after, bool) or not isinstance(after, int) or not 0 <= after <= 9007199254740991:
            raise ChannelError('invalid_cursor')
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50:
            raise ChannelError('invalid_limit')
        params = {'after': after, 'limit': limit}
        if identifier is not None:
            params['task_id'] = task_id(identifier)
        return await self.request('GET', '/messages', params=params)

    async def cancel_task(self, identifier: str):
        """Request cooperative cancellation; never claim execution has already stopped."""
        return await self.request('POST', '/tasks/' + task_id(identifier) + '/cancel')

    async def wait_for_task(self, identifier: str, timeout_seconds: float = 60.0, poll_interval: float = 2.0) -> dict:
        """非阻塞轮询等待指定任务完成或取消。

        - 终态即时返回：检测到正式结果或已确认取消状态时立即返回；
        - 取消终态严审：移除仅凭 cancel_requested 的早退，必须等待 cancel_received_by_muse、stopped 或 cancelled；
        - 复制延迟容错：任务新建前 3 秒内对 unknown_task_or_endpoint (404) 平滑重试；
        - 连接会话复用：复用 AsyncClient 客户端连接池，消除短连接风暴；
        - 可控优雅超时：超过 timeout_seconds 时返回最新快照及 timeout/completed 标记。
        """
        identifier = task_id(identifier)
        if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)) or not (1.0 <= timeout_seconds <= 300.0):
            raise ChannelError('invalid_timeout')
        if isinstance(poll_interval, bool) or not isinstance(poll_interval, (int, float)) or not (0.5 <= poll_interval <= 10.0):
            raise ChannelError('invalid_poll_interval')

        start_time = time.monotonic()
        latest_snapshot: dict = {'task_id': identifier, 'status': 'unknown', 'execution_state': 'unknown'}

        async with self._create_client() as client:
            while True:
                try:
                    task = await self.get_task(identifier, client=client)
                    if isinstance(task, dict):
                        latest_snapshot = task
                        is_terminal = (
                            task.get('result') is not None
                            or bool(task.get('cancel_received_by_muse'))
                            or bool(task.get('stopped'))
                            or task.get('status') in ('cancelled', 'completed', 'failed', 'error')
                            or task.get('execution_state') in ('result_available', 'cancelled', 'completed', 'failed')
                        )
                        if is_terminal:
                            return task
                except ChannelError as error:
                    elapsed = time.monotonic() - start_time
                    if 'connection_or_response_failed' in str(error):
                        pass
                    elif 'unknown_task_or_endpoint' in str(error) and elapsed <= 3.0:
                        pass
                    else:
                        raise
                else:
                    elapsed = time.monotonic() - start_time

                remaining = timeout_seconds - elapsed
                if remaining <= 0:
                    result = dict(latest_snapshot)
                    result['timeout'] = True
                    result['waited_seconds'] = elapsed
                    result['completed'] = False
                    return result

                sleep_duration = min(poll_interval, remaining)
                await asyncio.sleep(sleep_duration)
