import { MAX_COOKIE_LENGTH } from "./admin-input";

export function adminPage(): Response {
  const nonce = crypto.randomUUID();
  return new Response(`<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muse Worker · Cookie 管理</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; font: 16px/1.6 system-ui,sans-serif; }
  body { margin: 0; padding: 2.5rem 1rem; }
  main { max-width: 40rem; margin: auto; }
  h1 { font-size: 1.65rem; margin: .25rem 0; }
  p { margin: .5rem 0 1.25rem; }
  form { border: 1px solid GrayText; border-radius: 12px; padding: 1.25rem; }
  label { display: block; font-weight: 600; margin-top: 1rem; }
  label:first-child { margin-top: 0; }
  input, textarea { box-sizing: border-box; width: 100%; padding: .65rem; margin: .25rem 0; border: 1px solid GrayText; border-radius: 6px; font: inherit; }
  textarea { min-height: 9rem; resize: vertical; font-family: monospace; }
  small { display: block; }
  .actions { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: 1rem; }
  button { font: inherit; font-weight: 600; padding: .45rem .85rem; border-radius: 6px; border: 1px solid GrayText; cursor: pointer; }
  button[type=submit] { color: white; background: #224fc0; border-color: #224fc0; }
  button:disabled { opacity: .55; cursor: wait; }
  #status { display: block; margin-top: 1rem; white-space: pre-line; overflow-wrap: anywhere; }
</style>
<main>
  <h1>Muse Cookie 管理</h1>
  <p>粘贴新的 Muse 请求 Cookie。Worker 会先验证 Muse 连接，成功后才保存；微信和企微之后的新连接会使用它。</p>
  <form id="editor" method="post" autocomplete="off">
    <label for="key">管理密钥</label>
    <input id="key" type="password" maxlength="512" autocomplete="off" spellcheck="false" required>
    <label for="cookie">新 Cookie</label>
    <textarea id="cookie" maxlength="${MAX_COOKIE_LENGTH + 8}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="hint" required></textarea>
    <small id="hint">格式：name=value; name2=value2。这里不会显示已保存的 Cookie。</small>
    <div class="actions">
      <button type="submit">验证并保存</button>
      <button id="check" type="button">查看当前状态</button>
      <button id="clear" type="button">清空输入</button>
    </div>
    <output id="status" role="status" aria-live="polite"></output>
    <noscript>请开启 JavaScript 后使用管理页。</noscript>
  </form>
</main>
<script nonce="${nonce}">
  const form = document.getElementById("editor");
  const key = document.getElementById("key");
  const cookie = document.getElementById("cookie");
  const status = document.getElementById("status");
  const buttons = form.querySelectorAll("button");
  const localTime = (time) => typeof time === "number"
    ? new Date(time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "暂无";
  async function run(save) {
    if (!key.value.trim()) { key.reportValidity(); return; }
    buttons.forEach((button) => button.disabled = true);
    status.textContent = save ? "正在验证 Muse 连接，请稍候…" : "正在查询…";
    try {
      const headers = { Authorization: "Bearer " + key.value.trim() };
      const options = { method: save ? "POST" : "GET", headers, cache: "no-store", credentials: "omit", redirect: "error" };
      if (save) {
        headers["Content-Type"] = "application/json";
        options.body = JSON.stringify({ cookie: cookie.value.trim() });
      }
      const response = await fetch("/admin/cookie", options);
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401) status.textContent = "管理密钥不正确。";
        else if (response.status === 400 || response.status === 413) status.textContent = "Cookie 格式不正确或太长。请粘贴一行完整的 Cookie 请求头。";
        else if (result.error === "cookie_not_saved") {
          const code = result.last_error?.upstream_status;
          status.textContent = code === 401 ? "Muse 拒绝了新 Cookie，旧配置没有被替换。" : "新 Cookie 未通过连接验证或未能保存，旧配置没有被替换。";
        } else status.textContent = "暂时无法处理请求，请稍后再试。";
        return;
      }
      if (save) cookie.value = "";
      const current = !result.configured ? "尚未配置" : result.needs_login ? "需要重新登录" : result.ok ? "正常" : "尚未验证或最近检查失败";
      status.textContent = [
        save ? "新 Cookie 已验证并保存。" : "当前状态：" + current,
        "最近验证（北京时间）：" + localTime(result.last_verified_at),
        "最近手动更换（北京时间）：" + localTime(result.last_imported_at),
      ].join("\\n");
    } catch {
      status.textContent = save ? "未收到保存结果。请先查看当前状态，再决定是否重试。" : "查询失败，请稍后再试。";
    } finally { buttons.forEach((button) => button.disabled = false); }
  }
  form.addEventListener("submit", (event) => { event.preventDefault(); void run(true); });
  document.getElementById("check").addEventListener("click", () => void run(false));
  document.getElementById("clear").addEventListener("click", () => { form.reset(); status.textContent = ""; });
  addEventListener("pagehide", () => { form.reset(); status.textContent = ""; });
</script>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    },
  });
}
