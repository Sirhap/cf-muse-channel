"""Credential import must be scoped, bounded, private and atomic."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from test_secrets import secrets


class SecretBoundaryTests(unittest.TestCase):
    def archive(self, path, cookie, vm="vm-test", extra=None):
        with zipfile.ZipFile(path, "w") as z:
            z.writestr("cookies.txt", cookie)
            z.writestr("vm_id.txt", vm)
            for name, content in (extra or {}).items(): z.writestr(name, content)

    def test_split_exact_limit_and_overflow(self):
        for size in (4096, 4097, 8192):
            with self.subTest(size=size):
                cookie = "a=" + "x" * (size - 2)
                parts = secrets.split_cookie(cookie)
                self.assertEqual("".join(parts), cookie)
                self.assertTrue(all(len(part.encode()) <= 4096 for part in parts))
        with self.assertRaises(ValueError): secrets.split_cookie("a=" + "x" * 8191)

    def test_split_does_not_cut_multibyte_characters(self):
        cookie = "a=" + "界" * 2000
        pieces = secrets.split_cookie(cookie)
        self.assertEqual("".join(pieces), cookie)
        self.assertTrue(all(len(piece.encode()) <= 4096 for piece in pieces))

    def test_control_characters_are_rejected(self):
        for value in ("a=x\r\nb=y", "a=x\x00y", "a=x\x7fy", "a=x\ty"):
            with self.subTest(value=repr(value)), self.assertRaises(ValueError):
                secrets.split_cookie(value)

    def test_imports_both_supported_json_cookie_formats(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "credentials.zip"
            for payload in ({"a": "b", "c": "d=="}, {"cookies": {"a": "b", "c": "d=="}}):
                with self.subTest(nested="cookies" in payload):
                    self.archive(path, json.dumps(payload))
                    data = secrets.import_archive(path, {})
                    self.assertEqual(data["MUSE_COOKIE_PART_1"] + data["MUSE_COOKIE_PART_2"], "a=b; c=d==")
                    self.assertGreaterEqual(len(data["DEMO_KEY"]), 32)

    def test_rejects_missing_or_oversized_archive_entries(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "credentials.zip"
            with zipfile.ZipFile(path, "w") as z: z.writestr("cookies.txt", "a=b")
            with self.assertRaises(ValueError): secrets.import_archive(path, {})
            self.archive(path, "a=" + "x" * (1024 * 1024))
            with self.assertRaises(ValueError): secrets.import_archive(path, {})

    def test_rejects_ambiguous_duplicate_credential_basenames(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "credentials.zip"
            self.archive(path, "a=correct", extra={"backup/cookies.txt": "a=wrong-account"})
            with self.assertRaises(ValueError): secrets.import_archive(path, {})

    def test_does_not_promote_a_subdomain_cookie_to_the_muse_root(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "credentials.zip"
            self.archive(path, ".muse.ai\tTRUE\t/\tTRUE\t0\thatch_sess\troot\n"
                         "private.muse.ai\tFALSE\t/\tTRUE\t0\tprivate\tscoped\n")
            data = secrets.import_archive(path, {})
            self.assertEqual(data["MUSE_COOKIE_PART_1"] + data["MUSE_COOKIE_PART_2"], "hatch_sess=root")

    def test_invalid_json_structure_and_multiline_vm_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "credentials.zip"
            for cookie, vm in [(json.dumps({"cookies": []}), "vm"), ("a=b", "vm\nother")]:
                self.archive(path, cookie, vm)
                with self.assertRaises(ValueError): secrets.import_archive(path, {})

    def test_private_write_is_atomic_and_preserves_old_data_on_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / ".dev.vars"
            secrets.private_write(path, 'DEMO_KEY="previous-key"\n')
            before = path.read_bytes()
            with patch.object(Path, "replace", side_effect=OSError("rename failed")):
                with self.assertRaises(OSError): secrets.private_write(path, 'DEMO_KEY="replacement-key"\n')
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_dotenv_parser_never_executes_shell_text(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / ".dev.vars"
            path.write_text(' # comment\nMUSE_COOKIE="a=$(touch forbidden); b=`whoami`"\n')
            self.assertEqual(secrets.load_vars(path)["MUSE_COOKIE"], "a=$(touch forbidden); b=`whoami`")
            self.assertFalse((path.parent / "forbidden").exists())
