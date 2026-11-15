#!/usr/bin/env python3
"""Import a private credential archive or prepare bounded Cloudflare Secrets."""
import argparse
import json
import os
from pathlib import Path
import secrets
import tempfile
import zipfile


def private_write(path: Path, text: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def load_vars(path: Path) -> dict:
    """Read this demo's quoted JSON-compatible dotenv values without executing a shell."""
    if not path.exists():
        return {}
    result = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        result[key.strip()] = json.loads(value)
    return result


def split_cookie(cookie: str) -> tuple[str, str]:
    """Preserve the complete header while keeping each Secret below 5 KiB."""
    if (not isinstance(cookie, str) or not cookie.strip()
            or any(ord(char) < 32 or ord(char) == 127 for char in cookie)):
        raise ValueError("Expected a single-line Cookie request header")
    pieces = ["", ""]
    index = 0
    for char in cookie:
        if len((pieces[index] + char).encode()) > 4096:
            index += 1
            if index == 2:
                raise ValueError("Cookie exceeds this demo's 8 KiB credential limit")
        pieces[index] += char
    return pieces[0], pieces[1]


def import_archive(archive: Path, values: dict) -> dict:
    with zipfile.ZipFile(archive) as source:
        entries = {}
        for item in source.infolist():
            if item.is_dir():
                continue
            name = Path(item.filename).name
            if name in ("cookies.txt", "vm_id.txt") and name in entries:
                raise ValueError("Ambiguous duplicate credential entry")
            entries[name] = item
        if any(name not in entries or entries[name].file_size > 1024 * 1024
               for name in ("cookies.txt", "vm_id.txt")):
            raise ValueError("Expected cookies.txt and vm_id.txt, each below 1 MiB")
        raw = source.read(entries["cookies.txt"]).decode().strip()
        if raw.startswith("{"):
            data = json.loads(raw)
            mapping = data.get("cookies", data)
            if not isinstance(mapping, dict):
                raise ValueError("Expected a Cookie JSON object")
            cookie = "; ".join(f"{key}={value}" for key, value in mapping.items())
        elif "\t" in raw:
            fields = []
            for line in raw.splitlines():
                line = line.removeprefix("#HttpOnly_")
                if not line or line.startswith("#"):
                    continue
                columns = line.split("\t")
                if len(columns) >= 7 and columns[0].lstrip(".").lower() == "muse.ai" and columns[2] == "/":
                    fields.append(f"{columns[5]}={columns[6]}")
            cookie = "; ".join(fields)
        else:
            cookie = " ".join(raw.splitlines()).strip()
        first, second = split_cookie(cookie)
        vm_id = source.read(entries["vm_id.txt"]).decode().strip()
        if not vm_id or "\r" in vm_id or "\n" in vm_id:
            raise ValueError("Expected a VM ID")
    return {"DEMO_KEY": values.get("DEMO_KEY") or secrets.token_urlsafe(32), "MUSE_COOKIE": "",
            "MUSE_COOKIE_PART_1": first, "MUSE_COOKIE_PART_2": second, "MUSE_VM_ID": vm_id}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("import", "prepare"))
    parser.add_argument("archive", nargs="?", type=Path)
    args = parser.parse_args()
    values = load_vars(Path(".dev.vars"))
    if args.operation == "import":
        if args.archive is None:
            parser.error("import requires the credential ZIP path")
        values = import_archive(args.archive, values)
        private_write(Path(".dev.vars"), "".join(f"{key}={json.dumps(value)}\n" for key, value in values.items()))
        print("Credentials imported into .dev.vars; values omitted.")
    else:
        cookie = (values.get("MUSE_COOKIE_PART_1", "") + values.get("MUSE_COOKIE_PART_2", "")
                  if values.get("MUSE_COOKIE_PART_1") else values.get("MUSE_COOKIE", ""))
        first, second = split_cookie(cookie)
        key = values.get("DEMO_KEY", "")
        if not 32 <= len(key) <= 512 or any(char.isspace() for char in key):
            raise ValueError("DEMO_KEY must have 32..512 non-whitespace characters")
        payload = {"DEMO_KEY": values["DEMO_KEY"], "MUSE_COOKIE_PART_1": first, "MUSE_COOKIE_PART_2": second}
        if values.get("MUSE_VM_ID"):
            payload["MUSE_VM_ID"] = values["MUSE_VM_ID"]
        private_write(Path(".local/worker-secrets.json"), json.dumps(payload))
        print("Private .local/worker-secrets.json prepared; values omitted.")


if __name__ == "__main__":
    main()
