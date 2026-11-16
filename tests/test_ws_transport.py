import importlib.util
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("cf_ws_transport", ROOT / "client/ws_transport.py")
ws_transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ws_transport)

pspec = importlib.util.spec_from_file_location("_cf_ws_probe", ROOT / "client/probe.py")
probe = importlib.util.module_from_spec(pspec)
pspec.loader.exec_module(probe)


class SyncWebSocketTests(unittest.TestCase):
    def setUp(self):
        self.conn = Mock()
        self.patcher = patch.object(ws_transport, "_ws_connect", return_value=self.conn)
        self.mock_connect = self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.ws = ws_transport.SyncWebSocket()

    def test_connect_passes_url_auth_and_keeps_proxy_and_tls_defaults(self):
        self.ws.connect("wss://example.invalid/ws",
                        headers={"Authorization": "Bearer k"}, timeout=75,
                        impersonate="chrome", http_version="ignored", verify=True)
        kwargs = self.mock_connect.call_args
        self.assertEqual(kwargs.args[0], "wss://example.invalid/ws")
        self.assertEqual(kwargs.kwargs["additional_headers"], {"Authorization": "Bearer k"})
        self.assertEqual(kwargs.kwargs["open_timeout"], 75)
        # proxy must stay at its default (env proxy) and TLS verification on:
        # neither may be disabled by this wrapper.
        self.assertNotIn("proxy", kwargs.kwargs)
        self.assertNotIn("ssl", kwargs.kwargs)
        self.assertNotIn("impersonate", kwargs.kwargs)
        self.assertNotIn("http_version", kwargs.kwargs)

    def test_send_bytes_forwards_bytes(self):
        self.ws.connect("wss://example.invalid/ws")
        self.ws.send_bytes(b"\x01\x02")
        self.conn.send.assert_called_once_with(b"\x01\x02")

    def test_recv_returns_bytes_and_binary_flag(self):
        self.ws.connect("wss://example.invalid/ws")
        self.conn.recv.return_value = b"\x03\x04"
        self.assertEqual(self.ws.recv(), (b"\x03\x04", 2))

    def test_recv_converts_text_to_bytes(self):
        self.ws.connect("wss://example.invalid/ws")
        self.conn.recv.return_value = "text"
        self.assertEqual(self.ws.recv(), (b"text", 2))

    def test_close_is_idempotent(self):
        self.ws.connect("wss://example.invalid/ws")
        self.ws.close()
        self.ws.close()
        self.conn.close.assert_called_once()


class RelayGatewayFactoryTests(unittest.TestCase):
    def _fake_noise(self):
        noise = Mock()
        noise.write_message.return_value = b"\x01\x02"
        noise.read_message.return_value = None
        noise.handshake_finished = True
        return noise

    def test_injected_factory_is_used_for_the_handshake(self):
        fake_ws = Mock()
        fake_ws.recv.return_value = (b"\x03\x04", 2)
        factory = Mock(return_value=fake_ws)
        with patch.object(probe, "NoiseConnection", return_value=self._fake_noise()):
            gw = probe.RelayGateway("https://example.invalid", "k" * 32, ws_factory=factory)
        factory.assert_called_once_with()
        self.assertIs(gw.ws, fake_ws)
        connect_kwargs = fake_ws.connect.call_args.kwargs
        self.assertIn("example.invalid", fake_ws.connect.call_args.args[0])
        self.assertEqual(connect_kwargs["headers"], {"Authorization": "Bearer " + "k" * 32})
        self.assertEqual(fake_ws.send_bytes.call_count, 2)
        self.assertEqual(fake_ws.recv.call_count, 1)

    def test_default_path_still_uses_curl_cffi_websocket(self):
        curl_ws = Mock()
        curl_ws.recv.return_value = (b"\x03\x04", 2)
        with patch.object(probe, "NoiseConnection", return_value=self._fake_noise()), \
             patch.object(probe, "WebSocket", return_value=curl_ws) as mock_ws_class:
            gw = probe.RelayGateway("https://example.invalid", "k" * 32)
        mock_ws_class.assert_called_once_with()
        self.assertIs(gw.ws, curl_ws)
        connect_kwargs = curl_ws.connect.call_args.kwargs
        self.assertEqual(connect_kwargs["impersonate"], "chrome")
        self.assertTrue(connect_kwargs["verify"])
        self.assertIsNotNone(connect_kwargs.get("http_version"))


if __name__ == "__main__":
    unittest.main()
