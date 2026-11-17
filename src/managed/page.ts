import { adminStyles } from "../admin-styles";

export function managedPage() {
  const nonce = crypto.randomUUID();
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>CF 渠道托管 · Muse Relay</title>
<style nonce="${nonce}">${adminStyles}
body {padding:24px} main {max-width:1000px;margin:auto} header {margin-bottom:24px}
.forms {display:grid;grid-template-columns:1fr 1fr;gap:20px} section {padding:24px}
h1 {font-size:36px} label {margin-top:14px} output,pre {display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}
label.toggle {display:flex;gap:8px;align-items:center} input[type=checkbox]{width:auto;margin:0}
@media(max-width:680px){.forms{grid-template-columns:1fr}}
</style></head><body><main><header><a href="/admin">返回 Cookie 管理</a>
<h1>CF 渠道托管</h1><p>首版支持文字、队列和基础命令。请使用专属测试账号，或确认原接收端已停止接收。</p></header>
<div class="forms">
${(["weixin", "wecom"] as const).map((channel) => `<section class="panel"><h2>${channel === "weixin" ? "微信" : "企业微信"}</h2>
<form data-channel="${channel}" autocomplete="off">
<label>机器人账号<input name="account" required maxlength="512"></label>
<label>${channel === "weixin" ? "iLink Bot Token" : "机器人 Secret"}<input name="secret" type="password" required maxlength="16384" autocomplete="new-password"></label>
<label>允许的发送者 ID<textarea name="senders" required placeholder="每行一个发送者 ID"></textarea></label>
<label class="toggle"><input name="enabled" type="checkbox">启用此渠道</label>
<button class="primary" type="submit">保存配置</button><output role="status"></output></form></section>`).join("")}
</div><section class="panel"><h2>运行状态</h2><button id="refresh" class="secondary">刷新</button><pre id="state"></pre></section>
</main><script nonce="${nonce}">
const state=document.getElementById('state');
async function refresh(){
 try{
  const r=await fetch('/admin/managed/status',{cache:'no-store',credentials:'same-origin'});
  if(r.status===401){location.assign('/admin/login');return}
  const d=await r.json();
  const labels={weixin:'微信',wecom:'企微'};
  state.textContent=Object.entries(d.channels??{}).map(([k,v])=>labels[k]+' · '+(!v.configured?'未配置':!v.enabled?'未启用':v.connected?'网关连接正常':v.error?'连接失败':'等待连接')
    +(v.last_ok?' · 最近回包 '+new Date(v.last_ok).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'')).join('\\n')
    +'\\n任务 '+JSON.stringify(d.tasks??[])+'\\n投递 '+JSON.stringify(d.outbound??[]);
 }catch{state.textContent='状态读取失败，请稍后重试。'}
}
for(const form of document.querySelectorAll('form')){
 form.addEventListener('submit',async e=>{
  e.preventDefault();const button=form.querySelector('button');const output=form.querySelector('output');button.disabled=true;
  try{
   const body={account:form.elements.account.value.trim(),secret:form.elements.secret.value,
    allowedSenders:form.elements.senders.value.split(/\\s+/).filter(Boolean),enabled:form.elements.enabled.checked};
   const r=await fetch('/admin/managed/'+form.dataset.channel,{method:'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   if(r.status===401){location.assign('/admin/login');return}
   output.textContent=r.ok?'配置已保存。':r.status===409?'存在待处理任务，或当前实例尚未开放接收。':'配置保存失败，请检查输入。';
   if(r.ok){form.elements.secret.value='';await refresh()}
  }catch{output.textContent='未收到保存结果，请先刷新状态再决定是否重试。'}
  finally{button.disabled=false}
 });
}
document.getElementById('refresh').addEventListener('click',()=>void refresh());
void refresh();setInterval(()=>{if(!document.hidden)void refresh()},30000);
</script></body></html>`, { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`,
  } });
}
