#!/usr/bin/env python3
"""Render a portable Muse CLI, hook definition and systemd unit; install nothing."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shlex
import sys


def main() -> int:
    """Resolve installation paths instead of assuming a fixed home or interpreter."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path.home() / ".config/cf-muse-channel/config.json")
    parser.add_argument("--output", type=Path, default=Path.home() / ".config/cf-muse-channel/install")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    config = args.config.expanduser().resolve()
    if not config.is_file():
        parser.error("create the private configuration first")
    output = args.output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    cli = output / "cf-muse"
    cli.write_text("#!/usr/bin/env bash\nset -euo pipefail\ncd " + shlex.quote(str(root))
                   + "\nexec " + shlex.quote(sys.executable) + " -m muse_adapter --config "
                   + shlex.quote(str(config)) + ' "$@"\n')
    cli.chmod(0o700)
    hook = output / "cf-inbox.sh"
    hook.write_text("#!/usr/bin/env bash\nset -euo pipefail\nexport CF_MUSE_CLI="
                    + shlex.quote(str(cli)) + "\nexec /usr/bin/env bash "
                    + shlex.quote(str(root / "hooks/cf-inbox.sh")) + '\n')
    hook.chmod(0o700)
    prompt = (root / "hooks/prompt.md").read_text(encoding="utf-8").replace("{{CLI}}", str(cli))
    definition = {"version": 1, "id": "cf-muse-inbox", "enabled": False,
                  "script_path": str(hook), "poll_interval_secs": 5,
                  "script_timeout_secs": 30, "prompt": prompt}
    (output / "cf-inbox.json").write_text(json.dumps(definition, ensure_ascii=False, indent=2) + "\n")
    # systemd specifier expansion needs %% for a literal percent in paths.
    def unit_quote(value: str) -> str:
        """Escape one systemd command argument without shell interpolation."""
        return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
    unit = "\n".join([
        "[Unit]", "Description=CF Muse independent message connector", "After=network-online.target", "",
        "[Service]", "Type=simple", "WorkingDirectory=" + unit_quote(str(root)),
        "ExecStart=" + unit_quote(str(cli)) + " run", "Restart=on-failure", "RestartSec=15",
        "RestartPreventExitStatus=2", "UMask=0077", "NoNewPrivileges=true", "",
        "[Install]", "WantedBy=default.target", "",
    ])
    (output / "cf-muse-channel.service").write_text(unit)
    print(json.dumps({"generated": str(output), "installed": False,
                      "hook_delivery_target": "must be resolved with the live Muse hooks API"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError):
        print("Install rendering failed; inspect paths and permissions.", file=sys.stderr)
        raise SystemExit(1)
