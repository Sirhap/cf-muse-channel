/** Browser-only form and dashboard behavior; the Worker serves it under a CSP nonce. */
export const adminScript = String.raw`
  const byId = (id) => document.getElementById(id);
  const form = byId("editor");
  let signedIn = document.body.dataset.authenticated === "true";
  const cookie = byId("cookie");
  const modalFeedback = byId("modal-feedback");
  const currentCookie = byId("current-cookie");
  const revealCookie = byId("reveal-cookie");
  const copyCookie = byId("copy-cookie");
  const modal = byId("cookie-modal");
  const channels = ["weixin", "wecom"];
  let channelRequest = null;
  let readings = null;
  let publicReadings = null;
  let publicCookieState = "loading";
  let cookieRequest = null;
  let hideTimer = null;
  let selectedAccount = "primary-account";
  let defaultAccount = "primary-account";
  let poolStrategy = "failover";
  let poolStats = null;
  let accountList = [];
  let modalMode = "replace"; // "replace" | "create" | "batch"
  let currentParsed = null;
  let currentBatchParsed = null;

  const accountHeaders = (extra = {}) => selectedAccount ? { ...extra, "X-Muse-Account": selectedAccount } : { ...extra };
  const local = { timeZone: "Asia/Shanghai", hourCycle: "h23" };
  const clock = new Intl.DateTimeFormat("zh-CN", { ...local, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const date = new Intl.DateTimeFormat("zh-CN", { ...local, year: "numeric", month: "2-digit", day: "2-digit" });
  const hasTime = (time) => typeof time === "number" && Number.isFinite(time);
  const stamp = (time) => date.format(time) + " " + clock.format(time);

  function label(id, text, tone = "") {
    const element = byId(id);
    if (!element) return;
    element.textContent = text;
    element.dataset.tone = tone;
  }

  function setModalFeedback(text, tone = "") {
    if (!modalFeedback) return;
    modalFeedback.hidden = !text;
    modalFeedback.textContent = text;
    modalFeedback.dataset.tone = tone;
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
    label("renewal-note", "登录后查看最近续期记录");
    label("approval-state", "待查询");
    label("approval-note", "仅自动处理符合白名单规则的请求");
    label("feedback", "");
    setModalFeedback("");
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
    if (!currentCookie || !copyCookie || !revealCookie) return;
    currentCookie.value = "";
    currentCookie.hidden = true;
    copyCookie.hidden = true;
    revealCookie.textContent = "显示已存 Cookie";
    revealCookie.setAttribute("aria-expanded", "false");
  }

  async function toggleCurrentCookie() {
    if (!currentCookie.hidden || cookieRequest) { hideCurrentCookie(); return; }
    if (!signedIn) { location.assign("/admin/login"); return; }
    const request = new AbortController();
    cookieRequest = request;
    revealCookie.textContent = "读取中…";
    try {
      const response = await fetch("/admin/current-cookie", {
        method: "POST",
        headers: accountHeaders(),
        cache: "no-store", credentials: "same-origin", redirect: "error", signal: request.signal,
      });
      const data = await response.json();
      if (cookieRequest !== request) return;
      if (!response.ok || typeof data.cookie !== "string" || !data.cookie) {
        const message = response.status === 401 ? "登录已过期，请重新登录。"
          : response.status === 404 ? "该账号尚无已保存的 Cookie。" : "暂时无法读取当前 Cookie。";
        setModalFeedback(message, "warning");
        hideCurrentCookie();
        if (response.status === 401) location.assign("/admin/login");
        return;
      }
      setModalFeedback("");
      currentCookie.value = data.cookie;
      currentCookie.hidden = false;
      copyCookie.hidden = false;
      revealCookie.textContent = "隐藏";
      revealCookie.setAttribute("aria-expanded", "true");
      hideTimer = setTimeout(hideCurrentCookie, 60_000);
    } catch {
      if (cookieRequest !== request) return;
      setModalFeedback("暂时无法读取当前 Cookie。", "warning");
      hideCurrentCookie();
    } finally {
      if (cookieRequest === request) cookieRequest = null;
    }
  }

  async function copyCurrentCookie() {
    if (currentCookie.hidden || !currentCookie.value) return;
    try {
      await navigator.clipboard.writeText(currentCookie.value);
      setModalFeedback("已复制当前 Cookie。", "good");
    } catch {
      currentCookie.select();
      setModalFeedback("请手动复制已选中的 Cookie。");
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
    const latest = event && (event.completed_at ?? event.scheduled_time);
    if (hasTime(latest)) {
      const sourceLabel = event.cron === "manual_admin" ? "手动续期" : "每日续期";
      const totalAcc = event.result?.accounts_total;
      const okAcc = event.result?.accounts_ok;
      const accCountNote = typeof totalAcc === "number" && totalAcc > 1
        ? ("（" + (okAcc ?? 0) + "/" + totalAcc + " 个账号）")
        : "";
      label("renewal-time", clock.format(latest));
      label("renewal-note", date.format(latest) + " · " + sourceLabel + (event.result?.ok ? "已成功" : "部分/全部失败") + accCountNote, event.result?.ok ? "good" : "warning");
    } else {
      label("renewal-time", "—");
      label("renewal-note", renewal ? "暂无续期记录" : "暂时无法读取续期记录");
    }

    const approval = result.approval;
    const lastPoll = approval?.last_event;
    const observedAt = lastPoll?.completed_at;
    const recent = hasTime(observedAt) && Date.now() - observedAt < 300_000;
    const polledCount = lastPoll?.accounts_polled;
    const polledOk = lastPoll?.accounts_ok;
    if (!approval) label("approval-state", "状态不可用", "warning");
    else if (!approval.enabled) label("approval-state", "未启用");
    else if (!recent) label("approval-state", "已启用");
    else if (lastPoll.ok) label("approval-state", "运行中", "good");
    else if (typeof polledOk === "number" && polledOk > 0) label("approval-state", "部分账号异常", "warning");
    else label("approval-state", "最近轮询失败", "warning");
    const accountScope = typeof polledCount === "number" && polledCount > 1
      ? (" · 覆盖 " + polledCount + " 个账号")
      : "";
    label("approval-note", approval?.enabled && hasTime(observedAt) ? ("最近轮询 " + stamp(observedAt) + accountScope) : "仅自动处理符合白名单规则的请求");

    const statsEl = byId("approval-stats");
    if (statsEl) {
      const decisions = Array.isArray(approval?.decisions) ? approval.decisions : [];
      const acceptedCount = decisions.find((d) => d.state === "rpc_accepted")?.count ?? 0;
      const chips = [];
      if (acceptedCount > 0) chips.push("累计放行 " + acceptedCount);
      if (typeof polledCount === "number" && polledCount > 1) {
        chips.push("账号池 " + (polledOk ?? 0) + "/" + polledCount);
      }
      if (lastPoll && typeof lastPoll.pending === "number") {
        chips.push("待审 " + lastPoll.pending + " · 放行 " + (lastPoll.approved ?? 0) + " · 保留 " + (lastPoll.held ?? 0));
      }
      statsEl.innerHTML = "";
      for (const text of chips) {
        const span = document.createElement("span");
        span.className = "chip";
        span.textContent = text;
        statsEl.appendChild(span);
      }
      statsEl.hidden = chips.length === 0;
    }
  }

  function maskValue(val) {
    const str = String(val ?? "");
    if (!str) return "空";
    if (str.length <= 12) return str.slice(0, 3) + "•••";
    return str.slice(0, 6) + "•••" + str.slice(-4);
  }

  function parseHeaderItems(rawHeader) {
    const clean = String(rawHeader ?? "").trim().replace(/^cookie:[ \t]*/i, "").trim();
    if (!clean) return [];
    const pairs = clean.split(";").map((p) => p.trim()).filter(Boolean);
    const items = [];
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq < 1) return [];
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name || !value) continue;
      items.push({ name, value, httpOnly: false, secure: false, path: "/" });
    }
    return items;
  }

  function parseCookieCandidate(rawInput) {
    const text = String(rawInput ?? "").trim();
    if (!text) return null;
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          const byName = new Map();
          for (const i of parsed) {
            if (!i || typeof i.name !== "string" || typeof i.value !== "string") continue;
            const key = i.name.trim();
            if (!key || !i.value) continue;
            const prev = byName.get(key);
            if (!prev || i.path === "/") {
              byName.set(key, {
                name: key,
                value: i.value,
                httpOnly: Boolean(i.httpOnly),
                secure: Boolean(i.secure),
                domain: i.domain || "",
                path: i.path || "/",
              });
            }
          }
          const items = Array.from(byName.values());
          if (!items.length) return { kind: "invalid-json" };
          return {
            kind: "json",
            sourceLabel: "Cookie 数组 JSON",
            header: items.map((i) => i.name + "=" + i.value).join("; "),
            items,
            httpOnlyCount: items.filter((i) => i.httpOnly).length,
            vmId: null,
            hasAccessToken: false,
            hasHatchToken: false,
            exportedAt: null,
          };
        }
        if (parsed && typeof parsed === "object") {
          const itemMap = new Map();
          const rawItems = Array.isArray(parsed.items)
            ? parsed.items
            : Array.isArray(parsed.cookie_items)
              ? parsed.cookie_items
              : [];
          for (const it of rawItems) {
            if (!it || typeof it.name !== "string" || typeof it.value !== "string") continue;
            const key = it.name.trim();
            if (!key || !it.value) continue;
            const prev = itemMap.get(key);
            if (!prev || it.path === "/") {
              itemMap.set(key, {
                name: key,
                value: it.value,
                httpOnly: Boolean(it.httpOnly),
                secure: Boolean(it.secure),
                domain: it.domain || "",
                path: it.path || "/",
              });
            }
          }
          if (parsed.cookies && typeof parsed.cookies === "object" && !Array.isArray(parsed.cookies)) {
            for (const [k, v] of Object.entries(parsed.cookies)) {
              if (typeof v !== "string" || !k.trim() || !v) continue;
              const existing = itemMap.get(k.trim());
              itemMap.set(k.trim(), existing ? { ...existing, value: v } : {
                name: k.trim(), value: v, httpOnly: false, secure: false, domain: "", path: "/",
              });
            }
          }
          if (typeof parsed.cookie === "string" && parsed.cookie.trim()) {
            for (const it of parseHeaderItems(parsed.cookie)) {
              const existing = itemMap.get(it.name);
              itemMap.set(it.name, existing ? { ...existing, value: it.value } : it);
            }
          }
          const items = Array.from(itemMap.values());
          if (!items.length) return { kind: "invalid-json" };
          const header = items.map((i) => i.name + "=" + i.value).join("; ");
          const httpOnlyCount = typeof parsed.http_only_count === "number"
            ? parsed.http_only_count
            : items.filter((i) => i.httpOnly).length;
          const isBundle = Boolean(parsed.cookie_items || parsed.token);
          const tokenObj = parsed.token && typeof parsed.token === "object" ? parsed.token : parsed;
          return {
            kind: "json",
            sourceLabel: isBundle ? "扩展全量 JSON (muse-credentials.json)" : "扩展 Cookie JSON (cookies.json)",
            header,
            items,
            httpOnlyCount,
            vmId: typeof parsed.vm_id === "string" && parsed.vm_id ? parsed.vm_id : (typeof tokenObj.vm_id === "string" ? tokenObj.vm_id : null),
            hasAccessToken: Boolean(tokenObj.access_token),
            hasHatchToken: Boolean(tokenObj.hatch_token),
            exportedAt: parsed.exported_at || tokenObj.issued_at || null,
          };
        }
      } catch {
        return { kind: "invalid-json" };
      }
      return { kind: "invalid-json" };
    }

    const items = parseHeaderItems(text);
    if (!items.length) return { kind: "invalid-header" };
    return {
      kind: "header",
      sourceLabel: "Cookie 请求头",
      header: items.map((i) => i.name + "=" + i.value).join("; "),
      items,
      httpOnlyCount: 0,
      vmId: null,
      hasAccessToken: false,
      hasHatchToken: false,
      exportedAt: null,
    };
  }

  function parseBatchInput(rawInput) {
    const text = String(rawInput ?? "").trim();
    if (!text) return null;
    if (text.startsWith("[")) {
      try {
        const arr = JSON.parse(text);
        if (!Array.isArray(arr)) return { error: "JSON 必须为数组格式" };
        const entries = [];
        for (let idx = 0; idx < arr.length; idx++) {
          const item = arr[idx];
          if (!item || typeof item !== "object") continue;
          const labelName = String(item.label || item.name || ("账号-" + (idx + 1))).trim();
          const parsedCookie = item.cookie ? parseCookieCandidate(typeof item.cookie === "string" ? item.cookie : JSON.stringify(item.cookie)) : parseCookieCandidate(JSON.stringify(item));
          entries.push({
            label: labelName,
            id: typeof item.id === "string" ? item.id.trim().toLowerCase() : "",
            parsed: parsedCookie && (parsedCookie.kind === "json" || parsedCookie.kind === "header") ? parsedCookie : null,
          });
        }
        return entries.length ? { entries } : { error: "数组中未找到有效账号项" };
      } catch {
        return { error: "JSON 数组解析失败，请检查括号与逗号" };
      }
    }

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const entries = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      let labelName = "批量账号-" + (idx + 1);
      let rawPart = line;
      const pipeIdx = line.indexOf("|");
      if (pipeIdx > 0 && !line.startsWith("{")) {
        labelName = line.slice(0, pipeIdx).trim() || labelName;
        rawPart = line.slice(pipeIdx + 1).trim();
      }
      const parsedCookie = parseCookieCandidate(rawPart);
      entries.push({
        label: labelName,
        id: "",
        parsed: parsedCookie && (parsedCookie.kind === "json" || parsedCookie.kind === "header") ? parsedCookie : null,
      });
    }
    return entries.length ? { entries } : { error: "未解析到任何行" };
  }

  function renderBatchPreview(pv, statusBadge) {
    const res = parseBatchInput(cookie.value);
    currentParsed = null;
    currentBatchParsed = null;
    if (!res) {
      pv.dataset.empty = "true";
      statusBadge.textContent = "等待输入";
      statusBadge.dataset.tone = "";
      pv.innerHTML = '<div class="cookie-preview-empty">'
        + '<strong>批量导入多账号（参考 muse2api）</strong>'
        + '<p>每行一个账号：<code>备注名 | Cookie或单行JSON</code><br>或直接粘贴 JSON 数组：<code>[{"label":"号1","cookie":"..."}]</code></p>'
        + '</div>';
      return;
    }
    if (res.error) {
      pv.dataset.empty = "true";
      statusBadge.textContent = "格式有误";
      statusBadge.dataset.tone = "warning";
      pv.innerHTML = '<div class="cookie-preview-empty"><strong>批量解析失败</strong><p>' + res.error + '</p></div>';
      return;
    }
    const validEntries = res.entries.filter((e) => e.parsed);
    currentBatchParsed = validEntries;
    delete pv.dataset.empty;
    statusBadge.textContent = "✓ 识别 " + validEntries.length + " / " + res.entries.length + " 个账号";
    statusBadge.dataset.tone = validEntries.length > 0 ? "good" : "warning";
    pv.innerHTML = "";

    const headerEl = document.createElement("div");
    headerEl.className = "cookie-preview-header";
    const titleEl = document.createElement("div");
    titleEl.className = "cookie-preview-title";
    titleEl.textContent = "待导入账号清单（验证通过后全部自动开启）";
    headerEl.appendChild(titleEl);
    pv.appendChild(headerEl);

    const listEl = document.createElement("div");
    listEl.className = "batch-preview-list";
    for (const entry of res.entries) {
      const row = document.createElement("div");
      row.className = "batch-preview-row";
      const left = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = entry.label;
      left.appendChild(strong);
      if (entry.parsed?.vmId) {
        const vmSpan = document.createElement("span");
        vmSpan.className = "muted mono";
        vmSpan.style.marginLeft = "8px";
        vmSpan.textContent = "VM " + entry.parsed.vmId.slice(0, 8);
        left.appendChild(vmSpan);
      }
      const tag = document.createElement("span");
      tag.className = "tag";
      if (entry.parsed) {
        tag.dataset.tone = "good";
        tag.textContent = "✓ " + entry.parsed.items.length + " Cookie";
      } else {
        tag.dataset.tone = "warning";
        tag.textContent = "格式无效";
      }
      row.append(left, tag);
      listEl.appendChild(row);
    }
    pv.appendChild(listEl);
  }

  function renderLivePreview() {
    const pv = byId("main-cookie-preview");
    const statusBadge = byId("preview-status-badge");
    if (!cookie || !pv || !statusBadge) return;
    if (modalMode === "batch") {
      renderBatchPreview(pv, statusBadge);
      return;
    }
    currentBatchParsed = null;
    const raw = cookie.value;
    const parsed = parseCookieCandidate(raw);
    currentParsed = parsed && (parsed.kind === "json" || parsed.kind === "header") ? parsed : null;

    if (!parsed) {
      pv.dataset.empty = "true";
      statusBadge.textContent = "等待输入";
      statusBadge.dataset.tone = "";
      pv.innerHTML = '<div class="cookie-preview-empty">'
        + '<strong>等待粘贴或导入 JSON 凭证</strong>'
        + '<p>在左侧粘贴浏览器扩展导出的 <code>cookies.json</code> / <code>muse-credentials.json</code> 或 Cookie 请求头，此处将实时展示识别状态、<code>HttpOnly</code> 统计、虚拟机 ID 与脱敏键值胶囊。</p>'
        + '</div>';
      return;
    }

    if (parsed.kind === "invalid-json" || parsed.kind === "invalid-header") {
      pv.dataset.empty = "true";
      statusBadge.textContent = parsed.kind === "invalid-json" ? "JSON 格式有误" : "未识别到有效键值";
      statusBadge.dataset.tone = "warning";
      pv.innerHTML = '<div class="cookie-preview-empty">'
        + '<strong>未能解析出有效 Cookie</strong>'
        + '<p>请检查粘贴的 JSON 是否完整（包含 <code>cookies</code> / <code>cookie</code> / <code>items</code> 字段），或确认请求头格式为 <code>名称=值; 名称2=值2</code>。</p>'
        + '</div>';
      return;
    }

    delete pv.dataset.empty;
    statusBadge.textContent = "✓ " + parsed.sourceLabel;
    statusBadge.dataset.tone = "good";
    pv.innerHTML = "";

    const headerEl = document.createElement("div");
    headerEl.className = "cookie-preview-header";
    const titleEl = document.createElement("div");
    titleEl.className = "cookie-preview-title";
    const countSpan = document.createElement("span");
    countSpan.textContent = "共解析出 " + parsed.items.length + " 项有效 Cookie"
      + (parsed.httpOnlyCount > 0 ? "（含 " + parsed.httpOnlyCount + " 个 HttpOnly）" : "");
    titleEl.appendChild(countSpan);
    headerEl.appendChild(titleEl);
    pv.appendChild(headerEl);

    const metaChips = [];
    if (parsed.vmId) metaChips.push(["虚拟机 ID", parsed.vmId]);
    if (parsed.hasAccessToken || parsed.hasHatchToken) {
      const parts = [parsed.hasAccessToken && "Access", parsed.hasHatchToken && "Hatch"].filter(Boolean).join(" + ");
      metaChips.push(["附带 Token", parts + " Token"]);
    }
    if (parsed.exportedAt) {
      const ts = Date.parse(parsed.exportedAt);
      metaChips.push(["导出时间", Number.isFinite(ts) ? stamp(ts) : String(parsed.exportedAt)]);
    }
    if (metaChips.length > 0) {
      const metaRow = document.createElement("div");
      metaRow.className = "cookie-preview-meta";
      for (const [k, v] of metaChips) {
        const chip = document.createElement("span");
        chip.className = "cookie-meta-chip";
        const labelNode = document.createTextNode(k + "：");
        const codeNode = document.createElement("code");
        codeNode.textContent = v;
        chip.append(labelNode, codeNode);
        metaRow.appendChild(chip);
      }
      pv.appendChild(metaRow);
    }

    const grid = document.createElement("div");
    grid.className = "cookie-preview-grid";
    for (const item of parsed.items) {
      const pill = document.createElement("div");
      pill.className = "cookie-item-pill";

      const top = document.createElement("div");
      top.className = "cookie-item-top";
      const nameEl = document.createElement("strong");
      nameEl.className = "cookie-item-name";
      nameEl.textContent = item.name;
      nameEl.title = item.name;
      top.appendChild(nameEl);

      const badges = document.createElement("span");
      badges.className = "cookie-item-badges";
      if (item.httpOnly) {
        const b = document.createElement("span");
        b.className = "cookie-badge httponly";
        b.textContent = "HttpOnly";
        badges.appendChild(b);
      }
      if (item.secure) {
        const b = document.createElement("span");
        b.className = "cookie-badge secure";
        b.textContent = "Secure";
        badges.appendChild(b);
      }
      top.appendChild(badges);

      const valRow = document.createElement("div");
      valRow.className = "cookie-item-val";
      const maskedEl = document.createElement("span");
      maskedEl.textContent = maskValue(item.value);
      const lenEl = document.createElement("span");
      lenEl.className = "cookie-item-len";
      lenEl.textContent = item.value.length + " 字符";
      valRow.append(maskedEl, lenEl);

      pill.append(top, valRow);
      grid.appendChild(pill);
    }
    pv.appendChild(grid);
  }

  function resetModalInput() {
    if (cookie) cookie.value = "";
    currentParsed = null;
    currentBatchParsed = null;
    setModalFeedback("");
    renderLivePreview();
  }

  function openCookieModal(mode, targetAccountId) {
    if (!signedIn) { location.assign("/admin/login"); return; }
    modalMode = mode;
    if (targetAccountId) {
      selectedAccount = targetAccountId;
    }
    hideCurrentCookie();
    resetModalInput();

    const newAccFields = byId("modal-new-account-fields");
    const curCookieWrap = byId("modal-current-cookie-wrap");
    const titleEl = byId("edit-title");
    const badgeEl = byId("modal-account-badge");
    const submitBtn = byId("modal-submit-btn");
    const inputLabel = byId("cookie-input-label");
    const hintEl = byId("hint");

    if (mode === "create") {
      if (titleEl) titleEl.textContent = "新增 Muse 账号";
      if (badgeEl) {
        badgeEl.textContent = "验证通过即加入多开调度池";
        badgeEl.dataset.tone = "good";
      }
      if (newAccFields) newAccFields.hidden = false;
      if (curCookieWrap) curCookieWrap.hidden = true;
      if (submitBtn) submitBtn.textContent = "创建并加入账号池";
      if (inputLabel) inputLabel.textContent = "新账号 Cookie / 扩展 JSON（可选）";
      if (cookie) cookie.placeholder = "在此粘贴浏览器扩展复制的 cookies.json / muse-credentials.json，或单行 Cookie 请求头…";
      if (hintEl) hintEl.innerHTML = "支持直接粘贴扩展复制的 JSON 或 <code>名称=值; 名称2=值2</code>，右侧实时同步预览";
      byId("new-account-label").value = "";
      byId("new-account-id").value = "";
      byId("new-account-enabled").checked = true;
      byId("new-account-default").checked = false;
    } else if (mode === "batch") {
      if (titleEl) titleEl.textContent = "批量导入 Muse 账号";
      if (badgeEl) {
        badgeEl.textContent = "muse2api 兼容格式 · 自动全部开启";
        badgeEl.dataset.tone = "accent";
      }
      if (newAccFields) newAccFields.hidden = true;
      if (curCookieWrap) curCookieWrap.hidden = true;
      if (submitBtn) submitBtn.textContent = "批量验证并导入账号池";
      if (inputLabel) inputLabel.textContent = "批量账号文本 / JSON 数组";
      if (cookie) cookie.placeholder = "每行一条：备注名 | Cookie或单行JSON\n例：备用1 | hatch_sess=...; hatch_vml=...\n或粘贴 JSON 数组：[{\"label\":\"号1\",\"cookie\":...}]";
      if (hintEl) hintEl.innerHTML = "每行 <code>名称 | Cookie/JSON</code>，或粘贴 JSON 数组，右侧实时预览识别出的账号数";
    } else {
      const found = accountList.find((a) => a.id === selectedAccount);
      const title = found ? (found.label + " (" + found.id + ")") : selectedAccount;
      if (titleEl) titleEl.textContent = "更换账号 Cookie";
      if (badgeEl) {
        badgeEl.textContent = title + (selectedAccount === defaultAccount ? " · 首选兜底" : "");
        badgeEl.dataset.tone = selectedAccount === defaultAccount ? "good" : "";
      }
      if (newAccFields) newAccFields.hidden = true;
      if (curCookieWrap) curCookieWrap.hidden = false;
      if (submitBtn) submitBtn.textContent = "验证并保存 Cookie";
      if (inputLabel) inputLabel.textContent = "粘贴扩展 JSON 或新 Cookie";
      if (cookie) cookie.placeholder = "在此粘贴浏览器扩展复制的 cookies.json / muse-credentials.json，或单行 Cookie 请求头…";
      if (hintEl) hintEl.innerHTML = "支持直接粘贴扩展复制的 JSON 或 <code>名称=值; 名称2=值2</code>，右侧实时同步预览";
    }

    if (modal) {
      modal.hidden = false;
      setTimeout(() => {
        if (mode === "create") byId("new-account-label")?.focus();
        else cookie?.focus();
      }, 20);
    }
  }

  function closeCookieModal() {
    hideCurrentCookie();
    if (modal) modal.hidden = true;
  }

  function initModalAndPreview() {
    if (cookie) {
      cookie.addEventListener("input", () => renderLivePreview());
      cookie.addEventListener("paste", () => setTimeout(() => renderLivePreview(), 0));
    }
    byId("open-add-account")?.addEventListener("click", () => openCookieModal("create"));
    byId("open-batch-import")?.addEventListener("click", () => openCookieModal("batch"));
    byId("close-cookie-modal")?.addEventListener("click", closeCookieModal);
    byId("cancel-cookie-modal")?.addEventListener("click", closeCookieModal);
    modal?.addEventListener("click", (e) => {
      if (e.target === modal) closeCookieModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal && !modal.hidden) closeCookieModal();
    });

    document.querySelectorAll("[data-cookie-paste]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!cookie) return;
        try {
          const clipText = await navigator.clipboard.readText();
          if (!clipText || !clipText.trim()) {
            setModalFeedback("剪贴板为空，请先在浏览器扩展中点击「复制 JSON」。", "warning");
            return;
          }
          cookie.value = clipText.trim();
          setModalFeedback("");
          renderLivePreview();
        } catch {
          cookie.focus();
          setModalFeedback("浏览器未授权直接读取剪贴板，请在左侧输入框按 Cmd+V / Ctrl+V 粘贴。", "warning");
        }
      });
    });

    document.querySelectorAll("[data-cookie-file-btn]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-cookie-file-btn");
        document.querySelector('[data-cookie-file="' + key + '"]')?.click();
      });
    });

    document.querySelectorAll("[data-cookie-file]").forEach((input) => {
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!cookie || !file) return;
        try {
          const text = await file.text();
          cookie.value = text.trim();
          setModalFeedback("");
          renderLivePreview();
        } finally {
          input.value = "";
        }
      });
    });

    renderLivePreview();
  }

  async function run(save) {
    if (!signedIn) { location.assign("/admin/login"); return; }
    if (save && modalMode === "create") {
      await submitNewAccountFromModal();
      return;
    }
    if (save && modalMode === "batch") {
      await submitBatchAccountsFromModal();
      return;
    }
    const rawCandidate = save ? cookie.value.trim() : null;
    const candidate = save ? (currentParsed?.header || rawCandidate) : null;
    if (save && !candidate) {
      setModalFeedback("请先在左侧粘贴扩展复制的 JSON 或新 Cookie。", "warning");
      cookie.focus();
      return;
    }
    if (save) hideCurrentCookie();
    const submitBtn = byId("modal-submit-btn");
    if (submitBtn) submitBtn.disabled = true;
    cookie.readOnly = true;
    if (save) setModalFeedback("正在向 Muse 验证新 Cookie，请稍候…");
    try {
      const headers = accountHeaders();
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
          message = "Cookie 或 JSON 格式不正确，请粘贴扩展导出的 JSON 或完整 Cookie 请求头。";
        } else if (result.error === "cookie_not_saved") {
          const errDetail = result.last_error
            ? " [" + result.last_error.stage + ": " + result.last_error.error + (result.last_error.upstream_status ? " (" + result.last_error.upstream_status + ")" : "") + "]"
            : "";
          message = (result.last_error?.upstream_status === 401
            ? "Muse 拒绝了新 Cookie（已过期或未登录），旧记录未被替换。"
            : "新 Cookie 未通过验证，旧记录未被替换。") + errDetail;
        } else if (save) {
          message = "未能确认是否保存，请查看状态后决定是否重试。";
        }
        if (save) setModalFeedback(message, "warning");
        else label("feedback", message, "warning");
        return;
      }
      renderSummary(result);
      void refreshChannels();
      void loadAccounts();
      if (save) {
        const imported = hasTime(result.last_imported_at) ? "（更换时间 " + stamp(result.last_imported_at) + "）" : "";
        const sleepNote = result.vm_sleeping ? "；当前账号 VM 处于休眠状态，将在首次连接时唤醒" : "";
        closeCookieModal();
        label("feedback", "新 Cookie 已验证并保存" + imported + sleepNote + "。", "good");
      }
    } catch {
      const msg = save ? "未收到保存结果，请查看当前状态后重试。" : "查询失败，请稍后再试。";
      if (save) setModalFeedback(msg, "warning");
      else label("feedback", msg, "warning");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
      cookie.readOnly = false;
    }
  }

  async function submitNewAccountFromModal() {
    const labelInput = byId("new-account-label");
    const idInput = byId("new-account-id");
    const enabledInput = byId("new-account-enabled");
    const defaultInput = byId("new-account-default");
    const labelText = labelInput?.value.trim() || "";
    if (!labelText) {
      setModalFeedback("请填写新账号的备注名称（例如：备用二号）。", "warning");
      labelInput?.focus();
      return;
    }
    const idText = idInput?.value.trim().toLowerCase() || "";
    const rawCookieText = cookie.value.trim();
    const cookieText = currentParsed?.header || rawCookieText;
    const enabled = Boolean(enabledInput?.checked ?? true);
    const setDefault = Boolean(defaultInput?.checked);
    const submitBtn = byId("modal-submit-btn");
    if (submitBtn) submitBtn.disabled = true;
    setModalFeedback(cookieText ? "正在验证新账号 Cookie 并加入多开调度池…" : "正在创建账号槽位…");
    try {
      const ok = await mutateAccount(
        { action: "create", label: labelText, id: idText || undefined, cookie: cookieText || undefined, enabled, set_default: setDefault },
        "已成功创建 Muse 账号 [" + labelText + "]" + (cookieText ? (enabled ? " 并已开启加入多开池。" : "（当前为停用状态）。") : "（请点击「导入 Cookie」完成配置）。"),
      );
      if (ok) {
        closeCookieModal();
        void run(false);
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  async function submitBatchAccountsFromModal() {
    if (!currentBatchParsed || !currentBatchParsed.length) {
      setModalFeedback("请先粘贴至少一条有效的账号 Cookie 或 JSON 数组。", "warning");
      cookie.focus();
      return;
    }
    const items = currentBatchParsed.map((e) => ({
      label: e.label,
      id: e.id || undefined,
      cookie: e.parsed.header,
      enabled: true,
    }));
    const submitBtn = byId("modal-submit-btn");
    if (submitBtn) submitBtn.disabled = true;
    setModalFeedback("正在批量验证并导入 " + items.length + " 个账号，请稍候…");
    try {
      const response = await fetch("/admin/accounts", {
        method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "batch_create", items }),
      });
      if (response.status === 401) { clearStatus(); location.assign("/admin/login"); return; }
      const data = await response.json();
      if (!response.ok) {
        setModalFeedback("批量导入失败（" + (data.error ?? response.status) + "）。", "warning");
        return;
      }
      applyAccountsData(data);
      const br = data.batch_result || { created: [], failed: [] };
      const summary = "批量导入完成：成功 " + br.created.length + " 个"
        + (br.failed.length ? "，失败 " + br.failed.length + " 个（" + br.failed.map((f) => f.label + ":" + f.error).join(", ") + "）" : "，已全部自动开启并加入调度池。");
      if (br.created.length > 0) {
        closeCookieModal();
        label("feedback", summary, br.failed.length ? "warning" : "good");
      } else {
        setModalFeedback(summary, "warning");
      }
    } catch {
      setModalFeedback("批量导入网络异常，请稍后重试。", "warning");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  async function runQuickAction(endpoint, progressText, formatSuccess, targetAccId) {
    if (!signedIn) { location.assign("/admin/login"); return; }
    if (targetAccId) {
      selectedAccount = targetAccId;
    }
    const pollBtn = byId("poll-approvals");
    if (pollBtn) pollBtn.disabled = true;
    label("feedback", progressText);
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: accountHeaders(), cache: "no-store", credentials: "same-origin", redirect: "error",
      });
      if (response.status === 401) {
        clearStatus();
        location.assign("/admin/login");
        label("feedback", "登录已过期，请重新登录。", "warning");
        return;
      }
      const data = await response.json();
      if (!response.ok && endpoint !== "/admin/probe-rpc") {
        label("feedback", "操作未成功（状态码 " + response.status + "），请检查 Cookie 与上游连接。", "warning");
        return;
      }
      if ("configured" in data) renderSummary(data);
      void loadAccounts();
      const msg = formatSuccess(data, response.ok);
      label("feedback", msg.text, msg.tone ?? "good");
    } catch {
      label("feedback", "请求超时或网络异常，请稍后重试。", "warning");
    } finally {
      if (pollBtn) pollBtn.disabled = false;
    }
  }

  form?.addEventListener("submit", (event) => { event.preventDefault(); void run(true); });
  byId("check")?.addEventListener("click", () => { void loadAccounts(); void run(false); });
  byId("renew-all-btn")?.addEventListener("click", () => {
    void mutateAccount({ action: "renew_all" }, "已向账号池中全部已开启账号发起续期。");
  });
  byId("pool-strategy")?.addEventListener("change", (event) => {
    const val = event.target.value;
    void mutateAccount({ action: "set_strategy", strategy: val }, "已切换账号池调度策略。");
  });
  byId("poll-approvals")?.addEventListener("click", () => void runQuickAction(
    "/admin/approvals/poll",
    "正在轮询账号池全部启用账号的待审批请求…",
    (d) => {
      const p = d.poll_result;
      if (!p?.enabled) return { text: "当前 Worker 未启用自动审批（AUTO_APPROVAL_ENABLED=false）。", tone: "" };
      const prefix = typeof p.accounts_polled === "number" && p.accounts_polled > 1
        ? ("（" + (p.accounts_ok ?? 0) + "/" + p.accounts_polled + " 个账号正常）")
        : "";
      if (!p.ok && !(typeof p.accounts_ok === "number" && p.accounts_ok > 0)) {
        return { text: "审批轮询失败" + prefix + "，请稍后重试。", tone: "warning" };
      }
      return {
        text: "审批轮询完成" + prefix + "：待审 " + (p.pending ?? 0) + " 项，自动放行 " + (p.approved ?? 0) + " 项，保留待人工 " + (p.held ?? 0) + " 项。",
        tone: p.ok ? "good" : "warning",
      };
    },
  ));
  revealCookie?.addEventListener("click", () => void toggleCurrentCookie());
  copyCookie?.addEventListener("click", () => void copyCurrentCookie());
  byId("clear")?.addEventListener("click", () => { resetModalInput(); cookie?.focus(); });
  setInterval(renderChannels, 5000);
  setInterval(() => { if (!document.hidden) void loadPublicChannels(); }, 30_000);
  setInterval(() => { if (!document.hidden && !signedIn) void loadPublicCookie(); }, 30_000);
  setInterval(() => { if (signedIn && !document.hidden) void refreshChannels(); }, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hideCurrentCookie(); return; }
    if (signedIn) void refreshChannels();
    else { void loadPublicChannels(); void loadPublicCookie(); }
  });
  addEventListener("pagehide", () => { form?.reset(); clearStatus(); });
  addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });

  function updatePoolHeader() {
    const badge = byId("selected-account-badge");
    if (badge && poolStats) {
      badge.textContent = "已开启 " + poolStats.enabled + " / " + poolStats.total + " · 可用 " + poolStats.healthy;
      badge.dataset.tone = poolStats.healthy > 0 ? "good" : "warning";
    }
    const enEl = byId("pool-stat-enabled");
    const hlEl = byId("pool-stat-healthy");
    const alEl = byId("pool-stat-alert");
    const stratEl = byId("pool-strategy");
    if (stratEl && stratEl.value !== poolStrategy) stratEl.value = poolStrategy;
    if (poolStats) {
      if (enEl) {
        enEl.textContent = "已开启 " + poolStats.enabled + " / " + poolStats.total;
        enEl.dataset.tone = poolStats.enabled > 1 ? "good" : "";
      }
      if (hlEl) {
        hlEl.textContent = "健康可用 " + poolStats.healthy;
        hlEl.dataset.tone = poolStats.healthy > 0 ? "good" : "warning";
      }
      if (alEl) {
        const warns = [];
        if (poolStats.needs_login > 0) warns.push("需重新登录 " + poolStats.needs_login);
        if (poolStats.cooling > 0) warns.push("冷却中 " + poolStats.cooling);
        alEl.hidden = warns.length === 0;
        alEl.textContent = warns.join(" · ");
        alEl.dataset.tone = "warning";
      }
    }
  }

  function renderAccountsTable() {
    const tbody = byId("accounts-table-body");
    if (!tbody) return;
    updatePoolHeader();
    tbody.innerHTML = "";
    if (!accountList.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">暂无账号数据</td></tr>';
      return;
    }
    const now = Date.now();
    for (const acc of accountList) {
      const tr = document.createElement("tr");
      tr.dataset.enabled = acc.enabled ? "true" : "false";

      // 1. 启用开关列
      const tdToggle = document.createElement("td");
      const swLabel = document.createElement("label");
      swLabel.className = "switch";
      swLabel.title = acc.enabled ? "点击停用此账号（移出多开调度池）" : "点击开启此账号（加入多开调度池）";
      const swInput = document.createElement("input");
      swInput.type = "checkbox";
      swInput.checked = Boolean(acc.enabled);
      swInput.disabled = !acc.configured && !acc.enabled;
      swInput.addEventListener("change", () => {
        const targetState = swInput.checked;
        void mutateAccount(
          { action: "toggle", id: acc.id, enabled: targetState },
          "账号 [" + acc.label + "] 已" + (targetState ? "开启并加入多开调度池。" : "停用（已移出调度池）。"),
        );
      });
      const swSlider = document.createElement("span");
      swSlider.className = "switch-slider";
      swLabel.append(swInput, swSlider);
      tdToggle.appendChild(swLabel);

      // 2. 账号名称 / VM 列
      const tdName = document.createElement("td");
      const titleRow = document.createElement("div");
      titleRow.className = "account-cell-title";
      const nameStrong = document.createElement("strong");
      nameStrong.textContent = acc.label;
      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "quiet rename-btn";
      renameBtn.title = "重命名账号";
      renameBtn.textContent = "✎";
      renameBtn.addEventListener("click", () => {
        const nextName = prompt("修改账号备注名称：", acc.label);
        if (nextName && nextName.trim() && nextName.trim() !== acc.label) {
          void mutateAccount({ action: "rename", id: acc.id, label: nextName.trim() }, "已重命名为 [" + nextName.trim() + "]。");
        }
      });
      const idPill = document.createElement("span");
      idPill.className = "account-id-pill";
      idPill.textContent = acc.id;
      titleRow.append(nameStrong, renameBtn, idPill);
      if (acc.is_default) {
        const defTag = document.createElement("span");
        defTag.className = "tag";
        defTag.dataset.tone = "accent";
        defTag.textContent = "首选兜底";
        titleRow.appendChild(defTag);
      }
      tdName.appendChild(titleRow);

      const isVmSleeping = Boolean(
        acc.configured
        && !acc.needs_login
        && acc.last_error?.stage === "websocket"
        && [502, 503, 504].includes(acc.last_error?.upstream_status),
      );

      const subParts = [];
      if (acc.vm_id) subParts.push("VM " + acc.vm_id.slice(0, 8) + "…");
      if (acc.last_error && !isVmSleeping) subParts.push("异常: " + acc.last_error.stage + "/" + acc.last_error.error);
      if (subParts.length > 0) {
        const subRow = document.createElement("div");
        subRow.className = "account-cell-sub mono";
        if (acc.vm_id) subRow.title = "VM ID: " + acc.vm_id;
        subRow.textContent = subParts.join(" · ");
        tdName.appendChild(subRow);
      }

      // 3. 健康状态列
      const tdHealth = document.createElement("td");
      const coolingSec = acc.cooldown_until && acc.cooldown_until > now ? Math.ceil((acc.cooldown_until - now) / 1000) : 0;
      if (coolingSec > 0) {
        const coolBtn = document.createElement("button");
        coolBtn.type = "button";
        coolBtn.className = "cooldown-btn";
        coolBtn.title = "点击立即解除冷却恢复调度";
        coolBtn.textContent = "⏳ 冷却 " + coolingSec + "s（点击恢复）";
        coolBtn.addEventListener("click", () => void mutateAccount({ action: "clear_cooldown", id: acc.id }, "已解除 [" + acc.label + "] 冷却状态。"));
        tdHealth.appendChild(coolBtn);
      } else {
        const stateTag = document.createElement("span");
        stateTag.className = "tag";
        if (!acc.configured) {
          stateTag.textContent = "未配置 Cookie";
        } else if (acc.needs_login) {
          stateTag.dataset.tone = "warning";
          stateTag.textContent = "⚠ 需重新登录";
        } else if (!acc.enabled) {
          stateTag.textContent = "⏸ 已停用";
        } else if (acc.ok) {
          stateTag.dataset.tone = "good";
          stateTag.textContent = "✓ 正常可用";
        } else if (isVmSleeping) {
          stateTag.dataset.tone = "good";
          stateTag.textContent = "💤 VM 休眠 (Cookie 正常)";
        } else {
          stateTag.textContent = "待验证";
        }
        tdHealth.appendChild(stateTag);
      }

      // 4. 调用统计 / 最近验证列
      const tdStat = document.createElement("td");
      const statTop = document.createElement("div");
      statTop.className = "metric-time";
      statTop.textContent = "成功 " + (acc.success_count ?? 0) + " · 失败 " + (acc.fail_count ?? 0);
      const statSub = document.createElement("div");
      statSub.className = "stat-sub metric-time";
      statSub.textContent = hasTime(acc.last_verified_at) ? ("验证于 " + stamp(acc.last_verified_at)) : "尚未验证";
      tdStat.append(statTop, statSub);

      // 5. 操作列
      const tdActions = document.createElement("td");
      tdActions.className = "col-actions";
      const actionWrap = document.createElement("div");
      actionWrap.className = "actions";

      const replaceBtn = document.createElement("button");
      replaceBtn.type = "button";
      replaceBtn.className = "primary btn-sm";
      replaceBtn.textContent = acc.configured ? "更换 Cookie" : "导入 Cookie";
      replaceBtn.addEventListener("click", () => openCookieModal("replace", acc.id));
      actionWrap.appendChild(replaceBtn);

      if (acc.configured) {
        const probeBtn = document.createElement("button");
        probeBtn.type = "button";
        probeBtn.className = "secondary btn-sm";
        probeBtn.textContent = "测活";
        probeBtn.addEventListener("click", () => {
          void runQuickAction(
            "/admin/probe-rpc",
            "正在测试 [" + acc.label + "] Noise RPC 连通性…",
            (d, ok) => ({
              text: ok
                ? "[" + acc.label + "] 测活正常（RPC 耗时 " + (d.latency_ms ?? "—") + " ms）。"
                : "[" + acc.label + "] RPC 测活失败（若为休眠账号，首次对话将唤醒）。",
              tone: ok ? "good" : "warning",
            }),
            acc.id,
          );
        });
        actionWrap.appendChild(probeBtn);

        const renewBtn = document.createElement("button");
        renewBtn.type = "button";
        renewBtn.className = "secondary btn-sm";
        renewBtn.textContent = "续期";
        renewBtn.addEventListener("click", () => {
          void runQuickAction(
            "/admin/renew",
            "正在为 [" + acc.label + "] 发起 Cookie 续期…",
            (d) => ({ text: d.ok ? "[" + acc.label + "] 续期成功。" : "[" + acc.label + "] 续期未通过。", tone: d.ok ? "good" : "warning" }),
            acc.id,
          );
        });
        actionWrap.appendChild(renewBtn);
      }

      if (!acc.is_default && acc.configured) {
        const actBtn = document.createElement("button");
        actBtn.type = "button";
        actBtn.className = "quiet btn-sm";
        actBtn.textContent = "设为首选";
        actBtn.addEventListener("click", () => void mutateAccount({ action: "activate", id: acc.id }, "已将 [" + acc.label + "] 设为首选兜底账号。"));
        actionWrap.appendChild(actBtn);
      }

      if (acc.id !== "primary-account" && !acc.is_default) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "quiet btn-sm btn-danger-quiet";
        delBtn.textContent = "删除";
        delBtn.addEventListener("click", () => void mutateAccount({ action: "delete", id: acc.id }, "已删除副账号 [" + acc.label + "]。"));
        actionWrap.appendChild(delBtn);
      }
      tdActions.appendChild(actionWrap);

      tr.append(tdToggle, tdName, tdHealth, tdStat, tdActions);
      tbody.appendChild(tr);
    }
  }

  function applyAccountsData(data) {
    defaultAccount = data.default_account || "primary-account";
    poolStrategy = data.pool_strategy || "failover";
    poolStats = data.stats || null;
    accountList = Array.isArray(data.accounts) ? data.accounts : [];
    if (!accountList.some((a) => a.id === selectedAccount)) {
      selectedAccount = defaultAccount;
    }
    renderAccountsTable();
  }

  async function loadAccounts() {
    if (!signedIn) return;
    try {
      const response = await fetch("/admin/accounts", { cache: "no-store", credentials: "same-origin" });
      if (response.status === 401) { clearStatus(); location.assign("/admin/login"); return; }
      if (!response.ok) return;
      applyAccountsData(await response.json());
    } catch { /* ignore background account poll failure */ }
  }

  async function mutateAccount(payload, successMessage) {
    if (!signedIn) { location.assign("/admin/login"); return false; }
    const out = byId("account-feedback");
    if (out) { out.hidden = false; out.textContent = "正在更新账号池…"; out.dataset.tone = ""; }
    try {
      const response = await fetch("/admin/accounts", {
        method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.status === 401) { clearStatus(); location.assign("/admin/login"); return false; }
      const data = await response.json();
      if (!response.ok) {
        const errDetail = data.last_error
          ? " [" + data.last_error.stage + ": " + data.last_error.error + (data.last_error.upstream_status ? " (" + data.last_error.upstream_status + ")" : "") + "]"
          : "";
        const msg = data.error === "cookie_not_saved" ? "新账号 Cookie 未通过 Muse 认证验证，账号未创建。" + errDetail
          : data.error === "account_already_exists" ? "该账号标识 ID 已存在，请换一个 ID。"
          : data.error === "account_cookie_not_configured" ? "请先为该账号导入有效 Cookie，再开启或设为首选。"
          : "账号池操作未成功（" + (data.error ?? response.status) + "）。" + errDetail;
        if (out) { out.hidden = false; out.textContent = msg; out.dataset.tone = "warning"; }
        setModalFeedback(msg, "warning");
        label("feedback", msg, "warning");
        void loadAccounts();
        return false;
      }
      applyAccountsData(data);
      if (payload.action === "delete" && selectedAccount === payload.id) {
        selectedAccount = defaultAccount;
        void run(false);
      } else if (payload.action === "activate") {
        selectedAccount = defaultAccount;
        void run(false);
      }
      if (out) { out.hidden = true; out.textContent = ""; }
      if (payload.action === "renew_all" && Array.isArray(data.renew_result)) {
        const okCount = data.renew_result.filter((r) => r.ok).length;
        label("feedback", "全部续期完成：成功 " + okCount + " / " + data.renew_result.length + " 个已开启账号。", okCount === data.renew_result.length ? "good" : "warning");
      } else {
        label("feedback", successMessage, "good");
      }
      return true;
    } catch {
      const errText = "账号池操作网络异常，请稍后重试。";
      if (out) { out.hidden = false; out.textContent = errText; out.dataset.tone = "warning"; }
      setModalFeedback(errText, "warning");
      return false;
    }
  }

  initModalAndPreview();
  void loadPublicChannels();
  void loadPublicCookie();
  if (signedIn) { void loadAccounts(); void run(false); }
`;
