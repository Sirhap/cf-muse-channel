import importlib.util,json,os
from pathlib import Path
import tempfile,unittest
from unittest.mock import Mock,patch
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('bridge',ROOT/'client/bridge.py');bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
spec2=importlib.util.spec_from_file_location('patcher',ROOT/'scripts/prepare_channel_integration.py');patcher=importlib.util.module_from_spec(spec2);spec2.loader.exec_module(patcher)
class BridgeTests(unittest.TestCase):
 def test_private_config_proves_rpc_and_returns_client(self):
  fake=Mock();fake.RelayGateway.return_value.call_json.return_value={}
  with tempfile.TemporaryDirectory()as d:
   p=Path(d)/'relay.json';p.write_text(json.dumps({'url':'https://relay.test','key':'a'*40}));p.chmod(0o600)
   with patch.dict(bridge.sys.modules,{'_cf_muse_relay_probe':fake}):
    self.assertIs(bridge.connect(p),fake.RelayGateway.return_value)
    fake.RelayGateway.return_value.call_json.assert_called_once_with('sessions.list',timeout=15)
 def test_world_readable_config_rejected_before_network(self):
  fake=Mock()
  with tempfile.TemporaryDirectory()as d:
   p=Path(d)/'relay.json';p.write_text('{}');p.chmod(0o644)
   with patch.dict(bridge.sys.modules,{'_cf_muse_relay_probe':fake}),self.assertRaises(ValueError):bridge.connect(p)
   fake.RelayGateway.assert_not_called()
 def test_rpc_failure_closes_and_redacts(self):
  fake=Mock();fake.RelayGateway.return_value.call_json.side_effect=RuntimeError('private-cookie')
  with tempfile.TemporaryDirectory()as d:
   p=Path(d)/'relay.json';p.write_text(json.dumps({'url':'https://relay.test','key':'a'*40}));p.chmod(0o600)
   with patch.dict(bridge.sys.modules,{'_cf_muse_relay_probe':fake}),self.assertRaisesRegex(ConnectionError,'CF relay connection failed'):bridge.connect(p)
   fake.RelayGateway.return_value.close.assert_called_once()
 def test_minimal_patch_is_idempotent_and_preserves_legacy_logic(self):
  text='import os, importlib.util\ndef connect():\n    """Original transport."""\n    return "legacy"\n'
  updated=patcher.patch_source(text)
  self.assertEqual(patcher.patch_source(updated),updated)
  scope={};exec(compile(updated,'bridge','exec'),scope)
  with patch.dict(os.environ,{},clear=True):self.assertEqual(scope['connect'](),'legacy')
 def test_unexpected_source_is_rejected(self):
  with self.assertRaises(ValueError):patcher.patch_source('def different():\n    pass\n')
 def test_enabled_branch_prepares_sdk_before_loading_external_transport(self):
  text='import os, importlib.util\ndef connect():\n    """Original transport."""\n    return "legacy"\n'
  scope={};exec(compile(patcher.patch_source(text),'bridge','exec'),scope)
  prepared=Mock();module=Mock();module.connect.side_effect=lambda path: self.assertTrue(prepared.called)or'CF'
  fake_import=Mock();fake_import.util.module_from_spec.return_value=module
  scope['_ensure_muse_cli_path']=prepared;scope['importlib']=fake_import
  with patch.dict(os.environ,{'MUSE_CF_RELAY_CONFIG':'private.json','MUSE_CF_RELAY_SOURCE':'/client/bridge.py'}):
   self.assertEqual(scope['connect'](),'CF')
  prepared.assert_called_once()
