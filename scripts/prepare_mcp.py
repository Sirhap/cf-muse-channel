#!/usr/bin/env python3
"""Create our private MCP config from a securely delivered USER_TOKEN file."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit


def main():
    """Never put secret contents in shell arguments, logs or generated client snippets."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', required=True, help='https://your-worker.workers.dev')
    parser.add_argument('--room', default='main')
    parser.add_argument('--user-token-file', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path.home() / '.config/cf-muse-channel/mcp.json')
    args = parser.parse_args()
    url = urlsplit(args.server)
    _ = url.port
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
        raise ValueError('invalid endpoint')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', args.room):
        raise ValueError('invalid room')
    token = args.user_token_file.expanduser().read_text(encoding='utf-8').strip()
    if not 32 <= len(token) <= 512 or any(char.isspace() for char in token) or token.startswith('REPLACE_'):
        raise ValueError('invalid token file')
    output = args.output.expanduser().resolve()
    root = Path(__file__).resolve().parents[1]
    if output == root or root in output.parents:
        raise ValueError('private configuration must be outside source tree')
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    output.parent.chmod(0o700)
    with output.open('x', encoding='utf-8') as target:
        os.fchmod(target.fileno(), 0o600)
        json.dump({'server_url': args.server.rstrip('/'), 'room': args.room, 'user_token': token}, target, indent=2)
        target.flush()
        os.fsync(target.fileno())
    print(json.dumps({'created': str(output), 'credentials_printed': False}))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError):
        print('MCP setup failed; check inputs, permissions and existing configuration.', file=sys.stderr)
        raise SystemExit(2)
