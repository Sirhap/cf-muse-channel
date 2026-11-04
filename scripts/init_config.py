#!/usr/bin/env python3
"""Generate private channel credentials without displaying their values."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
from urllib.parse import urlsplit


def private_write(path: Path, text: str) -> None:
    """Create a new secret file exclusively; never overwrite existing setup."""
    with path.open("x", encoding="utf-8") as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(text)
        output.flush()
        os.fsync(output.fileno())


def main() -> int:
    """Keep all generated credentials outside the distributable source tree."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True, help="wss://your-worker.workers.dev")
    parser.add_argument("--room", default="main")
    parser.add_argument("--directory", type=Path, default=Path.home() / ".config/cf-muse-channel")
    args = parser.parse_args()
    parsed = urlsplit(args.server)
    if (parsed.scheme != "wss" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        parser.error("--server must be a clean wss:// hostname without credentials or path")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.room):
        parser.error("invalid room")
    directory = args.directory.expanduser().resolve()
    project = Path(__file__).resolve().parents[1]
    if directory == project or project in directory.parents:
        parser.error("credential directory must be outside the source project")
    names = ("config.json", "worker-secrets.json", "user-token.txt")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    if any((directory / name).exists() for name in names):
        parser.error("setup files already exist; inspect them before any credential rotation")
    user_token, muse_token = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    private_write(directory / "config.json", json.dumps({
        "server_url": args.server.rstrip("/"), "room": args.room,
        "muse_token": muse_token,
        "state_dir": str(Path.home() / ".local/state/cf-muse-channel"),
    }, indent=2) + "\n")
    private_write(directory / "worker-secrets.json", json.dumps({
        "USER_TOKEN": user_token, "MUSE_TOKEN": muse_token,
    }, indent=2) + "\n")
    private_write(directory / "user-token.txt", user_token + "\n")
    print(json.dumps({"created": [str(directory / name) for name in names],
                      "credentials_printed": False}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError):
        print("Private setup failed; inspect destination permissions and existing files.", file=__import__("sys").stderr)
        raise SystemExit(1)
