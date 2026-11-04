"""MCP client contract: stable IDs, bounded reads and safe private configuration."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import httpx
from cf_mcp.client import ChannelClient, ChannelError, Settings


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


if __name__ == '__main__':
    unittest.main()
