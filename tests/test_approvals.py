import importlib.util
from pathlib import Path
import sys,tempfile,time,unittest,json
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'client'))
import approvals

NOW=1800000000
RULES=[{'host':'parity.sirhao.top','port':443,'scheme':'https','methods':['GET','HEAD','CONNECT']}]
def record(**kw):return dict({'approval_id':'approval-1','host':'parity.sirhao.top','port':443,'scheme':'https','method':'CONNECT','request_expires_at_ms':NOW*1000+60000,'status':'pending'},**kw)
class PolicyTests(unittest.TestCase):
 def test_exact_allowed_target(self):
  self.assertEqual(approvals.evaluate(record(),RULES,NOW*1000),(True,'exact_network_rule'))
 def test_host_confusions_are_held(self):
  for host in ['parity.sirhao.top.evil.test','evil@parity.sirhao.top','parity.sirhao.top/evil','parity.sirhao.top%00','127.0.0.1','*.sirhao.top',' parity.sirhao.top']:
   with self.subTest(host=host):self.assertFalse(approvals.evaluate(record(host=host),RULES,NOW*1000)[0])
 def test_expiry_port_method_and_scheme(self):
  for change in [{'request_expires_at_ms':NOW*1000},{'request_expires_at_ms':None},{'request_expires_at_ms':True},{'request_expires_at_ms':float('nan')},{'request_expires_at_ms':float('inf')},{'port':80},{'port':True},{'method':'POST'},{'scheme':'http'},{'status':'approved'}]:
   with self.subTest(change=change):self.assertFalse(approvals.evaluate(record(**change),RULES,NOW*1000)[0])
 def test_description_does_not_authorize_host(self):
  self.assertFalse(approvals.evaluate(record(host='evil.test',rich_explanation='Visit parity.sirhao.top'),RULES,NOW*1000)[0])
 def test_case_and_trailing_dot(self):
  self.assertTrue(approvals.evaluate(record(host='PARITY.SIRHAO.TOP.',port='443'),RULES,NOW*1000)[0])
 def test_real_muse_tcp_connect_shape_and_task_binding(self):
  rules=[{**RULES[0],'thread_ids':['task-session']}]
  r=record(scheme='tcp',runtime_request_trace={'thread_id':'task-session'})
  self.assertTrue(approvals.evaluate(r,rules,NOW*1000)[0])
  self.assertFalse(approvals.evaluate(record(scheme='tcp',method='POST'),rules,NOW*1000)[0])
  self.assertFalse(approvals.evaluate(record(scheme='tcp',runtime_request_trace={'thread_id':'other'}),rules,NOW*1000)[0])
 def test_policy_rejects_wildcard_and_write_methods(self):
  with tempfile.TemporaryDirectory()as folder:
   p=Path(folder)/'policy.json'
   for rule in [{**RULES[0],'host':'*.sirhao.top'},{**RULES[0],'methods':['POST']},{**RULES[0],'port':80}]:
    p.write_text(json.dumps({'version':1,'rules':[rule]}))
    with self.assertRaises(ValueError):approvals.policy_rules(p)
class AuditTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.path=Path(self.tmp.name)/'audit.sqlite3';self.audit=approvals.ApprovalAudit(self.path);self.addCleanup(self.audit.close)
  self.client=Mock();self.client.call_json.side_effect=[{'pending_approvals':[{'approval_id':'approval-1'}]},record(),{}]
 def test_dry_run_never_decides(self):
  r=approvals.process(self.client,RULES,self.audit,now=NOW)
  self.assertEqual(r[0]['action'],'would_allow_once');self.assertEqual(self.client.call_json.call_count,2)
  self.assertEqual(self.audit.db.execute('SELECT COUNT(*)FROM decisions').fetchone()[0],0)
 def test_apply_persists_unknown_before_rpc(self):
  def call(method,**kw):
   if method=='egress.approvals':return {'pending':[record()]}
   if method=='egress.approval':return record()
   self.assertEqual(method,'egress.approval.decide');self.assertEqual(kw['body'],{'decision':'allow_once'})
   self.assertEqual(self.audit.db.execute('SELECT state FROM decisions').fetchone()[0],'decision_unknown');return {}
  self.client.call_json.side_effect=call
  self.assertEqual(approvals.process(self.client,RULES,self.audit,True,NOW)[0]['action'],'rpc_accepted')
  self.assertEqual(approvals.process(self.client,RULES,self.audit,True,NOW)[0]['reason'],'already_attempted_or_unknown')
 def test_timeout_is_never_replayed_even_after_restart(self):
  def call(method,**kw):
   if method=='egress.approvals':return {'pending':[record()]}
   if method=='egress.approval':return record()
   raise TimeoutError('secret-url')
  self.client.call_json.side_effect=call
  r=approvals.process(self.client,RULES,self.audit,True,NOW)
  self.assertEqual(r[0]['action'],'decision_unknown');self.assertNotIn('secret-url',json.dumps(r))
  other=approvals.ApprovalAudit(self.path)
  try:self.assertEqual(approvals.process(self.client,RULES,other,True,NOW)[0]['reason'],'already_attempted_or_unknown')
  finally:other.close()
 def test_detail_identity_must_match(self):
  self.client.call_json.side_effect=[{'pending':[record()]},record(approval_id='other')]
  self.assertEqual(approvals.process(self.client,RULES,self.audit,True,NOW)[0]['reason'],'detail_identity_mismatch')
 def test_expired_approval_is_not_sent(self):
  self.client.call_json.side_effect=[{'pending':[record()]},record(request_expires_at_ms=NOW*1000)]
  self.assertEqual(approvals.process(self.client,RULES,self.audit,True,NOW)[0]['action'],'held')
  self.assertEqual(self.client.call_json.call_count,2)
