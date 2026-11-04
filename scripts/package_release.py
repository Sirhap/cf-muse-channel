#!/usr/bin/env python3
"""Build a source-only deployment ZIP with a checksum and no runtime secrets."""
from __future__ import annotations

import hashlib
from pathlib import Path
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DIRECTORIES = ('worker', 'public', 'muse_adapter', 'cf_mcp', 'hooks', 'scripts', 'docs', 'tests', 'tests_mcp')
FILES = ('README.md', 'package.json', 'package-lock.json', 'wrangler.jsonc',
         'requirements.txt', 'requirements-mcp.txt', 'config.example.json', 'mcp-config.example.json', '.gitignore')


def main() -> int:
    """Use an explicit allowlist, excluding dependencies, state and all secret files."""
    version = json.loads((ROOT / 'package.json').read_text())['version']
    destination = ROOT.parent / f'cf-muse-channel-{version}.zip'
    files = [ROOT / name for name in FILES]
    files.extend(path for name in DIRECTORIES for path in (ROOT / name).rglob('*')
                 if path.is_file() and '__pycache__' not in path.parts
                 and not path.name.startswith('.') and path.suffix not in ('.pyc', '.sqlite3', '.log'))
    for path in files:
        if not path.is_file() or path.is_symlink():
            raise ValueError('missing or nonregular release input: ' + str(path.relative_to(ROOT)))
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(files):
            bundle.write(path, Path('cf-muse-channel') / path.relative_to(ROOT))
    with zipfile.ZipFile(destination) as bundle:
        if bundle.testzip() is not None:
            raise ValueError('ZIP integrity failure')
        forbidden = {'node_modules', '.wrangler', '.venv', 'state', '__pycache__', '.dev.vars', 'secrets.json', 'config.json', 'mcp.json', 'worker-secrets.json', 'user-token.txt', '.venv-mcp'}
        for member in bundle.namelist():
            if any(part in forbidden for part in Path(member).parts):
                raise ValueError('private runtime path entered the release')
    checksum = hashlib.sha256(destination.read_bytes()).hexdigest()
    destination.with_suffix('.zip.sha256').write_text(checksum + '  ' + destination.name + '\n')
    print(destination)
    print('SHA256 ' + checksum)
    print('Files ' + str(len(files)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
