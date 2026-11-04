"""Explicit private configuration with no import-time filesystem access."""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Config:
    """A single configured endpoint, room and local persistence directory."""
    server_url: str
    room: str
    muse_token: str
    state_dir: Path

    @property
    def socket_url(self) -> str:
        """Bind the connection to the configured role without putting credentials in URLs."""
        return self.server_url + '/ws/' + self.room + '?role=muse'

    @property
    def api_url(self) -> str:
        """Derive the HTTPS media endpoint from the WSS endpoint; the token travels in a header."""
        parsed = urlsplit(self.server_url)
        scheme = 'https' if parsed.scheme == 'wss' else 'http'
        return scheme + '://' + parsed.netloc + '/api/rooms/' + self.room + '/media'


def load_config(path: str | None = None) -> Config:
    """Reject insecure public endpoints and incomplete secrets before any connection."""
    source = Path(path or os.environ.get('CF_MUSE_CONFIG', '~/.config/cf-muse-channel/config.json')).expanduser()
    data = json.loads(source.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise ValueError('invalid configuration')
    url = data.get('server_url', '')
    if not isinstance(url, str):
        raise ValueError('invalid endpoint')
    parsed = urlsplit(url)
    local = parsed.hostname in ('127.0.0.1', 'localhost', '::1')
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in ('', '/') or parsed.scheme not in ('ws', 'wss')
            or (parsed.scheme == 'ws' and not (local and data.get('allow_insecure_localhost') is True))):
        raise ValueError('invalid endpoint')
    room = data.get('room', 'main')
    token = data.get('muse_token', '')
    if not isinstance(room, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', room):
        raise ValueError('invalid room')
    if not isinstance(token, str) or not 32 <= len(token) <= 512 or token.startswith('REPLACE_') or any(c.isspace() for c in token):
        raise ValueError('invalid credential')
    state = data.get('state_dir', str(Path.home() / '.local/state/cf-muse-channel'))
    if not isinstance(state, str) or not state.strip():
        raise ValueError('invalid state directory')
    return Config(url.rstrip('/'), room, token, Path(state).expanduser().resolve())
