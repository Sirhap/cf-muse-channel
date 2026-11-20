import { icon } from "../admin-page";
import { adminStyles } from "../admin-styles";

export function managedPage(local = false) {
  const nonce = crypto.randomUUID();
  return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CF 渠道托管 · Muse Relay</title>
<style nonce="${nonce}">${adminStyles}</style>
</head>
<body data-authenticated="true">
<div class="shell">
  <aside class="sidebar" aria-label="控制台导航">
    <div class="brand">${icon("relay")}<span>Muse Relay</span></div>
    <div class="sidebar-label">运行控制台</div>
    <nav>
      <a href="/admin">${icon("key")}<span>Cookie 管理</span></a>
      <a href="/admin/managed" aria-current="page">${icon("wechat")}<span>渠道托管</span></a>
    </nav>
    <div class="sidebar-footer">${icon("cloud")}<span>Cloudflare Worker</span></div>
  </aside>

  <main class="main">
    <div class="topbar">
      <div class="breadcrumb"><span>控制台</span><span aria-hidden="true">/</span><strong>渠道托管</strong></div>
      <div class="account-actions">
        <a class="login-link" href="/admin">Cookie 管理</a>
        <span class="environment"><span aria-hidden="true"></span>${local ? "本地预览" : "生产环境"}</span>
        <form action="/admin/logout" method="post"><button class="quiet" type="submit">退出登录</button></form>
      </div>
    </div>

    <header class="heading">
      <h1>CF 渠道托管</h1>
      <p>微信 / 企业微信双向文字与 6MB 媒体原生托管、Outbox 定时推送与网关诊断</p>
    </header>

    <section class="metrics metrics-4" aria-label="托管渠道核心指标">
      <article class="panel metric">
        <div class="metric-label">微信网关</div>
        <div class="metric-value"><span id="wx-metric-state">查询中</span></div>
        <div class="metric-note" id="wx-metric-note">等待读取状态</div>
      </article>
      <article class="panel metric">
        <div class="metric-label">企业微信网关</div>
        <div class="metric-value"><span id="wc-metric-state">查询中</span></div>
        <div class="metric-note" id="wc-metric-note">等待读取状态</div>
      </article>
      <article class="panel metric">
        <div class="metric-label">原生会话 / 队列</div>
        <div class="metric-value metric-time" id="session-metric">—</div>
        <div class="metric-note" id="queue-metric-note">等待读取队列</div>
      </article>
      <article class="panel metric">
        <div class="metric-label">Outbox 增量偏移</div>
        <div class="metric-value metric-time" id="outbox-metric">—</div>
        <div class="metric-note" id="runtime-metric-note">text+media</div>
      </article>
    </section>

    <section class="panel overview section-block" aria-labelledby="ops-title">
      <div class="panel-heading">
        <div>
          <h2 id="ops-title">运行调度与网关诊断</h2>
          <p class="muted" id="alarm-summary">正在读取调度器与连接状态…</p>
        </div>
        <div class="actions">
          <button id="refresh" class="secondary" type="button">${icon("refresh")}刷新状态</button>
          <button id="wake-btn" class="secondary" type="button">立即同步会话 &amp; Outbox</button>
          <button id="conn-btn" class="secondary" type="button">网关连通性探测</button>
        </div>
      </div>
      <div class="chip-row" id="summary-chips"></div>
      <output id="ops-feedback" class="status-banner" role="status" hidden></output>
    </section>

    <div class="grid-2">
      ${(["weixin", "wecom"] as const).map((channel) => `<section class="panel editor" aria-labelledby="title-${channel}">
        <div class="panel-heading">
          <h2 id="title-${channel}">${channel === "weixin" ? icon("wechat") + " 微信渠道" : icon("wecom") + " 企业微信渠道"}</h2>
          <div class="account-actions">
            <span class="tag" id="badge-${channel}">查询中</span>
            <button class="secondary btn-sm" type="button" data-toggle="${channel}" id="toggle-${channel}" hidden>暂停</button>
          </div>
        </div>
        <p class="muted" id="meta-${channel}">正在读取渠道状态…</p>
        <details class="config-details" id="details-${channel}">
          <summary id="summary-${channel}">展开修改凭证与发送者白名单</summary>
          <form data-channel="${channel}" autocomplete="off">
            <label>${channel === "weixin" ? "机器人账号（可选，默认 weixin-bot）" : "机器人账号"}<input name="account" ${channel === "weixin" ? "" : "required"} maxlength="512" placeholder="${channel === "weixin" ? "留空默认 weixin-bot（或填 ilink_bot_id）" : "企业微信 aibot_id"}"></label>
            <label>${channel === "weixin" ? "iLink Bot Token" : "机器人 Secret"}
              <div class="secret-field">
                <input name="secret" type="password" required maxlength="16384" autocomplete="new-password" placeholder="首次配置需填写；已配置时默认加密展示">
                <button class="secret-eye-btn" type="button" data-secret-eye="${channel}" aria-label="显示或隐藏密钥" aria-pressed="false" title="显示密钥">
                  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
            </label>
            <label>允许的发送者 ID<textarea name="senders" required placeholder="每行一个发送者 ID（保存后默认回显）"></textarea></label>
            <label class="toggle"><input name="enabled" type="checkbox" checked>保存后立即启用此渠道</label>
            <div class="actions">
              <button class="primary" type="submit">保存配置</button>
            </div>
            <output role="status" class="status-banner" hidden></output>
          </form>
        </details>
      </section>`).join("")}
    </div>

    <section class="panel editor section-block" aria-labelledby="push-title">
      <div class="panel-heading">
        <h2 id="push-title">主动消息推送 / 渠道测试台</h2>
        <p>向已认证的白名单会话主动推送通知或测试沙盒媒体回发（支持微信优先、无令牌自动企微兜底）。</p>
      </div>
      <form id="push-form" autocomplete="off">
        <div class="inline-fields">
          <label>推送渠道策略
            <select name="channel">
              <option value="auto">自动优选（微信优先 · 企微自动兜底）</option>
              <option value="weixin">仅微信（需已有近期对话 context_token）</option>
              <option value="wecom">仅企业微信（支持随时主动推送）</option>
            </select>
          </label>
          <label>指定目标会话 ID（可选）
            <input name="chat" maxlength="512" placeholder="留空则自动选择最近活跃会话或白名单首位">
          </label>
        </div>
        <label>消息内容（支持独占一行的 <code>[[FILE:workspace/...]]</code> 沙盒文件指令）
          <textarea name="text" required maxlength="16000" placeholder="输入要主动发送到手机微信/企业微信的消息正文…"></textarea>
        </label>
        <div class="actions">
          <button class="primary" type="submit">立即发送推送</button>
          <button class="secondary" id="push-clear" type="button">清空内容</button>
        </div>
        <output id="push-feedback" class="status-banner" role="status" hidden></output>
      </form>
    </section>

    <div class="grid-2">
      <section class="panel overview" aria-labelledby="recent-tasks-title">
        <div class="panel-heading">
          <h2 id="recent-tasks-title">最近入站任务（Top 10）</h2>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>#ID</th><th>渠道</th><th>状态</th><th>消息 ID</th><th>时间</th></tr></thead>
            <tbody id="recent-tasks-body"><tr><td colspan="5" class="muted">加载中…</td></tr></tbody>
          </table>
        </div>
      </section>

      <section class="panel overview" aria-labelledby="recent-deliveries-title">
        <div class="panel-heading">
          <h2 id="recent-deliveries-title">最近回复投递（Top 10）</h2>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>#投递</th><th>关联任务</th><th>状态</th><th>详情 / 操作</th></tr></thead>
            <tbody id="recent-deliveries-body"><tr><td colspan="4" class="muted">加载中…</td></tr></tbody>
          </table>
        </div>
      </section>
    </div>

    <footer class="footer"><span>${icon("lock")}渠道密钥仅存储于 DO SQLite，从不向前端回显</span><span>所有时间均为北京时间</span></footer>
  </main>
</div>
<script nonce="${nonce}">
const byId = (id) => document.getElementById(id);
const labels = { weixin: "微信", wecom: "企业微信" };
const phases = {
  queued: "待转发", submitting: "发送中", submitted: "已交给 Muse", running: "处理中",
  succeeded: "已处理", unknown: "待核对", cancelled: "已停止", failed: "未完成",
  delivered: "已确认投递", pending: "待投递", sending: "投递中"
};
const fmtTime = (ms) => typeof ms === "number" && Number.isFinite(ms)
  ? new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—";
const fmtShortTime = (ms) => typeof ms === "number" && Number.isFinite(ms)
  ? new Date(ms).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—";
const fmtBytes = (b) => typeof b === "number" && b > 0
  ? (b >= 1048576 ? (b / 1048576).toFixed(2) + " MiB" : (b / 1024).toFixed(1) + " KiB") : "0 B";

let latestStatus = null;
const dirtyForms = { weixin: false, wecom: false };
const secretMaskTimers = { weixin: null, wecom: null };
const MASKED_SENTINEL = "••••••••••••••••";
const EYE_OPEN_SVG = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_CLOSED_SVG = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';

function showBanner(el, text, tone = "") {
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
  el.hidden = !text;
}

function setSecretMaskUI(ch, visible) {
  const form = document.querySelector('form[data-channel="' + ch + '"]');
  const eyeBtn = document.querySelector('[data-secret-eye="' + ch + '"]');
  const secretInput = form?.elements.secret;
  if (!secretInput || !eyeBtn) return;
  secretInput.type = visible ? "text" : "password";
  eyeBtn.innerHTML = visible ? EYE_CLOSED_SVG : EYE_OPEN_SVG;
  eyeBtn.setAttribute("aria-pressed", visible ? "true" : "false");
  eyeBtn.title = visible ? "隐藏密钥" : "显示密钥";
}

function applyChannelFormDefaults(ch, cfg, configured) {
  const form = document.querySelector('form[data-channel="' + ch + '"]');
  if (!form) return;
  const secretInput = form.elements.secret;
  if (secretInput) {
    secretInput.required = !configured;
    secretInput.placeholder = configured
      ? "已保存密钥（点右侧小眼查看，或直接改写）"
      : "首次配置需填入密钥";
    if (configured && !dirtyForms[ch] && secretInput.type === "password" && secretInput.dataset.loaded !== "true") {
      secretInput.value = MASKED_SENTINEL;
      secretInput.dataset.masked = "true";
    }
  }
  if (!cfg || dirtyForms[ch]) return;
  if (typeof cfg.account === "string") form.elements.account.value = cfg.account;
  if (Array.isArray(cfg.allowedSenders)) form.elements.senders.value = cfg.allowedSenders.join("\\n");
  if (typeof cfg.enabled === "boolean") form.elements.enabled.checked = cfg.enabled;
}

async function loadChannelDefaults(force = false) {
  if (!force && dirtyForms.weixin && dirtyForms.wecom) return;
  try {
    const r = await fetch("/admin/managed/reveal", {
      method: "POST", cache: "no-store", credentials: "same-origin"
    });
    if (r.status === 401 || !r.ok) return;
    const data = await r.json();
    for (const ch of ["weixin", "wecom"]) {
      const cfg = data[ch];
      applyChannelFormDefaults(ch, cfg, Boolean(cfg?.configured));
      if (cfg?.account) {
        const metaEl = byId("meta-" + ch);
        const curText = metaEl?.textContent || "";
        if (metaEl && !curText.includes("账号：")) {
          metaEl.textContent = "账号：" + cfg.account + " · " + curText;
        }
      }
    }
  } catch { /* ignore reveal failure */ }
}

function renderStatus(d) {
  latestStatus = d;
  for (const ch of ["weixin", "wecom"]) {
    const info = d.channels?.[ch] ?? {};
    const prefix = ch === "weixin" ? "wx" : "wc";
    const stateText = !info.configured ? "未配置" : !info.enabled ? "已暂停" : info.connected ? "连接正常" : info.error ? "连接异常" : "等待连接";
    const tone = !info.configured || !info.enabled ? "" : info.connected ? "good" : info.error ? "warning" : "";
    const metricEl = byId(prefix + "-metric-state");
    metricEl.textContent = stateText;
    metricEl.dataset.tone = tone;
    byId(prefix + "-metric-note").textContent = info.configured
      ? ("白名单 " + (info.sender_count ?? 0) + " 人" + (info.last_ok ? " · " + fmtShortTime(info.last_ok) : ""))
      : "尚未保存渠道凭证";

    const badge = byId("badge-" + ch);
    badge.textContent = stateText;
    badge.dataset.tone = tone;
    byId("meta-" + ch).textContent = !info.configured
      ? "当前尚未配置该渠道，请在下方展开填写机器人凭证与允许的发送者 ID。"
      : ("已配置（白名单 " + (info.sender_count ?? 0) + " 人）"
        + (info.last_ok ? " · 最近通信 " + fmtTime(info.last_ok) : "")
        + (info.error ? " · 错误：" + info.error : ""));

    const toggleBtn = byId("toggle-" + ch);
    if (info.configured) {
      toggleBtn.hidden = false;
      toggleBtn.textContent = info.enabled ? "暂停渠道" : "启用渠道";
      toggleBtn.dataset.nextEnabled = info.enabled ? "false" : "true";
    } else {
      toggleBtn.hidden = true;
      byId("details-" + ch).open = true;
    }
  }

  const ns = d.native_sessions ?? {};
  const activeCount = ns.active ?? 0;
  const totalCount = ns.count ?? 0;
  byId("session-metric").textContent = activeCount + " / " + totalCount;
  const pendingLen = Array.isArray(d.pending) ? d.pending.length : 0;
  byId("queue-metric-note").textContent = "等待回复会话 " + activeCount + " · 排队任务 " + pendingLen;

  const wxOff = d.outbox_offsets?.weixin ?? 0;
  const wcOff = d.outbox_offsets?.wecom ?? 0;
  byId("outbox-metric").textContent = fmtBytes(wxOff + wcOff);
  byId("runtime-metric-note").textContent = "微信 " + fmtBytes(wxOff) + " · 企微 " + fmtBytes(wcOff);

  const alarmParts = [
    "版本 " + (d.runtime_version ?? "native"),
    "能力 " + (d.scope ?? "text"),
    "最近调度 " + fmtTime(d.last_alarm_at),
    "下次唤醒 " + fmtShortTime(d.next_alarm_at)
  ];
  if (d.last_pump_error) alarmParts.push("⚠️ 最近泵错误: " + d.last_pump_error);
  byId("alarm-summary").textContent = alarmParts.join(" · ");

  const chipsEl = byId("summary-chips");
  chipsEl.innerHTML = "";
  const addChip = (text) => {
    const s = document.createElement("span");
    s.className = "chip";
    s.textContent = text;
    chipsEl.appendChild(s);
  };
  for (const row of (d.tasks ?? [])) addChip("任务·" + (phases[row.state] ?? row.state) + ": " + row.count);
  for (const row of (d.outbound ?? [])) addChip("投递·" + (phases[row.state] ?? row.state) + ": " + row.count);
  if (d.connectivity?.checked_at) {
    const wxOk = d.connectivity.weixin?.ok ? "正常" : (d.connectivity.weixin?.configured === false ? "未配" : "异常");
    const wcOk = d.connectivity.wecom?.ok ? "101握手正常" : "异常";
    addChip("最近探测 (" + fmtShortTime(d.connectivity.checked_at) + "): 微信 " + wxOk + " / 企微 " + wcOk);
  }

  const taskMap = new Map();
  const tasksBody = byId("recent-tasks-body");
  tasksBody.innerHTML = "";
  const recents = Array.isArray(d.recent) ? d.recent : [];
  if (!recents.length) {
    tasksBody.innerHTML = '<tr><td colspan="5" class="muted">暂无入站任务记录</td></tr>';
  } else {
    for (const t of recents) {
      taskMap.set(t.id, t);
      const tr = document.createElement("tr");
      const tone = t.state === "succeeded" || t.state === "submitted" ? "good" : (t.state === "failed" || t.state === "unknown" || t.error ? "warning" : "");
      tr.innerHTML = '<td class="mono">#' + t.id + '</td>'
        + '<td>' + (labels[t.channel] ?? t.channel ?? "—") + '</td>'
        + '<td><span class="tag" data-tone="' + tone + '">' + (phases[t.state] ?? t.state) + '</span></td>'
        + '<td class="mono"></td>'
        + '<td>' + fmtShortTime(t.created_at) + '</td>';
      const msgCell = tr.children[3];
      msgCell.textContent = (t.message_id ?? "—") + (t.error ? " (" + t.error + ")" : "");
      tasksBody.appendChild(tr);
    }
  }

  const delivBody = byId("recent-deliveries-body");
  delivBody.innerHTML = "";
  const deliveries = Array.isArray(d.deliveries) ? d.deliveries : [];
  if (!deliveries.length) {
    delivBody.innerHTML = '<tr><td colspan="4" class="muted">暂无回复投递记录</td></tr>';
  } else {
    for (const row of deliveries) {
      const tr = document.createElement("tr");
      const tone = row.state === "delivered" ? "good" : (row.state === "unknown" || row.error ? "warning" : "");
      tr.innerHTML = '<td class="mono">#' + row.id + '</td>'
        + '<td class="mono">#' + row.task_id + '</td>'
        + '<td><span class="tag" data-tone="' + tone + '">' + (phases[row.state] ?? row.state) + '</span></td>'
        + '<td></td>';
      const actionCell = tr.children[3];
      if (row.error) {
        const errSpan = document.createElement("span");
        errSpan.className = "mono";
        errSpan.textContent = String(row.error) + " ";
        actionCell.appendChild(errSpan);
      }
      const linkedTask = taskMap.get(row.task_id);
      if (row.state === "unknown" && linkedTask?.message_id) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "secondary btn-sm";
        btn.textContent = "确认已收到";
        btn.addEventListener("click", () => void confirmDelivery(row.task_id, linkedTask.message_id, btn));
        actionCell.appendChild(btn);
      } else if (!row.error) {
        actionCell.textContent = row.state === "delivered" ? "已投递" : "处理中";
      }
      delivBody.appendChild(tr);
    }
  }
}

async function refresh() {
  try {
    const r = await fetch("/admin/managed/status", { cache: "no-store", credentials: "same-origin" });
    if (r.status === 401) { location.assign("/admin/login"); return; }
    if (!r.ok) { showBanner(byId("ops-feedback"), "状态读取失败（HTTP " + r.status + "）", "warning"); return; }
    const statusData = await r.json();
    renderStatus(statusData);
    void loadChannelDefaults(false);
  } catch {
    showBanner(byId("ops-feedback"), "状态读取失败，请稍后重试。", "warning");
  }
}

async function confirmDelivery(taskId, messageId, btn) {
  btn.disabled = true;
  try {
    const r = await fetch("/admin/managed/confirm-delivery", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId, message_id: messageId, received: true })
    });
    if (r.status === 401) { location.assign("/admin/login"); return; }
    if (r.ok) {
      showBanner(byId("ops-feedback"), "已确认任务 #" + taskId + " 的回复送达。", "good");
      await refresh();
    } else {
      showBanner(byId("ops-feedback"), "无法确认该投递（可能超过单气泡长度或状态已变更）。", "warning");
    }
  } catch {
    showBanner(byId("ops-feedback"), "确认请求失败，请稍后重试。", "warning");
  } finally {
    btn.disabled = false;
  }
}

for (const btn of document.querySelectorAll("[data-toggle]")) {
  btn.addEventListener("click", async () => {
    const channel = btn.dataset.toggle;
    const enabled = btn.dataset.nextEnabled === "true";
    btn.disabled = true;
    try {
      const r = await fetch("/admin/managed/toggle", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, enabled })
      });
      if (r.status === 401) { location.assign("/admin/login"); return; }
      if (r.ok) {
        showBanner(byId("ops-feedback"), labels[channel] + "渠道已" + (enabled ? "启用" : "暂停") + "。", "good");
        await refresh();
      } else {
        showBanner(byId("ops-feedback"), "切换渠道状态失败（HTTP " + r.status + "）。", "warning");
      }
    } catch {
      showBanner(byId("ops-feedback"), "切换渠道请求异常，请稍后重试。", "warning");
    } finally {
      btn.disabled = false;
    }
  });
}

for (const eyeBtn of document.querySelectorAll("[data-secret-eye]")) {
  eyeBtn.addEventListener("click", async () => {
    const ch = eyeBtn.dataset.secretEye;
    const form = document.querySelector('form[data-channel="' + ch + '"]');
    const secretInput = form?.elements.secret;
    if (!secretInput) return;
    if (secretInput.type === "text") {
      clearTimeout(secretMaskTimers[ch]);
      setSecretMaskUI(ch, false);
      return;
    }
    if (secretInput.dataset.masked === "true") {
      eyeBtn.disabled = true;
      try {
        const r = await fetch("/admin/managed/reveal", {
          method: "POST", cache: "no-store", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: ch, revealSecret: true })
        });
        if (r.status === 401) { location.assign("/admin/login"); return; }
        if (!r.ok) {
          showBanner(form.querySelector("output"), "暂无法读取已存密钥（HTTP " + r.status + "）。", "warning");
          return;
        }
        const data = await r.json();
        if (typeof data.secret === "string") {
          secretInput.value = data.secret;
          delete secretInput.dataset.masked;
          secretInput.dataset.loaded = "true";
        }
      } catch {
        showBanner(form.querySelector("output"), "读取密钥请求失败，请稍后重试。", "warning");
        return;
      } finally {
        eyeBtn.disabled = false;
      }
    }
    setSecretMaskUI(ch, true);
    clearTimeout(secretMaskTimers[ch]);
    secretMaskTimers[ch] = setTimeout(() => setSecretMaskUI(ch, false), 60000);
  });
}

for (const form of document.querySelectorAll("form[data-channel]")) {
  const ch = form.dataset.channel;
  const secretInput = form.elements.secret;
  if (secretInput) {
    secretInput.addEventListener("beforeinput", () => {
      if (secretInput.dataset.masked === "true") {
        secretInput.value = "";
        delete secretInput.dataset.masked;
      }
    });
    secretInput.addEventListener("input", () => {
      if (secretInput.dataset.masked === "true") {
        secretInput.value = secretInput.value.replace(/•/g, "");
        delete secretInput.dataset.masked;
      }
    });
  }
  for (const el of form.querySelectorAll("input, textarea")) {
    el.addEventListener("input", () => { dirtyForms[ch] = true; });
    el.addEventListener("change", () => { dirtyForms[ch] = true; });
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector("button[type=submit]");
    const output = form.querySelector("output");
    button.disabled = true;
    try {
      const accountVal = form.elements.account.value.trim();
      const rawSecret = form.elements.secret.dataset.masked === "true" ? "" : form.elements.secret.value;
      const body = {
        account: ch === "weixin" && !accountVal ? "weixin-bot" : accountVal,
        secret: rawSecret,
        allowedSenders: form.elements.senders.value.split(/\\s+/).filter(Boolean),
        enabled: form.elements.enabled.checked
      };
      const r = await fetch("/admin/managed/" + ch, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (r.status === 401) { location.assign("/admin/login"); return; }
      const msg = r.ok ? "配置已保存并生效。"
        : r.status === 409 ? "存在正在处理的任务或当前实例未开放托管，请等任务完成后再替换密钥。"
        : "配置保存失败，请检查输入格式。";
      showBanner(output, msg, r.ok ? "good" : "warning");
      if (r.ok) {
        dirtyForms[ch] = false;
        delete form.elements.secret.dataset.loaded;
        setSecretMaskUI(ch, false);
        form.elements.secret.value = MASKED_SENTINEL;
        form.elements.secret.dataset.masked = "true";
        await refresh();
        await loadChannelDefaults(true);
      }
    } catch {
      showBanner(output, "未收到保存结果，请先刷新状态再决定是否重试。", "warning");
    } finally {
      button.disabled = false;
    }
  });
}

byId("wake-btn").addEventListener("click", async () => {
  const btn = byId("wake-btn");
  btn.disabled = true;
  showBanner(byId("ops-feedback"), "正在唤醒托管调度器并增量扫描会话与 Outbox…");
  try {
    const r = await fetch("/admin/managed/wake", { method: "POST", credentials: "same-origin" });
    if (r.status === 401) { location.assign("/admin/login"); return; }
    if (r.ok) {
      showBanner(byId("ops-feedback"), "已完成全量会话对账与 Outbox 增量同步。", "good");
      await refresh();
    } else {
      showBanner(byId("ops-feedback"), "同步唤醒返回 HTTP " + r.status, "warning");
    }
  } catch {
    showBanner(byId("ops-feedback"), "同步请求超时或网络异常。", "warning");
  } finally {
    btn.disabled = false;
  }
});

byId("conn-btn").addEventListener("click", async () => {
  const btn = byId("conn-btn");
  btn.disabled = true;
  showBanner(byId("ops-feedback"), "正在探测微信 iLink 网关与企业微信长连接网关…");
  try {
    const r = await fetch("/admin/managed/connectivity", { method: "POST", credentials: "same-origin" });
    if (r.status === 401) { location.assign("/admin/login"); return; }
    const d = await r.json();
    if (r.ok) {
      const wxText = d.weixin?.configured === false ? "未配置" : (d.weixin?.ok ? "鉴权读取正常" : "失败 (" + (d.weixin?.error ?? "unknown") + ")");
      const wcText = d.wecom?.ok ? "WebSocket 101 握手正常" : "失败 (" + (d.wecom?.error ?? d.wecom?.status ?? "unknown") + ")";
      showBanner(byId("ops-feedback"), "网关连通性探测完成：微信 iLink [" + wxText + "] · 企业微信 [" + wcText + "]", (d.weixin?.ok || d.weixin?.configured === false) && d.wecom?.ok ? "good" : "warning");
      await refresh();
    } else {
      showBanner(byId("ops-feedback"), "网关探测失败（HTTP " + r.status + "）", "warning");
    }
  } catch {
    showBanner(byId("ops-feedback"), "网关探测请求失败，请稍后重试。", "warning");
  } finally {
    btn.disabled = false;
  }
});

const pushForm = byId("push-form");
pushForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = pushForm.querySelector("button[type=submit]");
  const out = byId("push-feedback");
  const text = pushForm.elements.text.value.trim();
  if (!text) return;
  btn.disabled = true;
  showBanner(out, "正在提交主动推送任务…");
  try {
    const payload = { channel: pushForm.elements.channel.value, text };
    const chat = pushForm.elements.chat.value.trim();
    if (chat) payload.chat = chat;
    const r = await fetch("/admin/managed/push", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (r.status === 401) { location.assign("/admin/login"); return; }
    const d = await r.json();
    if (r.ok && d.ok) {
      showBanner(out, "推送已入队：任务 #" + d.task_id + " → 渠道 [" + (labels[d.channel] ?? d.channel) + "] · 目标会话 [" + d.chat + "]（状态：" + (phases[d.outbound_state] ?? d.outbound_state) + "）", "good");
      pushForm.elements.text.value = "";
      setTimeout(() => void refresh(), 800);
    } else {
      showBanner(out, "推送未成功：" + (d.error ?? ("HTTP " + r.status)), "warning");
    }
  } catch {
    showBanner(out, "推送请求异常，请刷新状态确认是否已入队。", "warning");
  } finally {
    btn.disabled = false;
  }
});

byId("push-clear").addEventListener("click", () => {
  pushForm.elements.text.value = "";
  showBanner(byId("push-feedback"), "");
  pushForm.elements.text.focus();
});

byId("refresh").addEventListener("click", () => void refresh());
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 20000);
</script>
</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`,
    },
  });
}
