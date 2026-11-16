/** Browser-only form and dashboard behavior; the Worker serves it under a CSP nonce. */
export const adminScript = String.raw`
  const byId = (id) => document.getElementById(id);
  const form = byId("editor");
  let signedIn = document.body.dataset.authenticated === "true";
  const cookie = byId("cookie");
  const feedback = byId("feedback");
  const currentCookie = byId("current-cookie");
  const revealCookie = byId("reveal-cookie");
  const copyCookie = byId("copy-cookie");
  const buttons = form.querySelectorAll("button");
  const channels = ["weixin", "wecom"];
  let channelRequest = null;
  let readings = null;
  let publicReadings = null;
  let publicCookieState = "loading";
  let cookieRequest = null;
  let hideTimer = null;
  const local = { timeZone: "Asia/Shanghai", hourCycle: "h23" };
  const clock = new Intl.DateTimeFormat("zh-CN", { ...local, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const date = new Intl.DateTimeFormat("zh-CN", { ...local, year: "numeric", month: "2-digit", day: "2-digit" });
  const hasTime = (time) => typeof time === "number" && Number.isFinite(time);
  const stamp = (time) => date.format(time) + " " + clock.format(time);

  function label(id, text, tone = "") {
    const element = byId(id);
    element.textContent = text;
    element.dataset.tone = tone;
  }

  function clearStatus() {
    hideCurrentCookie();
    signedIn = false;
    channelRequest?.abort();
    channelRequest = null;
    readings = null;
    renderChannels();
    renderPublicCookie();
    label("renewal-time", "—");
    label("renewal-note", "登录后查看");
    label("approval-state", "待查询");
    label("approval-note", "仅自动处理符合规则的请求。");
    label("feedback", "");
  }

  function renderChannels() {
    const display = {
      healthy: ["网关正常", "good"],
      reported: ["近期已连接", ""],
      disconnected: ["连接异常", "warning"],
      stale: ["信号未更新", "warning"],
      unknown: ["状态未知", ""],
    };
    for (const channel of channels) {
      const reading = readings?.[channel];
      const state = hasTime(reading?.valid_until) && Date.now() >= reading.valid_until
        ? "stale" : reading?.state ?? publicReadings?.[channel];
      const [text, tone] = display[state] ?? (publicReadings === null ? ["查询中", ""] : display.unknown);
      label(channel + "-state", text, tone);
      label(channel + "-detail", hasTime(reading?.observed_at) ? "最近信号 " + stamp(reading.observed_at) : "Worker 中转");
    }
  }

  async function loadPublicChannels() {
    try {
      const response = await fetch("/channel-health", {
        cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(5000),
      });
      publicReadings = response.ok ? await response.json() : {};
    } catch { publicReadings = {}; }
    renderChannels();
  }

  function renderPublicCookie() {
    const states = {
      loading: "查询中",
      healthy: "正常",
      needs_login: "需要重新登录",
      unconfigured: "尚未配置",
      unverified: "待验证",
    };
    const healthy = publicCookieState === "healthy";
    label("cookie-state", states[publicCookieState] ?? "状态未知",
      healthy ? "good" : publicCookieState === "needs_login" ? "warning" : "");
    byId("cookie-icon").hidden = !healthy;
    label("cookie-note", "最近一次验证结果");
  }

  async function loadPublicCookie() {
    try {
      const response = await fetch("/cookie-health", {
        cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(5000),
      });
      publicCookieState = response.ok ? (await response.json()).state : null;
    } catch { publicCookieState = null; }
    if (!signedIn) renderPublicCookie();
  }

  function hideCurrentCookie() {
    cookieRequest?.abort();
    cookieRequest = null;
    clearTimeout(hideTimer);
    currentCookie.value = "";
    currentCookie.hidden = true;
    copyCookie.hidden = true;
    revealCookie.textContent = "显示";
    revealCookie.setAttribute("aria-expanded", "false");
  }

  async function toggleCurrentCookie() {
    if (!currentCookie.hidden || cookieRequest) { hideCurrentCookie(); return; }
    if (!signedIn) { location.assign("/admin/login"); return; }
    const request = new AbortController();
    cookieRequest = request;
    revealCookie.textContent = "取消";
    try {
      const response = await fetch("/admin/current-cookie", {
        method: "POST",
        cache: "no-store", credentials: "same-origin", redirect: "error", signal: request.signal,
      });
      const data = await response.json();
      if (cookieRequest !== request) return;
      if (!response.ok || typeof data.cookie !== "string" || !data.cookie) {
        const message = response.status === 401 ? "登录已过期，请重新登录。"
          : response.status === 404 ? "尚无当前 Cookie。" : "暂时无法读取当前 Cookie。";
        label("feedback", message, "warning");
        hideCurrentCookie();
        if (response.status === 401) location.assign("/admin/login");
        return;
      }
      label("feedback", "");
      currentCookie.value = data.cookie;
      currentCookie.hidden = false;
      copyCookie.hidden = false;
      revealCookie.textContent = "隐藏";
      revealCookie.setAttribute("aria-expanded", "true");
      hideTimer = setTimeout(hideCurrentCookie, 60_000);
    } catch {
      if (cookieRequest !== request) return;
      label("feedback", "暂时无法读取当前 Cookie。", "warning");
      hideCurrentCookie();
    } finally {
      if (cookieRequest === request) cookieRequest = null;
    }
  }

  async function copyCurrentCookie() {
    if (currentCookie.hidden || !currentCookie.value) return;
    try {
      await navigator.clipboard.writeText(currentCookie.value);
      label("feedback", "已复制当前 Cookie。", "good");
    } catch {
      currentCookie.select();
      label("feedback", "请手动复制已选中的 Cookie。");
    }
  }

  async function refreshChannels() {
    if (channelRequest) return;
    const request = new AbortController();
    channelRequest = request;
    try {
      const response = await fetch("/admin/channels", {
        cache: "no-store",
        credentials: "same-origin", redirect: "error", signal: request.signal,
      });
      const data = response.ok ? await response.json() : null;
      if (channelRequest !== request) return;
      readings = data;
      if (response.status === 401) { clearStatus(); location.assign("/admin/login"); }
      renderChannels();
    } catch {
      if (channelRequest !== request) return;
      readings = null;
      renderChannels();
    } finally { if (channelRequest === request) channelRequest = null; }
  }

  function renderSummary(result) {
    const state = !result.configured ? "尚未配置" : result.needs_login ? "需要重新登录" : result.ok ? "正常" : "待验证";
    label("cookie-state", state, result.ok ? "good" : result.needs_login ? "warning" : "");
    byId("cookie-icon").hidden = !result.ok;
    label("cookie-note", hasTime(result.last_verified_at) ? "最近验证 " + stamp(result.last_verified_at) : "暂无成功验证记录");

    const renewal = result.renewal;
    const event = renewal?.last_event;
    const daily = event?.source === "cloudflare_scheduled" && event.cron === renewal.daily_cron_utc;
    const latest = daily && (event.completed_at ?? event.scheduled_time);
    if (hasTime(latest)) {
      label("renewal-time", clock.format(latest));
      label("renewal-note", date.format(latest) + " · " + (event.result?.ok ? "已成功" : "续期失败"), event.result?.ok ? "good" : "warning");
    } else {
      label("renewal-time", "—");
      label("renewal-note", renewal ? "暂无每日续期记录" : "暂时无法读取续期记录");
    }

    const approval = result.approval;
    const lastPoll = approval?.last_event;
    const observedAt = lastPoll?.completed_at;
    const recent = hasTime(observedAt) && Date.now() - observedAt < 300_000;
    if (!approval) label("approval-state", "状态不可用", "warning");
    else if (!approval.enabled) label("approval-state", "未启用");
    else if (!recent) label("approval-state", "已启用");
    else if (lastPoll.ok) label("approval-state", "运行中", "good");
    else label("approval-state", "最近轮询失败", "warning");
    label("approval-note", approval?.enabled && hasTime(observedAt) ? "最近轮询 " + stamp(observedAt) : "仅自动处理符合规则的请求。");
  }

  async function run(save) {
    if (!signedIn) { location.assign("/admin/login"); return; }
    const candidate = save ? cookie.value.trim() : null;
    if (save && !candidate) { label("feedback", "请粘贴新 Cookie。", "warning"); cookie.focus(); return; }
    if (save) hideCurrentCookie();
    buttons.forEach((button) => button.disabled = true);
    cookie.readOnly = true;
    label("feedback", save ? "正在验证 Muse 连接，请稍候…" : "正在查询状态…");
    try {
      const headers = {};
      const options = { method: save ? "POST" : "GET", headers, cache: "no-store", credentials: "same-origin", redirect: "error" };
      if (save) {
        headers["Content-Type"] = "application/json";
        options.body = JSON.stringify({ cookie: candidate });
      }
      const response = await fetch("/admin/cookie", options);
      const result = await response.json();
      if (!response.ok) {
        let message = "暂时无法处理请求，请稍后再试。";
        if (response.status === 401) {
          clearStatus();
          location.assign("/admin/login");
          message = "登录已过期，请重新登录。";
        } else if (response.status === 400 || response.status === 413) {
          message = "Cookie 格式不正确或太长。请粘贴一行完整的 Cookie 请求头。";
        } else if (result.error === "cookie_not_saved") {
          message = result.last_error?.upstream_status === 401
            ? "Muse 拒绝了新 Cookie，旧记录没有被替换。"
            : "新 Cookie 未通过连接验证或未能保存，旧记录没有被替换。";
        } else if (save) {
          message = "未能确认是否保存。请先查看当前状态，再决定是否重试。";
        }
        label("feedback", message, "warning");
        return;
      }
      if (save) cookie.value = "";
      renderSummary(result);
      void refreshChannels();
      const imported = hasTime(result.last_imported_at) ? "\n最近手动更换：" + stamp(result.last_imported_at) : "";
      label("feedback", (save ? "新 Cookie 已验证并保存。" : "状态已更新。") + imported, save ? "good" : "");
    } catch {
      label("feedback", save ? "未收到保存结果。请先查看当前状态，再决定是否重试。" : "查询失败，请稍后再试。", "warning");
    } finally {
      buttons.forEach((button) => button.disabled = false);
      cookie.readOnly = false;
    }
  }

  form.addEventListener("submit", (event) => { event.preventDefault(); void run(true); });
  byId("check").addEventListener("click", () => void run(false));
  revealCookie.addEventListener("click", () => void toggleCurrentCookie());
  copyCookie.addEventListener("click", () => void copyCurrentCookie());
  byId("clear").addEventListener("click", () => { cookie.value = ""; label("feedback", "已清空新 Cookie 输入。"); cookie.focus(); });
  setInterval(renderChannels, 5000);
  setInterval(() => { if (!document.hidden) void loadPublicChannels(); }, 30_000);
  setInterval(() => { if (!document.hidden && !signedIn) void loadPublicCookie(); }, 30_000);
  setInterval(() => { if (signedIn && !document.hidden) void refreshChannels(); }, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hideCurrentCookie(); return; }
    if (signedIn) void refreshChannels();
    else { void loadPublicChannels(); void loadPublicCookie(); }
  });
  addEventListener("pagehide", () => { form.reset(); clearStatus(); });
  addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });
  void loadPublicChannels();
  void loadPublicCookie();
  if (signedIn) void run(false);
`;
