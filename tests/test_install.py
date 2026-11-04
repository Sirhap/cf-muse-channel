"""Private configuration, generated installation paths and hook envelopes."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class InstallTests(unittest.TestCase):
    """Use only private temporary directories, never real user setup."""

    def execute(self, script, *arguments):
        """Run a real setup command and capture potentially sensitive output."""
        return subprocess.run([sys.executable, str(ROOT / 'scripts' / script), *map(str, arguments)],
                              cwd=ROOT, capture_output=True, text=True, check=False)

    def test_generation_is_private_and_never_overwrites_existing_setup(self):
        """Separate role secrets are not printed and all files have 0600 modes."""
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'private'
            result = self.execute('init_config.py', '--server', 'wss://example.workers.dev', '--directory', target)
            self.assertEqual(result.returncode, 0, result.stderr)
            secrets = json.loads((target / 'worker-secrets.json').read_text())
            self.assertNotEqual(secrets['USER_TOKEN'], secrets['MUSE_TOKEN'])
            for value in secrets.values():
                self.assertNotIn(value, result.stdout + result.stderr)
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)
            for path in target.iterdir():
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            before = (target / 'config.json').read_bytes()
            second = self.execute('init_config.py', '--server', 'wss://example.workers.dev', '--directory', target)
            self.assertNotEqual(second.returncode, 0)
            self.assertEqual((target / 'config.json').read_bytes(), before)

    def test_setup_rejects_credentials_in_url_and_source_tree_destination(self):
        """A malformed server cannot silently change authentication routing."""
        with tempfile.TemporaryDirectory() as temporary:
            for server in ('ws://example.com', 'wss://name:secret@example.com',
                           'wss://example.com/private', 'wss://example.com?token=secret'):
                result = self.execute('init_config.py', '--server', server, '--directory', temporary)
                self.assertNotEqual(result.returncode, 0)
        result = self.execute('init_config.py', '--server', 'wss://example.com', '--directory', ROOT)
        self.assertNotEqual(result.returncode, 0)

    def test_install_renderer_handles_spaces_and_leaves_hook_disabled(self):
        """Generated wrappers can actually execute from paths containing spaces."""
        with tempfile.TemporaryDirectory(prefix='cf install ') as temporary:
            target = Path(temporary)
            config = target / 'config.json'
            config.write_text('{}')
            output = target / 'install dir'
            result = self.execute('prepare_muse.py', '--config', config, '--output', output)
            self.assertEqual(result.returncode, 0, result.stderr)
            definition = json.loads((output / 'cf-inbox.json').read_text())
            self.assertFalse(definition['enabled'])
            self.assertEqual(definition['poll_interval_secs'], 5)
            self.assertNotIn('delivery', definition)
            self.assertIn(str(output / 'cf-muse'), definition['prompt'])
            self.assertNotIn('{{CLI}}', definition['prompt'])
            for name in ('cf-inbox.sh', 'cf-muse'):
                result = subprocess.run(['bash', '-n', str(output / name)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('RestartPreventExitStatus=2', (output / 'cf-muse-channel.service').read_text())

    def test_hook_uses_runtime_wake_and_silent_without_faking_execution(self):
        """A stub runtime validates the platform envelope, never real AI execution."""
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            runtime = target / 'runtime.sh'
            runtime.write_text('wake() { printf "WAKE:%s\\n" "$2"; }\nsilent() { printf "SILENT:%s\\n" "$2"; }\n')
            cli = target / 'cli'
            environment = dict(os.environ, HATCH_HOOK_RUNTIME=str(runtime), CF_MUSE_CLI=str(cli))
            for count, expected in ((0, 'SILENT:{}'), (1, 'WAKE:')):
                cli.write_text('#!/usr/bin/env bash\nprintf \'%s\\n\' \'{"count":' + str(count) + ',"messages":[]}\'\n')
                cli.chmod(0o700)
                result = subprocess.run(['bash', str(ROOT / 'hooks/cf-inbox.sh')], env=environment,
                                        text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(result.stdout.startswith(expected), result.stdout)
            cli.write_text('#!/usr/bin/env bash\nexit 2\n')
            result = subprocess.run(['bash', str(ROOT / 'hooks/cf-inbox.sh')], env=environment,
                                    text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('WAKE:', result.stdout)


    def test_mcp_config_preparation_keeps_user_secret_outside_source_tree(self):
        """Setup references secret files, never accepts their values as CLI arguments."""
        with tempfile.TemporaryDirectory() as directory:
            token = Path(directory) / 'user-token.txt'
            token.write_text('private-' + 'x' * 40)
            destination = Path(directory) / 'config' / 'mcp.json'
            result = self.execute('prepare_mcp.py', '--server', 'https://example.com',
                                  '--user-token-file', token, '--output', destination)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn(token.read_text(), result.stdout + result.stderr)
            self.assertEqual(json.loads(destination.read_text())['user_token'], token.read_text())
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
            repeated = self.execute('prepare_mcp.py', '--server', 'https://example.com',
                                    '--user-token-file', token, '--output', destination)
            self.assertEqual(repeated.returncode, 2)


if __name__ == '__main__':
    unittest.main()
