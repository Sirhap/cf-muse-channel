/** Browser-only form and dashboard behavior; the Worker serves it under a CSP nonce. */
export const adminScript = String.raw`
  const byId = (id) => document.getElementById(id);
  const form = byId("editor");
  const key = byId("key");
  const cookie = byId("cookie");
  const feedback = byId("feedback");
  const buttons = form.querySelectorAll("button");
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
    label("cookie-state", "待查询");
    byId("cookie-icon").hidden = true;
    label("cookie-note", "输入管理密钥后查看");
    label("renewal-time", "—");
    label("renewal-note", "输入管理密钥后查看");
    label("approval-state", "待查询");
    label("approval-note", "仅自动处理符合规则的请求。");
    label("feedback", "");
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
    const secret = key.value.trim();
    const candidate = save ? cookie.value.trim() : null;
    if (!secret) { label("feedback", "请输入管理密钥。", "warning"); key.focus(); return; }
    if (save && !candidate) { label("feedback", "请粘贴新 Cookie。", "warning"); cookie.focus(); return; }
    buttons.forEach((button) => button.disabled = true);
    key.readOnly = cookie.readOnly = true;
    label("feedback", save ? "正在验证 Muse 连接，请稍候…" : "正在查询状态…");
    try {
      const headers = { Authorization: "Bearer " + secret };
      const options = { method: save ? "POST" : "GET", headers, cache: "no-store", credentials: "omit", redirect: "error" };
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
          message = "管理密钥不正确。";
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
      const imported = hasTime(result.last_imported_at) ? "\n最近手动更换：" + stamp(result.last_imported_at) : "";
      label("feedback", (save ? "新 Cookie 已验证并保存。" : "状态已更新。") + imported, save ? "good" : "");
    } catch {
      label("feedback", save ? "未收到保存结果。请先查看当前状态，再决定是否重试。" : "查询失败，请稍后再试。", "warning");
    } finally {
      buttons.forEach((button) => button.disabled = false);
      key.readOnly = cookie.readOnly = false;
    }
  }

  key.addEventListener("input", clearStatus);
  form.addEventListener("submit", (event) => { event.preventDefault(); void run(true); });
  byId("check").addEventListener("click", () => void run(false));
  byId("clear").addEventListener("click", () => { cookie.value = ""; label("feedback", "已清空新 Cookie 输入。"); cookie.focus(); });
  addEventListener("pagehide", () => { form.reset(); clearStatus(); });
`;
