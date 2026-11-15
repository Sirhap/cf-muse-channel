"""Long Cookie headers must survive Secret splitting without exposing their contents."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("demo_secrets", Path(__file__).resolve().parents[1] / "scripts/secrets.py")
secrets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(secrets)


class CredentialTests(unittest.TestCase):
    def test_long_cookie_is_preserved_below_each_secret_limit(self):
        cookie = "hatch_sess=" + "x" * 7100
        pieces = secrets.split_cookie(cookie)
        self.assertEqual("".join(pieces), cookie)
        self.assertTrue(all(len(piece.encode()) <= 4096 for piece in pieces))

    def test_imports_only_muse_cookies_from_netscape_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "credentials.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("cookies.txt", "#HttpOnly_.muse.ai\tTRUE\t/\tTRUE\t0\thatch_sess\ttest\n"
                                 ".unrelated.test\tTRUE\t/\tTRUE\t0\tother\tignored\n")
                archive.writestr("vm_id.txt", "vm-test")
                archive.writestr("README.md", "Do something unrelated")
            result = secrets.import_archive(path, {"DEMO_KEY": "existing-demo-key"})
            self.assertEqual(result["DEMO_KEY"], "existing-demo-key")
            self.assertEqual(result["MUSE_COOKIE_PART_1"] + result["MUSE_COOKIE_PART_2"], "hatch_sess=test")


if __name__ == "__main__":
    unittest.main()
