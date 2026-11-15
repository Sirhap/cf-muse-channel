"""Actual Noise XX + protobuf RPC, backed by an in-memory peer, without network access."""
from collections import deque
import json
import os
import unittest
from unittest.mock import patch

from muse_cli.gateway import GatewayError, NoiseTransportFrame, ServiceFrame, ServiceRequest, ServiceResponse
from noise.connection import Keypair, NoiseConnection

from test_client import probe


class NoisePeer:
    def __init__(self, chunked=False, corrupt=False, status=200, body=None):
        self.peer = NoiseConnection.from_name(b"Noise_XX_25519_AESGCM_SHA256")
        self.peer.set_as_responder()
        self.peer.set_keypair_from_private_bytes(Keypair.STATIC, os.urandom(32))
        self.peer.start_handshake()
        self.queue = deque()
        self.handshake_messages = 0
        self.connected = None
        self.closed = False
        self.chunked, self.corrupt, self.status = chunked, corrupt, status
        self.body = body
        self.requests = []

    def connect(self, url, **kwargs):
        self.connected = (url, kwargs)

    def close(self):
        self.closed = True

    def recv(self):
        if not self.queue:
            raise ConnectionError("No queued peer frame")
        return self.queue.popleft(), 0

    def send_bytes(self, packet):
        if not self.peer.handshake_finished:
            self.peer.read_message(packet)
            self.handshake_messages += 1
            if self.handshake_messages == 1:
                reply = bytes(self.peer.write_message(b""))
                self.queue.append(b"corrupt" if self.corrupt else reply)
            return
        frame = NoiseTransportFrame()
        frame.ParseFromString(self.peer.decrypt(packet))
        request = ServiceRequest()
        request.ParseFromString(frame.payload)
        service = ServiceFrame()
        service.ParseFromString(request.payload)
        self.requests.append(service.request.path)
        response = ServiceFrame(stream_id=service.stream_id)
        response.response.status = self.status
        response.response.body = (json.dumps(self.body, ensure_ascii=False).encode() if self.body is not None
                                  else b'{"result":{"sessions":[],"marker":"encrypted-rpc"}}')
        response.response.end_body = True
        envelope = ServiceResponse(payload=response.SerializeToString()).SerializeToString()
        width = min(60_000, max(1, len(envelope) // 2))
        parts = [envelope[offset:offset + width] for offset in range(0, len(envelope), width)] if self.chunked else [envelope]
        # Deliberately deliver the second chunk first to exercise pinned SDK reassembly.
        indexes = list(reversed(range(len(parts))))
        for index in indexes:
            transport = NoiseTransportFrame(chunk_id=42, chunk_index=index, total_chunks=len(parts), payload=parts[index])
            self.queue.append(bytes(self.peer.encrypt(transport.SerializeToString())))


class NoiseTests(unittest.TestCase):
    def gateway(self, peer, origin="https://relay.test"):
        with patch.object(probe, "WebSocket", return_value=peer):
            return probe.RelayGateway(origin, "test-demo-key-that-is-at-least-thirty-two-characters")

    def test_real_handshake_and_encrypted_rpc_roundtrip(self):
        peer = NoisePeer()
        client = self.gateway(peer)
        try:
            self.assertTrue(client.noise.handshake_finished)
            self.assertTrue(peer.peer.handshake_finished)
            self.assertEqual(client.call_json("sessions.list")["marker"], "encrypted-rpc")
            self.assertEqual(peer.requests, ["/api/session/list"])
        finally:
            client.close()
        self.assertTrue(peer.closed)

    def test_out_of_order_protobuf_chunks_are_reassembled(self):
        peer = NoisePeer(chunked=True)
        client = self.gateway(peer)
        try:
            self.assertEqual(client.call_json("sessions.list")["sessions"], [])
        finally:
            client.close()

    def test_large_utf8_rpc_reassembles_across_multiple_encrypted_frames(self):
        title = "界" * 40_000
        peer = NoisePeer(chunked=True, body={"result": {"sessions": [{"title": title}]}})
        client = self.gateway(peer)
        try:
            self.assertEqual(client.call_json("sessions.list")["sessions"][0]["title"], title)
        finally:
            client.close()

    def test_repeated_rpc_uses_distinct_streams_without_stale_chunk_reuse(self):
        peer = NoisePeer(chunked=True)
        client = self.gateway(peer)
        try:
            self.assertEqual(client.call_json("sessions.list")["marker"], "encrypted-rpc")
            self.assertEqual(client.call_json("sessions.list")["marker"], "encrypted-rpc")
            self.assertEqual(client.stream, 3)
            self.assertEqual(client._chunks, {})
        finally:
            client.close()

    def test_auth_header_is_not_in_the_websocket_url_and_tls_is_verified(self):
        peer = NoisePeer()
        client = self.gateway(peer)
        url, kwargs = peer.connected
        self.assertEqual(url, "wss://relay.test/ws")
        self.assertTrue(kwargs["verify"])
        self.assertIn("Authorization", kwargs["headers"])
        self.assertNotIn("test-demo-key", url)
        client.close()

    def test_failed_handshake_closes_the_socket(self):
        peer = NoisePeer(corrupt=True)
        with self.assertRaises(Exception):
            self.gateway(peer)
        self.assertTrue(peer.closed)

    def test_non_success_rpc_produces_a_gateway_error(self):
        peer = NoisePeer(status=503)
        client = self.gateway(peer)
        try:
            with self.assertRaises(GatewayError): client.call_json("sessions.list")
        finally:
            client.close()

    def test_invalid_direct_gateway_origins_never_open_a_socket(self):
        for origin in ("https://:secret@relay.test", "https://relay.test/private", "https://relay.test:bad", "http://public.test"):
            with self.subTest(origin=origin), patch.object(probe, "WebSocket") as socket:
                with self.assertRaises(ValueError): probe.RelayGateway(origin, "key")
                socket.assert_not_called()

    def test_explicit_loopback_http_uses_ws(self):
        peer = NoisePeer()
        client = self.gateway(peer, "http://127.0.0.1:8787")
        self.assertEqual(peer.connected[0], "ws://127.0.0.1:8787/ws")
        client.close()
