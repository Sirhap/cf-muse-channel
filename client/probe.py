#!/usr/bin/env python3
"""Verify CF -> Muse Cookie/Noise transport, optionally sending ONE new chat.

The handshake is adapted from nikships/muse-cli (MIT), pinned in requirements.txt.
Cookie authentication is performed by the Worker; the local client sees no Cookie.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit, urlunsplit
import uuid

from curl_cffi import requests
from curl_cffi.requests import WebSocket
from muse_cli.gateway import Gateway, GatewayError, ROUTES
from noise.connection import Keypair, NoiseConnection


def worker_origin(base_url: str):
    """Reject credentials, paths and malformed ports before any network activity."""
    if not isinstance(base_url, str) or any(ord(char) <= 32 or ord(char) == 127 for char in base_url):
        raise ValueError("Expected a plain Worker HTTP(S) origin")
    target = urlsplit(base_url)
    port = target.port  # Force validation: urlsplit itself accepts malformed/out-of-range ports.
    if (target.scheme not in ("http", "https") or not target.hostname or target.query or target.fragment
            or target.username is not None or target.password is not None or target.path not in ("", "/")
            or (port is not None and port < 1)):
        raise ValueError("Expected a plain Worker HTTP(S) origin")
    if target.scheme == "http" and target.hostname not in ("localhost", "127.0.0.1"):
        raise ValueError("Remote connections require HTTPS")
    return target


def history_events(history: object) -> list[dict]:
    """Validate the correlation baseline before sending or trusting a result."""
    if not isinstance(history, dict) or not isinstance(history.get("chat_events", []), list):
        raise ValueError("Invalid history response")
    events = history.get("chat_events", [])
    for event in events:
        if (not isinstance(event, dict) or type(event.get("seq")) is not int or event["seq"] < 0
                or (event.get("payload") is not None and not isinstance(event["payload"], dict))):
            raise ValueError("Invalid history event")
    return sorted(events, key=lambda event: event["seq"])


class RelayGateway(Gateway):
    """Use the pinned SDK's framing/RPC over a Worker-authenticated WebSocket."""

    def __init__(self, base_url: str, demo_key: str):
        target = worker_origin(base_url)
        url = urlunsplit(("wss" if target.scheme == "https" else "ws", target.netloc, "/ws", "", ""))
        self.ws = WebSocket()
        try:
            self.ws.connect(url, headers={"Authorization": f"Bearer {demo_key}"},
                            impersonate="chrome", timeout=75, verify=True)
            self.noise = NoiseConnection.from_name(b"Noise_XX_25519_AESGCM_SHA256")
            self.noise.set_as_initiator()
            self.noise.set_keypair_from_private_bytes(Keypair.STATIC, os.urandom(32))
            self.noise.start_handshake()
            self.ws.send_bytes(bytes(self.noise.write_message(b"")))
            message, _ = self.ws.recv()
            self.noise.read_message(bytes(message))
            self.ws.send_bytes(bytes(self.noise.write_message(b"")))
            if not self.noise.handshake_finished:
                raise ConnectionError("Noise handshake incomplete")
        except Exception:
            self.close()
            raise
        self.stream = 1
        self._send_lock = threading.Lock()
        self._recv_lock = threading.Lock()
        self._chunks = {}

    def request(self, method, path_params=None, body=None, query=None, timeout=30, route=None):
        """Require an explicit end-of-body; a timed-out HTTP 200 is not a complete artifact."""
        route = route or ROUTES[method]
        if route["http"] == "GET" and body is not None and query is None:
            query, body = body, None
        stream = self._open(method, path_params, body, query, route=route)
        status, chunks, complete = None, [], False
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            frame = self._read_frame()
            if frame.stream_id != stream:
                continue
            kind = frame.WhichOneof("kind")
            if kind == "response":
                status = frame.response.status
                if frame.response.body:
                    chunks.append(bytes(frame.response.body))
                complete = frame.response.end_body
            elif kind == "body_chunk":
                chunks.append(bytes(frame.body_chunk.data))
                complete = frame.body_chunk.end_body
            elif kind == "reset":
                raise GatewayError(-1, "stream reset before complete response")
            if complete:
                break
        if status is None or not complete:
            raise TimeoutError("response body incomplete; no automatic retry")
        payload = b"".join(chunks)
        if not 200 <= status < 300:
            raise GatewayError(status, payload[:500].decode("utf-8", "replace"))
        return payload


def write_receipt(path: Path, receipt: dict) -> None:
    """Keep a private local submission record so an uncertain send is not replayed."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump(receipt, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def wait_result(client: RelayGateway, timeout: int, receipt_path: Path) -> dict:
    """Read the bound session after a disconnect; this path never submits a task."""
    receipt = json.loads(receipt_path.read_text())
    if not isinstance(receipt, dict):
        raise ValueError("Invalid receipt")
    if receipt.get("state") in ("succeeded", "failed", "cancelled"):
        return receipt
    session_id = receipt.get("session_id")
    baseline = receipt.get("baseline_seq")
    if (receipt.get("state") not in ("submission_unknown", "awaiting_result", "result_unknown")
            or not isinstance(session_id, str) or not session_id
            or type(baseline) is not int or baseline < 0):
        raise ValueError("Receipt has no submitted session to inspect")
    deadline = time.monotonic() + timeout
    anchor_seq = receipt.get("anchor_seq")
    if anchor_seq is not None and (type(anchor_seq) is not int or anchor_seq <= baseline):
        raise ValueError("Invalid receipt anchor")
    marker = receipt.get("completion_marker")
    if marker is not None and (not isinstance(marker, str) or not marker or len(marker) > 128
                               or any(char.isspace() for char in marker)):
        raise ValueError("Invalid completion marker")
    while time.monotonic() < deadline:
        history = client.call_json("chat.history", body={"session_id": session_id, "limit": 100}, timeout=15)
        events = history_events(history)
        if anchor_seq is None:
            anchor_seq = next((event.get("seq") for event in events
                               if event.get("event_name") == "message.user" and event.get("seq", 0) > baseline), None)
            if anchor_seq is not None:
                receipt.update(submission_confirmed=True, anchor_seq=anchor_seq)
                write_receipt(receipt_path, receipt)
        latest = {}
        for event in events:
            if anchor_seq is None or event.get("seq", 0) <= anchor_seq:
                continue
            if event.get("event_name") != "message.assistant":
                continue
            payload = event.get("payload") or {}
            identity = event.get("message_id") or payload.get("message_id") or event["seq"]
            if not isinstance(identity, (str, int)):
                raise ValueError("Invalid assistant message identity")
            latest[identity] = event
        replies = sorted(latest.values(), key=lambda event: event["seq"])
        active = any((event.get("payload") or {}).get("status") in (
            "running", "pending", "in_progress", "streaming", "generating")
            or (event.get("payload") or {}).get("display_text_ready") is False for event in replies)
        if replies and not active:
            terminal = (replies[-1].get("payload") or {}).get("status")
            if terminal in ("failed", "cancelled", "canceled", "error"):
                receipt.update(state="cancelled" if terminal in ("cancelled", "canceled") else "failed",
                               evidence="assistant_terminal_state")
                write_receipt(receipt_path, receipt)
                return receipt
            parts = []
            for event in replies:
                payload = event.get("payload") or {}
                text = payload.get("display_text")
                if payload.get("status") in ("completed", "complete", "succeeded") and isinstance(text, str) and text.strip():
                    parts.append(text)
            text = "\n".join(parts)
            final_text = (replies[-1].get("payload") or {}).get("display_text", "") if replies else ""
            marker_seen = (isinstance(final_text, str) and marker is not None
                           and marker in {line.strip() for line in final_text.splitlines()})
            if parts and (marker is None or marker_seen):
                receipt.update(state="succeeded", text=text)
                if marker is not None:
                    receipt["completion_marker_observed"] = True
                write_receipt(receipt_path, receipt)
                return receipt
        time.sleep(2)
    receipt["state"] = "result_unknown"
    write_receipt(receipt_path, receipt)
    return receipt


def chat_once(client: RelayGateway, message: str, timeout: int, receipt_path: Path,
              completion_marker: str | None = None) -> dict:
    """Create a dedicated demo session, submit once, and poll that session only."""
    if not isinstance(message, str) or not message.strip():
        raise ValueError("Chat message must not be empty")
    if completion_marker is not None and (not isinstance(completion_marker, str) or not completion_marker
            or len(completion_marker) > 128 or any(char.isspace() for char in completion_marker)):
        raise ValueError("Invalid completion marker")
    receipt_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        descriptor = os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise ValueError("Receipt already exists; inspect it instead of replaying the message") from None
    with os.fdopen(descriptor, "w") as output:
        json.dump({"state": "preparing_session", "retry_safe": False}, output)
    response = client.call_json("session.start", body={
        "method": "/api/session/start",
        "params": {"origin": "fresh", "lifecycle": "persistent", "title": f"CF demo {uuid.uuid4().hex[:8]}"},
    }, timeout=15)
    session_id = response.get("session_id") if isinstance(response, dict) else None
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("No session ID returned")
    history = client.call_json("chat.history", body={"session_id": session_id, "limit": 100}, timeout=15)
    baseline = max((event["seq"] for event in history_events(history)), default=0)
    receipt = {"session_id": session_id, "state": "submission_unknown", "retry_safe": False,
               "baseline_seq": baseline, "submission_confirmed": False}
    if completion_marker is not None:
        receipt["completion_marker"] = completion_marker
    write_receipt(receipt_path, receipt)
    # Persist uncertainty BEFORE sending. No automatic fallback, reconnect or resend.
    client._open("chat.stream", body={
        "items": [{"type": "text", "text": message}],
        "node_id": "cf-cookie-demo", "capabilities": {}, "session_id": session_id,
    })
    receipt["state"] = "awaiting_result"
    write_receipt(receipt_path, receipt)
    return wait_result(client, timeout, receipt_path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("network", "cookie", "rpc", "chat", "result", "renew", "status"))
    parser.add_argument("--url", required=True, help="Worker origin, or http://127.0.0.1:8787 locally")
    parser.add_argument("--message", default="请只回复：CF Cookie demo 连接成功。不要执行任何其他操作。")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--completion-marker", help="For a controlled long task, require its unique final marker; does not prove the work itself succeeded")
    parser.add_argument("--receipt", type=Path, default=Path(".local/chat-receipt.json"))
    args = parser.parse_args()
    key = os.environ.get("DEMO_KEY", "")
    if not 32 <= len(key) <= 512 or any(char.isspace() for char in key):
        parser.error("Set DEMO_KEY to 32..512 non-whitespace characters")
    try:
        worker_origin(args.url)
    except ValueError:
        parser.error("Use a plain HTTPS Worker origin; HTTP is allowed only for localhost")
    if not 1 <= args.timeout <= 3600:
        parser.error("timeout must be between 1 and 3600 seconds")
    try:
        if args.operation in ("network", "cookie", "renew", "status"):
            path = {"network": "/probe/network", "cookie": "/probe/cookie",
                    "renew": "/credentials/refresh", "status": "/credentials/status"}[args.operation]
            response = requests.request("GET" if args.operation == "status" else "POST",
                                        f"{args.url.rstrip('/')}{path}",
                                        headers={"Authorization": f"Bearer {key}"}, timeout=75,
                                        allow_redirects=False)
            if not response.headers.get("Content-Type", "").startswith("application/json"):
                print(json.dumps({"ok": False, "error": "non_json_response", "status": response.status_code}))
                return 1
            print(json.dumps(response.json(), ensure_ascii=False, indent=2))
            return int(response.status_code != 200)
        client = RelayGateway(args.url, key)
        try:
            if args.operation == "rpc":
                client.call_json("sessions.list", timeout=15)
                result = {"ok": True, "stage": "noise_rpc", "method": "sessions.list"}
            elif args.operation == "result":
                result = wait_result(client, args.timeout, args.receipt)
            else:
                result = chat_once(client, args.message, args.timeout, args.receipt, args.completion_marker)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return int(result.get("state", "succeeded") != "succeeded")
        finally:
            client.close()
    except Exception as error:
        # Third-party exceptions may contain request URLs or headers. Do not print str(error).
        print(json.dumps({"ok": False, "error_type": type(error).__name__,
                          "note": "No retry was attempted. If chat was sent, inspect the receipt before any further action."}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
