import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
it('records a real scheduled invocation separately from manual Cookie checks', async () => {
 const stub=env.CREDENTIALS.getByName('scheduled-event-audit-test');
 await runInDurableObject(stub,async(instance)=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({access_token:'test-token'})));
  try {
   await instance.scheduledRenewal(123456789,'54 20 * * *');
   const response=await instance.fetch(new Request('https://fixture.test/renewal/scheduled-status'));
   const state=await response.json<{last_event:{source:string;scheduled_time:number;cron:string;result:{ok:boolean}}}>();
   expect(state.last_event.source).toBe('cloudflare_scheduled');expect(state.last_event.scheduled_time).toBe(123456789);
   expect(state.last_event.result.ok).toBe(true);expect(state.last_event.cron).toBe('54 20 * * *');
  }finally{vi.unstubAllGlobals();}
 });
});
it('does not approve or schedule approval work when automatic approval is disabled', async()=>{
 const stub=env.CREDENTIALS.getByName('disabled-approval-audit-test');
 await runInDurableObject(stub,async(instance,state)=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  try {
   const result=await instance.poll();expect(result).toMatchObject({enabled:false});
   await instance.alarm();expect(fetcher).not.toHaveBeenCalled();expect(await state.storage.getAlarm()).toBeNull();
  }finally{vi.unstubAllGlobals();}
 });
});
