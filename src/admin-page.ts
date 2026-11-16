import { MAX_COOKIE_LENGTH } from "./admin-input";
import { adminScript } from "./admin-script";
import { adminStyles } from "./admin-styles";

const paths = {
  relay: '<path fill="currentColor" stroke="none" d="M1 9 16 1v9L1 18zm9 6 15-8v9l-15 8z"/>',
  key: '<circle cx="8" cy="9" r="4"/><path d="m11 12 9 9m-3-3 3-3m-6 0 3-3"/>',
  cloud: '<path d="M7 18a4 4 0 1 1 .4-8A6 6 0 0 1 19 11.5a3.3 3.3 0 0 1-.5 6.5Z"/>',
  check: '<path d="m6 12 4 4 8-8"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  refresh: '<path d="M20 10a8 8 0 1 0-2 8m2-13v5h-5"/>',
  play: '<circle cx="12" cy="12" r="10"/><path fill="currentColor" stroke="none" d="m10 7 7 5-7 5V7Z"/>',
  wechat: '<path d="M13 16a9 9 0 0 1-5 .4L4 19l.5-3.8a6.5 6.5 0 0 1-2-4.6C2.5 6.9 5.7 4 10 4s7.5 2.9 7.5 6.6"/><path d="M22 15.2c0-2.8-2.6-4.9-5.8-4.9s-5.8 2.1-5.8 4.9 2.6 5 5.8 5a7 7 0 0 0 2.1-.3l2.6 1.7-.4-3a4.2 4.2 0 0 0 1.5-3.4Z"/><path stroke-width="2.5" d="M7 9h.1m5.6 0h.1m1 5.4h.1m4 0h.1"/>',
  wecom: '<path d="M14 18a10 10 0 0 1-5.2.5L4 21l.8-4a7.6 7.6 0 0 1-2.3-5.3c0-4.1 3.6-7.4 8-7.4 4.5 0 8.1 3.3 8.1 7.4"/><circle cx="17.5" cy="16" r="2"/><circle cx="21" cy="19.5" r="1.6"/><circle cx="14.3" cy="21" r="1.6"/><path d="m16.7 17.9-1.6 1.8m3.7-2.4 1.1 1"/>',
};

function icon(name: keyof typeof paths) {
  return `<svg class="icon" viewBox="0 0 26 26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

export function adminPage(local = false): Response {
  const nonce = crypto.randomUUID();
  return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cookie 管理 · Muse Relay</title>
<style nonce="${nonce}">${adminStyles}</style>
</head>
<body>
<div class="shell">
  <aside class="sidebar" aria-label="控制台导航">
    <div class="brand">${icon("relay")}<span>Muse Relay</span></div>
    <div class="sidebar-label">运行控制台</div>
    <nav><a href="/admin" aria-current="page">${icon("key")}<span>Cookie 管理</span></a></nav>
    <div class="sidebar-footer">${icon("cloud")}<span>Cloudflare Worker</span></div>
  </aside>

  <main class="main">
    <div class="topbar">
      <div class="breadcrumb"><span>控制台</span><span aria-hidden="true">/</span><strong>Cookie 管理</strong></div>
      <span class="environment"><span aria-hidden="true"></span>${local ? "本地预览" : "生产环境"}</span>
    </div>
    <header class="heading">
      <h1>Cookie 管理</h1>
      <p>管理 Muse 凭证与自动续期</p>
    </header>

    <section class="metrics" aria-label="凭证与续期概览">
      <article class="panel metric">
        <div class="metric-label">Cookie 状态</div>
        <div class="metric-value"><span id="cookie-icon" class="health-icon" hidden>${icon("check")}</span><span id="cookie-state">待查询</span></div>
        <div class="metric-note" id="cookie-note">输入管理密钥后查看</div>
      </article>
      <article class="panel metric">
        <div class="metric-label">每日续期</div>
        <div class="metric-value metric-time">04:54</div>
        <div class="metric-note">北京时间</div>
      </article>
      <article class="panel metric">
        <div class="metric-label">最近续期</div>
        <div class="metric-value metric-time" id="renewal-time">—</div>
        <div class="metric-note" id="renewal-note">输入管理密钥后查看</div>
      </article>
    </section>

    <div class="content-grid">
      <section class="panel editor" aria-labelledby="edit-title">
        <div class="panel-heading">
          <h2 id="edit-title">手动更换 Cookie</h2>
          <p>验证通过后才会替换当前 Cookie。</p>
        </div>
        <form id="editor" method="post" autocomplete="off">
          <label for="key">管理密钥</label>
          <input id="key" type="password" placeholder="输入管理密钥" maxlength="512" autocomplete="off" spellcheck="false" required>
          <label for="cookie">新 Cookie</label>
          <textarea id="cookie" placeholder="粘贴 Cookie 请求头…" maxlength="${MAX_COOKIE_LENGTH + 8}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="hint" required></textarea>
          <small id="hint">格式：<code>名称=值; 名称2=值2</code>。已保存的 Cookie 不会显示。</small>
          <div class="actions">
            <button class="primary" type="submit">验证并保存</button>
            <button class="secondary" id="clear" type="button">清空</button>
            <button class="quiet" id="check" type="button">${icon("refresh")}查看状态</button>
          </div>
          <output id="feedback" role="status" aria-live="polite"></output>
          <noscript>请开启 JavaScript 后使用管理页。</noscript>
        </form>
      </section>

      <aside class="side-panels" aria-label="渠道与审批">
        <section class="panel overview" aria-labelledby="channels-title">
          <div class="panel-heading">
            <h2 id="channels-title">渠道连接</h2>
            <span class="relay-mark">${icon("relay")}</span>
          </div>
          <ul class="channels">
            <li>${icon("wechat")}<div><strong>微信</strong><span class="channel-detail" id="weixin-detail">Worker 中转</span></div><span class="tag" id="weixin-state">查询中</span></li>
            <li>${icon("wecom")}<div><strong>企业微信</strong><span class="channel-detail" id="wecom-detail">Worker 中转</span></div><span class="tag" id="wecom-state">查询中</span></li>
          </ul>
          <p class="muted">显示网关连接状态；实际收发以渠道回执为准。</p>
        </section>
        <section class="panel overview approvals" aria-labelledby="approvals-title">
          <div class="panel-heading"><h2 id="approvals-title">Worker 自动审批</h2></div>
          <div class="approval-state">${icon("play")}<strong id="approval-state">待查询</strong></div>
          <p class="muted" id="approval-note">仅自动处理符合规则的请求。</p>
        </section>
      </aside>
    </div>

    <footer class="footer"><span>${icon("lock")}凭证仅用于 Muse 验证与连接</span><span>所有时间均为北京时间</span></footer>
  </main>
</div>
<script nonce="${nonce}">${adminScript}</script>
</body>
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
