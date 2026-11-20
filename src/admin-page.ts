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

export function icon(name: keyof typeof paths) {
  return `<svg class="icon" viewBox="0 0 26 26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

export function adminPage(local = false, signedIn = false): Response {
  const nonce = crypto.randomUUID();
  return htmlResponse(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cookie 账号池 · Muse Relay</title>
<style nonce="${nonce}">${adminStyles}</style>
</head>
<body data-authenticated="${signedIn}">
<div class="shell">
  <aside class="sidebar" aria-label="控制台导航">
    <div class="brand">${icon("relay")}<span>Muse Relay</span></div>
    <div class="sidebar-label">运行控制台</div>
    <nav>
      <a href="/admin" aria-current="page">${icon("key")}<span>Cookie 管理</span></a>
      <a href="/admin/managed">${icon("wechat")}<span>渠道托管</span></a>
    </nav>
    <div class="sidebar-footer">${icon("cloud")}<span>Cloudflare Worker</span></div>
  </aside>

  <main class="main">
    <div class="topbar">
      <div class="breadcrumb"><span>控制台</span><span aria-hidden="true">/</span><strong>Cookie 账号池</strong></div>
      <div class="account-actions">${signedIn ? '<a class="login-link" href="/admin/managed">渠道托管</a>' : ""}<span class="environment"><span aria-hidden="true"></span>${local ? "本地预览" : "生产环境"}</span>
      ${signedIn ? '<form action="/admin/logout" method="post"><button class="quiet" type="submit">退出登录</button></form>' : '<a class="login-link" href="/admin/login">登录管理</a>'}</div>
    </div>

    <header class="heading heading-bar">
      <div>
        <h1>Cookie 账号池</h1>
        <p>支持同时开启多个 Muse 账号加入调度池，自动负载均衡、故障冷却切换与每日保活续期</p>
      </div>
      <div class="heading-actions">
        <button class="secondary" id="open-batch-import" type="button" ${signedIn ? "" : "disabled"}>批量导入</button>
        <button class="primary" id="open-add-account" type="button" ${signedIn ? "" : "disabled"}>＋ 新增账号</button>
      </div>
    </header>

    <section class="metrics" aria-label="凭证与续期概览">
      <article class="panel metric">
        <div class="metric-top">
          <div class="metric-label">账号池状态</div>
          <span class="tag" id="selected-account-badge">主账号 (primary-account)</span>
        </div>
        <div class="metric-value"><span id="cookie-icon" class="health-icon" hidden>${icon("check")}</span><span id="cookie-state">查询中</span></div>
        <div class="metric-note" id="cookie-note">最近一次验证结果</div>
      </article>
      <article class="panel metric">
        <div class="metric-top">
          <div class="metric-label">每日自动续期</div>
          <span class="tag">北京时间 04:54</span>
        </div>
        <div class="metric-value metric-time" id="renewal-time">—</div>
        <div class="metric-note" id="renewal-note">登录后查看最近续期记录</div>
      </article>
      <article class="panel metric">
        <div class="metric-top">
          <div class="metric-label">Worker 自动审批</div>
          <button class="secondary btn-sm" id="poll-approvals" type="button" ${signedIn ? "" : "disabled"}>立即轮询</button>
        </div>
        <div class="metric-value approval-metric-val">${icon("play")}<span id="approval-state">待查询</span></div>
        <div class="metric-note" id="approval-note">仅自动处理符合白名单规则的请求</div>
        <div class="chip-row" id="approval-stats" hidden></div>
      </article>
    </section>

    <section class="panel overview section-block" id="accounts-panel" aria-labelledby="accounts-title">
      <div class="pool-toolbar">
        <div class="pool-title-group">
          <div class="heading-with-badge">
            <h2 id="accounts-title">Muse 账号池（多开调度）</h2>
            <div class="pool-stats-pills" id="pool-stats-pills" ${signedIn ? "" : "hidden"}>
              <span class="tag" id="pool-stat-enabled">已开启 —</span>
              <span class="tag" id="pool-stat-healthy">健康可用 —</span>
              <span class="tag" id="pool-stat-alert" hidden></span>
            </div>
          </div>
          <p class="muted">打开任意多个账号开关即可同时启用并加入调度池；遇连接异常或冷却会自动故障切换到下一个已开启账号。</p>
        </div>

        <div class="pool-controls" ${signedIn ? "" : "hidden"}>
          <label class="strategy-picker" title="参考 muse2api 多账号调度策略">
            <span>调度策略</span>
            <select id="pool-strategy">
              <option value="failover">首选优先 + 故障切换</option>
              <option value="round_robin">轮询均衡 (Round Robin)</option>
              <option value="lru">最少使用优先 (LRU)</option>
            </select>
          </label>
          <button class="secondary btn-sm" id="renew-all-btn" type="button">全部续期</button>
          <button class="secondary btn-sm" id="check" type="button">${icon("refresh")}刷新</button>
        </div>
      </div>

      ${signedIn ? "" : '<p class="login-prompt">登录后可以开启多个账号、调整调度策略、弹窗更换 Cookie 与测活。<a href="/admin/login">前往登录 →</a></p>'}
      <div class="table-wrap" ${signedIn ? "" : "hidden"}>
        <table class="data-table">
          <thead>
            <tr>
              <th class="col-toggle">启用</th>
              <th>账号名称 / VM</th>
              <th>健康状态</th>
              <th>调用统计 / 最近验证</th>
              <th class="col-actions">操作</th>
            </tr>
          </thead>
          <tbody id="accounts-table-body"><tr><td colspan="5" class="muted">正在加载账号池…</td></tr></tbody>
        </table>
      </div>
      <output id="feedback" role="status" aria-live="polite"></output>
      <output id="account-feedback" class="status-banner" role="status" hidden></output>
      <noscript>请开启 JavaScript 后使用管理页。</noscript>
    </section>

    <section class="panel overview section-block" aria-labelledby="channels-title">
      <div class="panel-heading">
        <div>
          <h2 id="channels-title">渠道网关连接状态</h2>
          <p class="muted">实时展示关联渠道的网关连接健康度；实际消息收发以渠道回执为准。</p>
        </div>
        ${signedIn ? '<a class="secondary btn-sm link-btn" href="/admin/managed">进入渠道托管控制台 →</a>' : `<span class="relay-mark">${icon("relay")}</span>`}
      </div>
      <ul class="channels channels-grid">
        <li>${icon("wechat")}<div><strong>微信网关</strong><span class="channel-detail" id="weixin-detail">Worker 中转</span></div><span class="tag" id="weixin-state">查询中</span></li>
        <li>${icon("wecom")}<div><strong>企业微信网关</strong><span class="channel-detail" id="wecom-detail">Worker 中转</span></div><span class="tag" id="wecom-state">查询中</span></li>
      </ul>
    </section>

    <div class="modal-backdrop" id="cookie-modal" role="dialog" aria-modal="true" aria-labelledby="edit-title" hidden>
      <div class="modal-dialog panel">
        <div class="modal-header">
          <div class="heading-with-badge">
            <h2 id="edit-title">更换账号 Cookie</h2>
            <span class="tag" id="modal-account-badge">主账号 (primary-account)</span>
          </div>
          <button class="quiet btn-sm modal-close" id="close-cookie-modal" type="button" aria-label="关闭弹窗">✕ 关闭</button>
        </div>
        <form id="editor" method="post" autocomplete="off">
          <fieldset ${signedIn ? "" : "disabled"}>
            <div id="modal-new-account-fields" class="modal-account-fields" hidden>
              <div class="inline-fields">
                <label>账号备注名称<input id="new-account-label" name="label" maxlength="40" placeholder="例如：备用二号 / 工作号"></label>
                <label>账号标识 ID（可选）<input id="new-account-id" name="id" maxlength="31" placeholder="留空自动生成，或填字母数字如 muse-2"></label>
              </div>
              <div class="modal-toggles-row">
                <label class="toggle"><input id="new-account-enabled" name="enabled" type="checkbox" checked>验证通过后立即开启（加入多开调度池）</label>
                <label class="toggle"><input id="new-account-default" name="set_default" type="checkbox">设为首选兜底账号</label>
              </div>
            </div>

            <div class="current-cookie" id="modal-current-cookie-wrap">
              <div class="current-cookie-bar">
                <label for="current-cookie">当前已存 Cookie</label>
                <button class="quiet btn-sm" id="reveal-cookie" type="button" aria-controls="current-cookie" aria-expanded="false">显示已存 Cookie</button>
                <button class="quiet btn-sm" id="copy-cookie" type="button" hidden>复制</button>
              </div>
              <textarea id="current-cookie" readonly hidden autocomplete="off" spellcheck="false"></textarea>
            </div>

            <div class="modal-split-grid">
              <div class="modal-input-pane">
                <div class="cookie-label-bar">
                  <label for="cookie" id="cookie-input-label">粘贴扩展 JSON 或 Cookie</label>
                  <div class="cookie-quick-tools">
                    <button class="secondary btn-sm" type="button" data-cookie-paste="main">📋 粘贴剪贴板</button>
                    <button class="secondary btn-sm" type="button" data-cookie-file-btn="main">📂 导入 JSON</button>
                    <input type="file" accept=".json,application/json,.txt" data-cookie-file="main" hidden>
                    <button class="quiet btn-sm" id="clear" type="button">清空</button>
                  </div>
                </div>
                <textarea id="cookie" placeholder="在此粘贴浏览器扩展复制的 cookies.json / muse-credentials.json，或单行 Cookie 请求头…" maxlength="${MAX_COOKIE_LENGTH * 10}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="hint"></textarea>
                <small id="hint">支持直接粘贴扩展复制的 JSON 或 <code>名称=值; 名称2=值2</code>，右侧实时同步预览</small>
              </div>

              <div class="modal-preview-pane">
                <div class="cookie-label-bar">
                  <label>实时解析预览</label>
                  <span class="tag" id="preview-status-badge">等待输入</span>
                </div>
                <div class="cookie-preview-card" id="main-cookie-preview">
                  <div class="cookie-preview-empty">
                    <strong>等待粘贴或导入 JSON 凭证</strong>
                    <p>在左侧粘贴浏览器扩展导出的 <code>cookies.json</code> / <code>muse-credentials.json</code> 或 Cookie 请求头，此处将实时展示识别状态、<code>HttpOnly</code> 统计、虚拟机 ID 与脱敏键值胶囊。</p>
                  </div>
                </div>
              </div>
            </div>

            <output id="modal-feedback" class="status-banner" role="status" aria-live="polite" hidden></output>

            <div class="modal-footer">
              <button class="secondary" id="cancel-cookie-modal" type="button">取消</button>
              <button class="primary" id="modal-submit-btn" type="submit">验证并保存</button>
            </div>
          </fieldset>
        </form>
      </div>
    </div>

    <footer class="footer"><span>${icon("lock")}凭证仅用于 Muse 验证与连接</span><span>所有时间均为北京时间</span></footer>
  </main>
</div>
<script nonce="${nonce}">${adminScript}</script>
</body>
</html>`, nonce);
}

export function adminLoginPage(error = "", status = 200): Response {
  const nonce = crypto.randomUUID();
  const errorText = error ? '<p class="login-error" role="alert">' + error + '</p>' : "";
  return htmlResponse(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录管理台 · Muse Relay</title>
<style nonce="${nonce}">${adminStyles}</style>
</head>
<body class="login-page">
<main class="login-card">
  <div class="brand">${icon("relay")}<span>Muse Relay</span></div>
  <h1>登录管理台</h1>
  <p>使用管理密钥登录。</p>
  <form action="/admin/login" method="post">
    <label for="password">管理密钥</label>
    <input id="password" name="password" type="password" maxlength="512" autocomplete="current-password" required autofocus>
    ${errorText}
    <button class="primary" type="submit">登录</button>
  </form>
  <a class="back-link" href="/admin">返回状态概览</a>
</main>
</body>
</html>`, nonce, status);
}

function htmlResponse(html: string, nonce: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    },
  });
}
