"""Sync-websocket transport for the CF relay, built on the websockets library.

Used ONLY on the MUSE_CF_EVENT_STREAM path. The Muse VM's egress path
adds ``Connection: upgrade, close`` to the Worker's /ws 101 response, and
libcurl/curl_cffi refuses to enter websocket mode on such a response
("Invalid active socket"), so no new CF connection can be established
with the curl_cffi transport. The websockets library accepts both
``Connection: upgrade`` and ``Connection: upgrade, close`` (verified
against a local server returning each), which is why this transport
exists. It presents the same minimal interface the SDK Gateway expects
from a curl_cffi WebSocket: ``connect(url, ...)``,
``send_bytes(bytes)``, ``recv() -> (bytes, flags)``, ``close()``.

Same URL/key, same egress proxy (``proxy=True`` reads it from the
environment), TLS verification on (default SSL context). No global
package change: websockets 17.2 is already installed in the gateway
venv, and this module is only imported when MUSE_CF_EVENT_STREAM=1.
"""
from websockets.sync.client import connect as _ws_connect

# Mirrors CurlWsFlag.BINARY. The SDK ignores the flags value.
_BINARY = 2


class SyncWebSocket:
    """A curl_cffi-WebSocket-shaped wrapper around websockets.sync.client."""

    def __init__(self):
        self._ws = None

    def connect(self, url, headers=None, timeout=75, **ignored):
        # curl-only options (impersonate, http_version, verify) arrive here
        # from the shared call site and are intentionally ignored: the
        # websockets client speaks HTTP/1.1 natively and verifies TLS by
        # default. proxy=True (the default) uses the environment proxy.
        self._ws = _ws_connect(
            url,
            additional_headers=headers or {},
            open_timeout=timeout,
            close_timeout=10,
        )
        return self

    def send_bytes(self, data):
        self._ws.send(bytes(data))

    def recv(self):
        data = self._ws.recv()
        if isinstance(data, str):
            data = data.encode()
        return bytes(data), _BINARY

    def close(self):
        ws, self._ws = self._ws, None
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass
