"""Verify endpoint restrictions and error output using real CLI invocations."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from muse_adapter.config import load_config


class ConfigTests(unittest.TestCase):
    """No test connects to a real server or opens real credentials."""

    def test_secure_endpoint_and_explicit_loopback_opt_in(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'config.json'
            data = {'server_url': 'wss://example.com', 'muse_token': 'a' * 43, 'state_dir': temporary}
            path.write_text(json.dumps(data))
            self.assertEqual(load_config(str(path)).socket_url, 'wss://example.com/ws/main?role=muse')
            for bad in ('ws://example.com', 'ws://127.0.0.1:1234', 'wss://user:secret@example.com', 'wss://example.com?secret=x', 'wss://example.com/path'):
                path.write_text(json.dumps(dict(data, server_url=bad)))
                with self.assertRaises(ValueError):
                    load_config(str(path))
            path.write_text(json.dumps(dict(data, server_url='ws://127.0.0.1:1234', allow_insecure_localhost=True)))
            self.assertTrue(load_config(str(path)).socket_url.startswith('ws:'))

    def test_invalid_private_config_does_not_leak_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'config.json'
            path.write_text('{"private": "VERY_PRIVATE", BROKEN')
            result = subprocess.run([sys.executable, '-m', 'muse_adapter', '--config', str(path), 'status'], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertNotIn('VERY_PRIVATE', result.stdout + result.stderr)
            self.assertNotIn('Traceback', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
