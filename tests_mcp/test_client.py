"""MCP client contract: stable IDs, bounded reads and safe private configuration."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

try:
    import httpx
except ImportError:
    # 纯标准库测试环境兼容性兜底：自建与 httpx 兼容的传输与客户端 mock
    from urllib.parse import parse_qs, urlsplit, urlencode

    class _MockURL:
        def __init__(self, raw_url: str, params: dict | None = None):
            self._raw = raw_url
            split = urlsplit(raw_url)
            self.scheme = split.scheme
            self.netloc = split.netloc
            self.path = split.path
            parsed_params = {}
            if split.query:
                for k, v in parse_qs(split.query).items():
                    parsed_params[k] = v[0]
            if params:
                for k, v in params.items():
                    parsed_params[k] = str(v)
            self.params = parsed_params

        def __str__(self) -> str:
            if self.params and '?' not in self._raw:
                return f"{self._raw}?{urlencode(self.params)}"
            return self._raw

    class _MockRequest:
        def __init__(self, method: str, url: str, headers: dict | None = None, content: bytes = b'', params: dict | None = None):
            self.method = method
            self.url = _MockURL(url, params)
            self.headers = headers or {}
            self.content = content

    class _MockResponse:
        def __init__(self, status_code: int = 200, *, json: dict | list | None = None, text: str = '', content: bytes | str | None = None, headers: dict | None = None):
            self.status_code = status_code
            self.headers = headers or {}
            if json is not None:
                import json as json_mod
                self._content = json_mod.dumps(json).encode('utf-8')
            elif content is not None:
                self._content = content.encode('utf-8') if isinstance(content, str) else content
            else:
                self._content = text.encode('utf-8')

        async def aiter_bytes(self):
            chunk_size = 65536
            for i in range(0, len(self._content), chunk_size):
                yield self._content[i:i + chunk_size]

    class _MockHTTPError(Exception):
        pass

    class _MockInvalidURL(_MockHTTPError):
        pass

    class _MockReadTimeout(_MockHTTPError):
        def __init__(self, message: str = '', request: _MockRequest | None = None):
            super().__init__(message)
            self.request = request

    class _MockTimeout:
        def __init__(self, *args, **kwargs):
            pass

    class _MockTransport:
        def __init__(self, handler):
            self.handler = handler

    class _MockAsyncClient:
        def __init__(self, transport=None, timeout=None, follow_redirects: bool = False, trust_env: bool = True):
            self.transport = transport

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass

        def stream(self, method: str, url: str, json: dict | None = None, params: dict | None = None, headers: dict | None = None):
            import json as json_mod
            content = json_mod.dumps(json).encode('utf-8') if json is not None else b''
            request = _MockRequest(method, url, headers=headers, content=content, params=params)

            class _StreamContext:
                def __init__(self, transport, req):
                    self.transport = transport
                    self.req = req

                async def __aenter__(self):
                    resp = self.transport.handler(self.req)
                    if hasattr(resp, '__await__'):
                        resp = await resp
                    return resp

                async def __aexit__(self, exc_type, exc_val, exc_tb):
                    pass

            return _StreamContext(self.transport, request)

    httpx = types.ModuleType('httpx')
    httpx.HTTPError = _MockHTTPError
    httpx.InvalidURL = _MockInvalidURL
    httpx.ReadTimeout = _MockReadTimeout
    httpx.Timeout = _MockTimeout
    httpx.MockTransport = _MockTransport
    httpx.Response = _MockResponse
    httpx.AsyncClient = _MockAsyncClient
    sys.modules['httpx'] = httpx

from cf_mcp.client import ChannelClient, ChannelError, Settings

try:
    import cf_mcp.__main__ as mcp_main
    from mcp.server.fastmcp.exceptions import ToolError
    MCP_AVAILABLE = True
except (ImportError, Exception):
    MCP_AVAILABLE = False



class ClientTests(unittest.IsolatedAsyncioTestCase):
    """HTTP substitutions verify the actual client, never real cloud credentials."""

    def client(self, handler):
        """Create a role-specific local fixture with an injected network boundary."""
        return ChannelClient(Settings('https://example.com', 'main', 'x' * 43), httpx.MockTransport(handler))

    async def test_send_preserves_id_content_and_authorization(self):
        requests = []
        def handler(request):
            """Capture the exact request without exposing it in test output."""
            requests.append(request)
            return httpx.Response(200, json={'cf_stored': True, 'task_id': 'stable'})
        client = self.client(handler)
        await client.send_message('stable', 'do something')
        await client.send_message('stable', 'do something')
        self.assertEqual(requests[0].content, requests[1].content)
        self.assertEqual(json.loads(requests[0].content), {'task_id': 'stable', 'content': 'do something'})
        self.assertEqual(requests[0].headers['Authorization'], 'Bearer ' + 'x' * 43)
        self.assertNotIn('x' * 43, str(requests[0].url))

    async def test_invalid_inputs_never_reach_network(self):
        def forbidden(request):
            raise AssertionError('invalid input reached transport')
        client = self.client(forbidden)
        for identifier in ('', '.', '..', '../other', 'x' * 97, 'cancel:reserved'):
            with self.subTest(identifier=identifier), self.assertRaises(ChannelError):
                await client.send_message(identifier, 'text')
        with self.assertRaises(ChannelError):
            await client.send_message('one', '汉' * 22000)
        for after, limit in ((True, 10), (-1, 10), (0, 51), (0, False), (2 ** 54, 10)):
            with self.assertRaises(ChannelError):
                await client.get_messages(after, limit)

    async def test_cursor_and_filter_are_sent_without_changing_receipts(self):
        def handler(request):
            self.assertEqual(dict(request.url.params), {'after': '12', 'limit': '5', 'task_id': 'one'})
            return httpx.Response(200, json={'next_cursor': 14, 'receipt_changed': False})
        result = await self.client(handler).get_messages(12, 5, 'one')
        self.assertFalse(result['receipt_changed'])

    async def test_remote_body_and_redirects_cannot_leak_or_forward_credentials(self):
        for status in (301, 401, 403, 409, 500, 507):
            def handler(request):
                return httpx.Response(status, text='PRIVATE_REMOTE_BODY', headers={'Location': 'https://evil.test'})
            with self.subTest(status=status), self.assertRaises(ChannelError) as caught:
                await self.client(handler).get_task('one')
            self.assertNotIn('PRIVATE', str(caught.exception))
            self.assertNotIn('evil', str(caught.exception))

    async def test_timeout_warns_of_uncertain_submission_without_creating_a_new_id(self):
        def handler(request):
            raise httpx.ReadTimeout('PRIVATE token x', request=request)
        with self.assertRaises(ChannelError) as caught:
            await self.client(handler).send_message('stable', 'text')
        self.assertIn('retry_same_task_id_only', str(caught.exception))
        self.assertNotIn('PRIVATE', str(caught.exception))

    async def test_malformed_and_oversized_responses_fail_closed(self):
        for content in ('not JSON PRIVATE', '[]', 'x' * (4 * 1024 * 1024 + 1)):
            with self.subTest(size=len(content)), self.assertRaises(ChannelError):
                await self.client(lambda request: httpx.Response(200, content=content)).get_task('one')

    async def test_cancellation_uses_post_and_never_claims_stopped(self):
        def handler(request):
            self.assertEqual(request.method, 'POST')
            self.assertTrue(request.url.path.endswith('/tasks/one/cancel'))
            return httpx.Response(200, json={'cancel_requested': True, 'stopped': False})
        self.assertFalse((await self.client(handler).cancel_task('one'))['stopped'])

    def test_private_configuration_validation_and_secret_redaction(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'mcp.json'
            valid = {'server_url': 'https://example.com', 'room': 'main', 'user_token': 'x' * 43}
            with patch.dict(os.environ, {'CF_MUSE_MCP_CONFIG': str(path)}):
                path.write_text(json.dumps(valid))
                self.assertEqual(Settings.load().room, 'main')
                for url in ('http://example.com', 'http://127.0.0.1', 'https://u:PRIVATE@example.com', 'https://example.com?token=PRIVATE'):
                    path.write_text(json.dumps(dict(valid, server_url=url)))
                    with self.assertRaises(ChannelError) as caught:
                        Settings.load()
                    self.assertNotIn('PRIVATE', str(caught.exception))

    # --- 任务三：wait_for_task 完整用例验证 ---

    async def test_wait_for_task_ready_immediately(self):
        """用例 1：任务已就绪时立即返回（0 等待，sleep 0 次）。"""
        call_count = 0
        def handler(request):
            nonlocal call_count
            call_count += 1
            return httpx.Response(200, json={
                'task_id': 'ready_task',
                'status': 'completed',
                'result': {'answer': 42}
            })

        client = self.client(handler)
        with patch('asyncio.sleep') as mock_sleep:
            result = await client.wait_for_task('ready_task', timeout_seconds=30.0, poll_interval=1.0)
            mock_sleep.assert_not_called()

        self.assertEqual(call_count, 1)
        self.assertEqual(result['task_id'], 'ready_task')
        self.assertEqual(result['result'], {'answer': 42})
        self.assertNotIn('timeout', result)

    async def test_wait_for_task_returns_on_nth_poll(self):
        """用例 2：第 N 次轮询产生结果时正常返回。"""
        call_count = 0
        responses = [
            {'task_id': 'nth_task', 'status': 'running', 'progress': 20, 'result': None},
            {'task_id': 'nth_task', 'status': 'running', 'progress': 60, 'result': None},
            {'task_id': 'nth_task', 'status': 'completed', 'progress': 100, 'result': 'computation_done'},
        ]
        def handler(request):
            nonlocal call_count
            item = responses[min(call_count, len(responses) - 1)]
            call_count += 1
            return httpx.Response(200, json=item)

        client = self.client(handler)
        with patch('asyncio.sleep', new_callable=AsyncMock) as mock_sleep:
            result = await client.wait_for_task('nth_task', timeout_seconds=10.0, poll_interval=0.5)
            self.assertEqual(mock_sleep.call_count, 2)
            mock_sleep.assert_called_with(0.5)

        self.assertEqual(call_count, 3)
        self.assertEqual(result['task_id'], 'nth_task')
        self.assertEqual(result['result'], 'computation_done')
        self.assertEqual(result['progress'], 100)
        self.assertNotIn('timeout', result)

    async def test_wait_for_task_timeout_graceful_snapshot(self):
        """用例 3：超时未完成时优雅返回最新快照与 timeout: True，不抛异常。"""
        call_count = 0
        def handler(request):
            nonlocal call_count
            call_count += 1
            return httpx.Response(200, json={
                'task_id': 'slow_task',
                'status': 'in_progress',
                'step': call_count,
                'result': None
            })

        client = self.client(handler)
        # 模拟时间流转：开始时 0.0，第 1 轮检查 0.2s，第 2 轮检查 0.7s，第 3 轮检查 1.1s（超时退出）
        time_seq = [0.0, 0.2, 0.7, 1.1]
        with patch('time.monotonic', side_effect=time_seq), patch('asyncio.sleep', new_callable=AsyncMock) as mock_sleep:
            result = await client.wait_for_task('slow_task', timeout_seconds=1.0, poll_interval=0.5)
            self.assertEqual(mock_sleep.call_count, 2)
            self.assertEqual(call_count, 3)

        self.assertTrue(result.get('timeout'))
        self.assertFalse(result.get('completed'))
        self.assertEqual(result.get('waited_seconds'), 1.1)
        self.assertEqual(result.get('step'), 3)
        self.assertEqual(result.get('status'), 'in_progress')


    async def test_wait_for_task_cancel_requested_returns_promptly(self):
        """用例 4：取消请求及各种终态触发时准确判定（cancel_requested / cancel_received_by_muse / stopped / cancelled）。"""
        # 仅请求取消时继续等待，直到超时
        def handler_cancel_requested(request):
            return httpx.Response(200, json={
                'task_id': 'cancelling_task',
                'cancel_requested': True,
                'cancel_received_by_muse': False,
                'status': 'running',
                'result': None
            })

        client = self.client(handler_cancel_requested)
        res1 = await client.wait_for_task('cancelling_task', timeout_seconds=1.0, poll_interval=0.5)
        self.assertTrue(res1['cancel_requested'])
        self.assertTrue(res1['timeout'])

        # 测试 stopped: True 终态触发
        def handler_stopped(request):
            return httpx.Response(200, json={
                'task_id': 'stopped_task',
                'stopped': True,
                'status': 'cancelled',
                'result': None
            })

        client_stopped = self.client(handler_stopped)
        with patch('asyncio.sleep') as mock_sleep:
            res_stopped = await client_stopped.wait_for_task('stopped_task', timeout_seconds=60.0, poll_interval=1.0)
            mock_sleep.assert_not_called()
        self.assertTrue(res_stopped['stopped'])

        # 测试 status == 'cancelled'
        def handler_status(request):
            return httpx.Response(200, json={
                'task_id': 'cancelled_task2',
                'status': 'cancelled',
                'result': None
            })

        client2 = self.client(handler_status)
        with patch('asyncio.sleep') as mock_sleep:
            res2 = await client2.wait_for_task('cancelled_task2', timeout_seconds=60.0, poll_interval=1.0)
            mock_sleep.assert_not_called()
        self.assertEqual(res2['status'], 'cancelled')

        # 测试 cancel_received_by_muse: True
        def handler_muse_cancel(request):
            return httpx.Response(200, json={
                'task_id': 'cancelled_task3',
                'cancel_received_by_muse': True,
                'result': None
            })

        client3 = self.client(handler_muse_cancel)
        with patch('asyncio.sleep') as mock_sleep:
            res3 = await client3.wait_for_task('cancelled_task3', timeout_seconds=60.0, poll_interval=1.0)
            mock_sleep.assert_not_called()
        self.assertTrue(res3['cancel_received_by_muse'])

        # 测试 status in ('completed', 'failed', 'error') 终态返回
        for final_status in ('completed', 'failed', 'error'):
            client_status = self.client(lambda req, s=final_status: httpx.Response(200, json={'task_id': 'stat_task', 'status': s, 'result': None}))
            with patch('asyncio.sleep') as mock_sleep:
                res_status = await client_status.wait_for_task('stat_task', timeout_seconds=60.0, poll_interval=1.0)
                mock_sleep.assert_not_called()
            self.assertEqual(res_status['status'], final_status)

        # 测试 execution_state in ('result_available', 'cancelled') 终态返回
        for ex_state in ('result_available', 'cancelled'):
            client_ex = self.client(lambda req, s=ex_state: httpx.Response(200, json={'task_id': 'ex_task', 'execution_state': s, 'result': None}))
            with patch('asyncio.sleep') as mock_sleep:
                res_ex = await client_ex.wait_for_task('ex_task', timeout_seconds=60.0, poll_interval=1.0)
                mock_sleep.assert_not_called()
            self.assertEqual(res_ex['execution_state'], ex_state)

    async def test_wait_for_task_invalid_parameters_rejected(self):
        """用例 5：非法参数（负数超时、超长超时、非数字参数、布尔值、NaN、Inf 等）被严格拦截抛出 ChannelError。"""
        def forbidden(request):
            raise AssertionError('invalid input reached transport')
        client = self.client(forbidden)

        # 非法 task_id
        for bad_id in ('', '.', '..', '../bad', 'cancel:test', 'x' * 97, None):
            with self.subTest(bad_id=bad_id), self.assertRaises(ChannelError):
                await client.wait_for_task(bad_id, 60.0, 2.0)

        # 非法 timeout_seconds (必须 1.0 <= timeout <= 300.0, 拒绝布尔型与非法值)
        for bad_timeout in (-1.0, 0, 0.5, 0.999, 300.1, 500, True, False, '60', None, [], float('nan'), float('inf'), -float('inf')):
            with self.subTest(bad_timeout=bad_timeout), self.assertRaises(ChannelError):
                await client.wait_for_task('valid_id', timeout_seconds=bad_timeout, poll_interval=2.0)

        # 非法 poll_interval (必须 0.5 <= poll_interval <= 10.0, 拒绝布尔型与非法值)
        for bad_interval in (-1.0, 0, 0.499, 10.1, 15, True, False, '2.0', None, {}, float('nan'), float('inf'), -float('inf')):
            with self.subTest(bad_interval=bad_interval), self.assertRaises(ChannelError):
                await client.wait_for_task('valid_id', timeout_seconds=60.0, poll_interval=bad_interval)

    async def test_wait_for_task_transient_network_error_recovers(self):
        """用例 6：轮询期间偶发网络异常重试恢复。"""
        call_count = 0
        def handler(request):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return httpx.Response(200, json={'task_id': 'net_task', 'progress': 'reading'})
            elif call_count == 2:
                # 模拟偶发网络闪断
                raise httpx.ReadTimeout('network glitch', request=request)
            else:
                return httpx.Response(200, json={'task_id': 'net_task', 'result': {'final': 'success'}})

        client = self.client(handler)
        with patch('asyncio.sleep', new_callable=AsyncMock) as mock_sleep:
            result = await client.wait_for_task('net_task', timeout_seconds=10.0, poll_interval=0.5)
            self.assertEqual(mock_sleep.call_count, 2)

        self.assertEqual(call_count, 3)
        self.assertEqual(result['task_id'], 'net_task')
        self.assertEqual(result['result'], {'final': 'success'})
        self.assertNotIn('timeout', result)

    async def test_wait_for_task_persistent_network_error_times_out_gracefully(self):
        """测试全周期网络异常时优雅返回初始快照与 timeout: True，不破坏调用方流程。"""
        def broken_handler(request):
            raise httpx.ReadTimeout('persistent connection down', request=request)

        client = self.client(broken_handler)
        time_seq = [0.0, 0.3, 0.7, 1.2]
        with patch('time.monotonic', side_effect=time_seq), patch('asyncio.sleep', new_callable=AsyncMock) as mock_sleep:
            result = await client.wait_for_task('offline_task', timeout_seconds=1.0, poll_interval=0.5)
            self.assertEqual(mock_sleep.call_count, 2)

        self.assertTrue(result.get('timeout'))
        self.assertFalse(result.get('completed'))
        self.assertEqual(result.get('task_id'), 'offline_task')
        self.assertEqual(result.get('status'), 'unknown')
        self.assertEqual(result.get('execution_state'), 'unknown')

    async def test_wait_for_task_real_clock_short_wait(self):
        """使用真实时钟（非 mock）验证短周期超时控制及优雅快照。"""
        def handler(request):
            return httpx.Response(200, json={'task_id': 'real_clock_task', 'status': 'busy'})

        client = self.client(handler)
        result = await client.wait_for_task('real_clock_task', timeout_seconds=1.0, poll_interval=0.5)
        self.assertTrue(result.get('timeout'))
        self.assertFalse(result.get('completed'))
        self.assertGreaterEqual(result.get('waited_seconds', 0), 0.99)
        self.assertEqual(result.get('status'), 'busy')

    async def test_mcp_wait_for_task_tool_integration(self):
        """验证 FastMCP 中 wait_for_task 的注册及 ToolError 转换。"""
        if not MCP_AVAILABLE:
            self.skipTest("当前环境未安装 mcp 官方包，跳过 FastMCP 工具层测试")

        tools = await mcp_main.server.list_tools()
        wait_tool = next((t for t in tools if t.name == 'wait_for_task'), None)
        self.assertIsNotNone(wait_tool, "wait_for_task 应注册在 server.list_tools 中")
        self.assertTrue(wait_tool.annotations.readOnlyHint)
        self.assertFalse(wait_tool.annotations.destructiveHint)
        self.assertTrue(wait_tool.annotations.idempotentHint)
        self.assertTrue(wait_tool.annotations.openWorldHint)

        # 正常转发调用验证
        with patch.object(mcp_main.ChannelClient, 'wait_for_task', new_callable=AsyncMock) as mock_wait:
            mock_wait.return_value = {'task_id': 'mcp_test', 'result': 'tool_success'}
            res = await mcp_main.wait_for_task('mcp_test', timeout_seconds=45.0, poll_interval=1.5)
            self.assertEqual(res, {'task_id': 'mcp_test', 'result': 'tool_success'})
            mock_wait.assert_called_once_with('mcp_test', 45.0, 1.5)

        # 异常转换验证
        with patch.object(mcp_main.ChannelClient, 'wait_for_task', new_callable=AsyncMock) as mock_wait:
            mock_wait.side_effect = ChannelError('invalid_timeout')
            with self.assertRaises(ToolError) as caught:
                await mcp_main.wait_for_task('mcp_test', timeout_seconds=-5.0)
            self.assertIn('invalid_timeout', str(caught.exception))

    async def test_wait_for_task_initial_404_replication_delay_tolerated(self):
        """用例 7：任务新建前 3 秒内对 404 unknown_task_or_endpoint 进行平滑重试容错。"""
        poll_count = 0

        def handler_404_then_ok(request):
            nonlocal poll_count
            poll_count += 1
            if poll_count <= 2:
                # 前两次返回 404 (复制尚未生效)
                return httpx.Response(404, json={'error': 'unknown_task_or_endpoint'})
            # 第三次返回正常任务信息
            return httpx.Response(200, json={
                'task_id': 'replica_task',
                'status': 'completed',
                'result': 'success_after_replication'
            })

        client = self.client(handler_404_then_ok)
        time_seq = [0.0, 1.0, 2.0, 3.0]
        with patch('time.monotonic', side_effect=time_seq), patch('asyncio.sleep', new_callable=AsyncMock) as mock_sleep:
            result = await client.wait_for_task('replica_task', timeout_seconds=10.0, poll_interval=1.0)
            self.assertEqual(mock_sleep.call_count, 2)
        self.assertEqual(result.get('status'), 'completed')
        self.assertEqual(result.get('result'), 'success_after_replication')

    async def test_wait_for_task_persistent_404_raises_after_threshold(self):
        """用例 8：超过 3 秒阈值的持续 404 严格抛出 ChannelError(unknown_task_or_endpoint)。"""
        def handler_always_404(request):
            return httpx.Response(404, json={'error': 'unknown_task_or_endpoint'})

        client = self.client(handler_always_404)
        time_seq = [0.0, 1.0, 4.0]
        with patch('time.monotonic', side_effect=time_seq), patch('asyncio.sleep', new_callable=AsyncMock):
            with self.assertRaises(ChannelError) as cm:
                await client.wait_for_task('missing_task', timeout_seconds=10.0, poll_interval=1.0)
            self.assertIn('unknown_task_or_endpoint', str(cm.exception))

    async def test_wait_for_task_client_session_reuse(self):
        """用例 9：wait_for_task 在整个轮询生命周期内复用同一 AsyncClient 会话，消除连接风暴。"""
        created_clients = []

        orig_create_client = ChannelClient._create_client

        def tracked_create_client(self_client):
            c = orig_create_client(self_client)
            created_clients.append(c)
            return c

        poll_count = 0

        def handler_multi_poll(request):
            nonlocal poll_count
            poll_count += 1
            if poll_count < 3:
                return httpx.Response(200, json={'task_id': 'reuse_task', 'status': 'running'})
            return httpx.Response(200, json={'task_id': 'reuse_task', 'status': 'completed', 'result': 'done'})

        client = self.client(handler_multi_poll)
        with patch.object(ChannelClient, '_create_client', tracked_create_client), \
             patch('asyncio.sleep', new_callable=AsyncMock):
            result = await client.wait_for_task('reuse_task', timeout_seconds=10.0, poll_interval=1.0)

        self.assertEqual(result.get('status'), 'completed')
        # 轮询了 3 次，但只创建过 1 个 AsyncClient 会话
        self.assertEqual(len(created_clients), 1)


if __name__ == '__main__':
    unittest.main()
