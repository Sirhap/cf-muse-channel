from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("deploy_script", ROOT / "scripts" / "deploy.py")
assert SPEC and SPEC.loader
deploy = importlib.util.module_from_spec(SPEC)
sys.modules["deploy_script"] = deploy
SPEC.loader.exec_module(deploy)


class DeployScriptTests(unittest.TestCase):
    """验证 scripts/deploy.py 的配置解析、并发提速、防驻留回收、切版门禁与脱敏边界。"""

    def test_load_wrangler_config_handles_jsonc_comments_urls_and_trailing_commas(self) -> None:
        raw_jsonc = """
        {
          // 顶部单行注释，且下面字符串内包含 https:// URL 双斜杠
          "$schema": "https://developers.cloudflare.com/workers/wrangler/config-schema.json",
          "name": "sample-managed-worker",
          "account_id": "acc_unit_test_only",
          /* 块注释：
             验证自定义域名与跨 Worker DO 绑定识别 */
          "routes": [
            {
              "pattern": "managed.example.invalid",
              "custom_domain": true,
            },
          ],
          "durable_objects": {
            "bindings": [
              {
                "name": "CREDENTIALS",
                "class_name": "MuseCredentials",
                "script_name": "sample-cookie-worker",
              },
              {
                "name": "MOBILE",
                "class_name": "ManagedChannels",
              },
            ],
          },
        }
        """
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "wrangler.test.jsonc"
            cfg.write_text(raw_jsonc, encoding="utf-8")
            target = deploy.load_wrangler_config(cfg)
            self.assertEqual(target.name, "sample-managed-worker")
            self.assertEqual(target.account_id, "acc_unit_test_only")
            self.assertEqual(target.custom_domain, "managed.example.invalid")
            self.assertTrue(target.owns_managed_do)
            self.assertFalse(target.owns_credentials_do)

    def test_build_wrangler_env_strips_proxies_and_disables_banner_update_check(self) -> None:
        dirty_env = {
            "PATH": "/usr/bin:/bin",
            "HTTP_PROXY": "http://127.0.0.1:7890",
            "http_proxy": "http://127.0.0.1:7890",
            "HTTPS_PROXY": "http://127.0.0.1:7890",
            "https_proxy": "http://127.0.0.1:7890",
            "ALL_PROXY": "socks5://127.0.0.1:7891",
            "all_proxy": "socks5://127.0.0.1:7891",
        }
        cleaned = deploy.build_wrangler_env(dirty_env)
        for key in deploy.PROXY_ENV_KEYS:
            self.assertNotIn(key, cleaned)
        self.assertEqual(cleaned["WRANGLER_HIDE_BANNER"], "true")
        self.assertEqual(cleaned["WRANGLER_SEND_METRICS"], "false")
        self.assertEqual(cleaned["CI"], "true")

        kept = deploy.build_wrangler_env(dirty_env, keep_proxy=True)
        self.assertEqual(kept["HTTP_PROXY"], "http://127.0.0.1:7890")
        self.assertEqual(kept["WRANGLER_HIDE_BANNER"], "true")

    def test_deploy_target_reaps_hanging_wrangler_after_version_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "wrangler.jsonc"
            cfg.write_text('{"name": "hang-demo"}', encoding="utf-8")
            target = deploy.load_wrangler_config(cfg)

            fake_wrangler = (
                "import sys, time\n"
                "print('Total Upload: 273.70 KiB / gzip: 74.69 KiB', flush=True)\n"
                "print('Uploaded hang-demo (4.12 sec)', flush=True)\n"
                "print('Deployed hang-demo triggers (2.05 sec)', flush=True)\n"
                "print('Current Version ID: 11111111-2222-3333-4444-555555555555', flush=True)\n"
                "time.sleep(30)\n"
            )
            t0 = time.monotonic()
            res = deploy.deploy_target(
                target,
                wrangler_cmd=[sys.executable, "-c", fake_wrangler, "--"],
                exit_grace_sec=0.2,
                timeout_sec=10.0,
            )
            dt = time.monotonic() - t0
            self.assertTrue(res.ok)
            self.assertEqual(res.version_id, "11111111-2222-3333-4444-555555555555")
            self.assertEqual(res.upload_time, "4.12 sec")
            self.assertEqual(res.triggers_time, "2.05 sec")
            self.assertTrue(res.terminated_hanging_process)
            self.assertLess(dt, 3.0)

    def test_deploy_targets_runs_in_parallel_and_propagates_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg1 = Path(tmp) / "w1.jsonc"
            cfg2 = Path(tmp) / "w2.jsonc"
            cfg1.write_text('{"name": "worker-a"}', encoding="utf-8")
            cfg2.write_text('{"name": "worker-b"}', encoding="utf-8")
            t1 = deploy.load_wrangler_config(cfg1)
            t2 = deploy.load_wrangler_config(cfg2)

            ok_script = (
                "import time\n"
                "time.sleep(0.35)\n"
                "print('Current Version ID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', flush=True)\n"
            )
            t0 = time.monotonic()
            results = deploy.deploy_targets(
                [t1, t2],
                sequential=False,
                wrangler_cmd=[sys.executable, "-c", ok_script, "--"],
                exit_grace_sec=0.1,
            )
            elapsed = time.monotonic() - t0
            self.assertEqual(len(results), 2)
            self.assertTrue(all(r.ok for r in results))
            self.assertLess(elapsed, 0.65)

            fail_script = "import sys; print('Fatal error', flush=True); sys.exit(1)\n"
            fail_results = deploy.deploy_targets(
                [t1, t2],
                sequential=False,
                wrangler_cmd=[sys.executable, "-c", fail_script, "--"],
                exit_grace_sec=0.1,
            )
            self.assertTrue(all(not r.ok for r in fail_results))

    def test_immediate_deployment_safety_gates_and_api_contract(self) -> None:
        target = deploy.WranglerTarget(
            config_path=ROOT / "wrangler.jsonc",
            name="managed-stage-test",
            account_id="acc_test_123",
            custom_domain="managed.example.invalid",
            owns_managed_do=True,
        )

        # 1. 缺少 admin_key 且非 force 时必须拒绝切版
        res_no_key = deploy.apply_immediate_deployment(
            target,
            expected_version_id="v-1",
            mode="settled",
            cf_token="cf_tok_secret",
            admin_key=None,
        )
        self.assertFalse(res_no_key.ok)
        self.assertTrue(res_no_key.skipped)
        self.assertEqual(res_no_key.reason, "missing_admin_key")

        # 2. settled 模式下存在 sending 或 running 任务时拒绝切版且绝不调用 POST /deployments
        calls: list[tuple[str, str]] = []

        def fake_http_in_flight(method: str, url: str, **kwargs):
            calls.append((method, url))
            if url.endswith("/admin/managed/status"):
                return 200, {
                    "channels": {"wechat": {"enabled": True}},
                    "tasks": [{"id": "t1", "state": "running"}],
                    "outbound": [{"id": "o1", "state": "sending"}],
                }
            raise AssertionError("不应在存在在途任务时访问 Cloudflare deployments API")

        res_busy = deploy.apply_immediate_deployment(
            target,
            expected_version_id="v-1",
            mode="settled",
            cf_token="cf_tok_secret",
            admin_key="adm_secret",
            http_json=fake_http_in_flight,
        )
        self.assertFalse(res_busy.ok)
        self.assertTrue(res_busy.skipped)
        self.assertEqual(res_busy.reason, "in_flight_tasks_or_outbound")
        self.assertEqual(len(calls), 1)

        # 3. settled 模式下所有任务已终态且投递 settled，允许并正确发送 code_update_strategy=immediate
        posted_bodies: list[dict] = []

        def fake_http_settled(method: str, url: str, **kwargs):
            if url.endswith("/admin/managed/status"):
                return 200, {
                    "channels": {"wechat": {"enabled": True}},
                    "tasks": [{"id": "t1", "state": "succeeded"}],
                    "outbound": [{"id": "o1", "state": "delivered"}],
                }
            if method == "GET" and url.endswith("/deployments"):
                return 200, {
                    "success": True,
                    "result": {
                        "deployments": [
                            {"versions": [{"version_id": "v-100", "percentage": 100}]}
                        ]
                    },
                }
            if method == "POST" and url.endswith("/deployments"):
                posted_bodies.append(kwargs.get("json_body"))
                return 200, {"success": True}
            raise AssertionError(f"Unexpected call: {method} {url}")

        res_ok = deploy.apply_immediate_deployment(
            target,
            expected_version_id="v-100",
            mode="settled",
            cf_token="cf_tok_secret",
            admin_key="adm_secret",
            http_json=fake_http_settled,
        )
        self.assertTrue(res_ok.ok)
        self.assertFalse(res_ok.skipped)
        self.assertEqual(res_ok.version_id, "v-100")
        self.assertEqual(len(posted_bodies), 1)
        self.assertEqual(
            posted_bodies[0],
            {
                "strategy": "percentage",
                "versions": [{"version_id": "v-100", "percentage": 100}],
                "code_update_strategy": {"mode": "immediate"},
            },
        )

    def test_redaction_prevents_secret_leak_in_logs_and_json_report(self) -> None:
        fake_admin = "super_secret_admin_token_987654"
        fake_oauth = "cf_oauth_secret_token_123456"
        raw = f"Authorization: Bearer {fake_admin} and oauth={fake_oauth}"
        redacted = deploy.redact_sensitive(raw, [fake_admin, fake_oauth])
        self.assertNotIn(fake_admin, redacted)
        self.assertNotIn(fake_oauth, redacted)
        self.assertIn("[REDACTED]", redacted)

        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "wrangler.jsonc"
            cfg.write_text('{"name": "redact-worker"}', encoding="utf-8")
            key_file = Path(tmp) / "admin.key"
            key_file.write_text(fake_admin, encoding="utf-8")
            report_file = Path(tmp) / "report.json"

            leaky_proc = (
                "import sys\n"
                f"print('Error header Authorization: Bearer {fake_admin} token={fake_oauth}', flush=True)\n"
                "sys.exit(1)\n"
            )
            stdout_buf = io.StringIO()
            stderr_buf = io.StringIO()
            with mock.patch.object(
                deploy,
                "resolve_wrangler_command",
                return_value=[sys.executable, "-c", leaky_proc, "--"],
            ), mock.patch("sys.stdout", stdout_buf), mock.patch("sys.stderr", stderr_buf):
                rc = deploy.main(
                    [
                        "--config",
                        str(cfg),
                        "--admin-key-file",
                        str(key_file),
                        "--json-report",
                        str(report_file),
                    ]
                )

            self.assertEqual(rc, 1)
            combined_out = stdout_buf.getvalue() + stderr_buf.getvalue() + report_file.read_text(encoding="utf-8")
            self.assertNotIn(fake_admin, combined_out)


if __name__ == "__main__":
    unittest.main()
