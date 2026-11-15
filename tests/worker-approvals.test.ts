import { expect, it, vi } from 'vitest';
import { parsePolicy, approvalMatch, pollApprovals } from '../src/approval-policy';
const rules = parsePolicy(JSON.stringify({ rules: [{ host: 'parity.sirhao.top', port: 443, scheme: 'https', methods: ['CONNECT'], thread_ids: ['authorized-task'] }] }));
function record(extra: Record<string, unknown> = {}) {
 return { approval_id: 'request-1', host: 'parity.sirhao.top', port: 443, method: 'CONNECT', scheme: 'tcp', status: 'pending', request_expires_at_ms: Date.now()+60000, runtime_request_trace: {thread_id:'authorized-task'}, ...extra };
}
it('matches actual Muse TLS preconnect shape only within authorized host and task', () => {
 expect(approvalMatch(record(), rules)).toBe(true);
 for (const extra of [{host:'parity.sirhao.top.evil.test'},{host:'evil@parity.sirhao.top'},{port:80},{method:'POST'},{request_expires_at_ms:0},{request_expires_at_ms:Infinity},{runtime_request_trace:{thread_id:'other'}}]) {
  expect(approvalMatch(record(extra),rules)).toBe(false);
 }
 expect(()=>parsePolicy('{"rules":[{"host":"*.sirhao.top"}]}')).toThrow();
});
it('allows secure WebSocket approval for the exact relay host while holding plaintext and other hosts', () => {
 const relayRules=parsePolicy(JSON.stringify({rules:[{host:'muse-demo.sirhao.top',port:443,scheme:'https',methods:['GET','CONNECT']}]}));
 expect(approvalMatch(record({host:'muse-demo.sirhao.top',scheme:'wss',method:'GET'}),relayRules)).toBe(true);
 for(const extra of [{scheme:'ws'},{port:80},{host:'other.sirhao.top'},{method:'POST'}]) {
  expect(approvalMatch(record({host:'muse-demo.sirhao.top',scheme:'wss',method:'GET',...extra}),relayRules)).toBe(false);
 }
});
it('allows POST only when the exact host policy explicitly authorizes it', () => {
 const relayRules=parsePolicy(JSON.stringify({rules:[{host:'muse-demo.sirhao.top',port:443,scheme:'https',methods:['POST']}]}));
 expect(approvalMatch(record({host:'muse-demo.sirhao.top',scheme:'https',method:'POST'}),relayRules)).toBe(true);
 expect(approvalMatch(record({scheme:'https',method:'POST'}),relayRules)).toBe(false);
 expect(approvalMatch(record({host:'muse-demo.sirhao.top',scheme:'https',method:'DELETE'}),relayRules)).toBe(false);
});
it('persists unknown before sending a Worker-owned approval and never replays it', async () => {
 const states=new Map<string,string>();
 const call=vi.fn(async (path:string,_service?:number,method?:string,body?:unknown) => {
  if(path==='/approvals')return {pending_approvals:[{approval_id:'request-1'}]};
  if(path.endsWith('/decide')) {
   expect(method).toBe('POST'); expect(body).toEqual({decision:'allow_once'});
   expect(states.get('request-1')).toBe('decision_unknown');throw new Error('network ambiguity');
  }
  return {approval:record()};
 });
 const audit={claim:(id:string)=>{if(states.has(id))return false;states.set(id,'decision_unknown');return true;},accepted:(id:string)=>states.set(id,'accepted')};
 expect((await pollApprovals({call},rules,audit)).unknown).toBe(1);
 expect((await pollApprovals({call},rules,audit)).held).toBe(1);
 expect(call.mock.calls.filter(([p])=>p.endsWith('/decide'))).toHaveLength(1);
});
it('requires fresh detail identity and expiry before deciding', async () => {
 const claim=vi.fn();
 const call=vi.fn(async(path:string)=>path==='/approvals'?{pending:[{approval_id:'request-1'}]}:{approval:record({approval_id:'other'})});
 expect((await pollApprovals({call},rules,{claim,accepted:vi.fn()})).held).toBe(1);expect(claim).not.toHaveBeenCalled();
});
