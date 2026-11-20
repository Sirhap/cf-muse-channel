/**
 * Muse 桥凭证导出工具 (JSON 版) — 兼容 Chrome / Edge / Firefox (Manifest V3)
 *
 * 功能：
 * 1. 通过浏览器扩展 cookies API 读取 muse.ai 下的所有有效 Cookie（包含 HttpOnly），
 *    统一生成结构化 JSON（同时包含单行 cookie 请求头、cookies 键值映射与完整属性列表 items）。
 * 2. 优先在已打开的 muse.ai 标签页上下文中请求 /api/auth/check、/api/session、/api/hatch/token，
 *    若当前未打开标签页则自动回退由扩展直接同源携带 Cookie 请求，获取 vm_id.json 与 token.json。
 * 3. 所有单项与全量凭证的「复制」与「导出」均统一为标准 JSON 格式。
 */

const ext = typeof browser !== 'undefined' ? browser : chrome;

const state = {
  cookies: [],
  tokenObj: null,
  vmId: '',
  exportedAt: ''
};

/**
 * 将回调或 Promise 风格的 WebExtension API 统一包装为 Promise
 */
function callExtApi(fn, ...args) {
  return new Promise((resolve, reject) => {
    try {
      const maybePromise = fn(...args, (result) => {
        const lastError = ext.runtime && ext.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || String(lastError)));
        } else {
          resolve(result);
        }
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolve, reject);
      }
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * 读取 muse.ai 及其子域的所有未过期 Cookie（包含 HttpOnly）并按优先级排序
 */
async function fetchMuseCookies() {
  const byDomain = await callExtApi(ext.cookies.getAll.bind(ext.cookies), {
    domain: 'muse.ai'
  });
  const byUrl = await callExtApi(ext.cookies.getAll.bind(ext.cookies), {
    url: 'https://muse.ai/'
  });
  const nowSec = Date.now() / 1000;
  const map = new Map();
  for (const ck of [...(byDomain || []), ...(byUrl || [])]) {
    if (!ck || !ck.name) continue;
    if (ck.expirationDate && ck.expirationDate <= nowSec) continue;
    const key = `${ck.domain}|${ck.path}|${ck.name}`;
    map.set(key, ck);
  }
  return Array.from(map.values()).sort((a, b) => {
    const pathDiff = (a.path === '/' ? 0 : 1) - (b.path === '/' ? 0 : 1);
    if (pathDiff !== 0) return pathDiff;
    return a.name.localeCompare(b.name);
  });
}

/**
 * 从浏览器 Cookie 列表提取键值字典与单行 Cookie 请求头
 */
function buildCookieMapAndHeader(cookies) {
  const bestByName = new Map();
  if (Array.isArray(cookies)) {
    for (const c of cookies) {
      if (!c || !c.name || typeof c.value !== 'string' || c.value === '') continue;
      const prev = bestByName.get(c.name);
      if (!prev) {
        bestByName.set(c.name, c);
        continue;
      }
      const prevRoot = prev.path === '/' ? 1 : 0;
      const curRoot = c.path === '/' ? 1 : 0;
      if (curRoot > prevRoot) {
        bestByName.set(c.name, c);
      } else if (curRoot === prevRoot && (c.expirationDate || 0) > (prev.expirationDate || 0)) {
        bestByName.set(c.name, c);
      }
    }
  }
  const cookieMap = {};
  for (const [name, ck] of bestByName.entries()) {
    cookieMap[name] = ck.value;
  }
  const cookieHeader = Object.entries(cookieMap)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return { cookieMap, cookieHeader };
}

/**
 * 构建 cookies.json 数据对象
 */
function buildCookiesPayload() {
  const exportedAt = state.exportedAt || new Date().toISOString();
  const { cookieMap, cookieHeader } = buildCookieMapAndHeader(state.cookies);
  const items = state.cookies
    .filter((c) => c && c.name && typeof c.value === 'string' && c.value !== '')
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
      sameSite: c.sameSite || 'unspecified',
      session: Boolean(c.session),
      expirationDate: c.expirationDate ? Math.floor(c.expirationDate) : null
    }));
  return {
    vm_id: state.vmId || null,
    cookie: cookieHeader,
    cookies: cookieMap,
    items,
    count: items.length,
    http_only_count: items.filter((i) => i.httpOnly).length,
    exported_at: exportedAt
  };
}

/**
 * 构建 vm_id.json 数据对象
 */
function buildVmIdPayload() {
  const exportedAt = state.exportedAt || new Date().toISOString();
  return {
    vm_id: state.vmId || null,
    vm_address: state.vmId ? `wss://${state.vmId}.metaaivm.com/` : null,
    exported_at: exportedAt
  };
}

/**
 * 构建 token.json 数据对象
 */
function buildTokenPayload() {
  const exportedAt = state.exportedAt || new Date().toISOString();
  if (!state.tokenObj) {
    return {
      vm_id: state.vmId || null,
      access_token: null,
      hatch_token: null,
      issued_at: null,
      issued_at_local: null,
      exp: null,
      exported_at: exportedAt
    };
  }
  return {
    vm_id: state.tokenObj.vm_id || state.vmId || null,
    access_token: state.tokenObj.access_token || null,
    hatch_token: state.tokenObj.hatch_token || null,
    issued_at: state.tokenObj.issued_at || null,
    issued_at_local: state.tokenObj.issued_at_local || null,
    exp: state.tokenObj.exp ?? null,
    exported_at: exportedAt
  };
}

/**
 * 构建全量 muse-credentials.json 数据对象（同时兼容直接作为 /admin/cookie 请求体或 scripts/secrets.py 导入）
 */
function buildAllCredentialsPayload() {
  const exportedAt = state.exportedAt || new Date().toISOString();
  const cookiesPayload = buildCookiesPayload();
  const tokenPayload = buildTokenPayload();
  return {
    vm_id: state.vmId || tokenPayload.vm_id || null,
    cookie: cookiesPayload.cookie,
    cookies: cookiesPayload.cookies,
    cookie_items: cookiesPayload.items,
    token: state.tokenObj ? tokenPayload : null,
    exported_at: exportedAt
  };
}

function toJsonString(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * 在 muse.ai 页面上下文或扩展上下文中拉取 vm_id、access_token 和 hatch_token。
 * 分步捕获，即使后续 hatch/token 或 session 失败也保留已获取的字段。
 */
async function requestMuseToken(baseUrl = '') {
  const headers = { 'Content-Type': 'application/json' };
  const warnings = [];
  const parseJson = async (resp, label) => {
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${label} HTTP ${resp.status}: ${text.slice(0, 160)}`);
    }
    return resp.json();
  };

  const auth = await parseJson(
    await fetch(`${baseUrl}/api/auth/check`, {
      method: 'POST',
      headers,
      body: '',
      credentials: 'include'
    }),
    'auth/check'
  );
  const access_token = auth.access_token;
  if (!access_token) {
    throw new Error('auth/check 未返回 access_token，请确认已登录 muse.ai');
  }

  let vm_id = '';
  try {
    const sess = await parseJson(
      await fetch(`${baseUrl}/api/session`, { credentials: 'include' }),
      'session'
    );
    vm_id = sess.vm_id || '';
    if (!vm_id) {
      warnings.push('session 未返回 vm_id（VM 可能正在启动或休眠）');
    }
  } catch (err) {
    warnings.push(err.message);
  }

  let hatch_token = null;
  let issued_at = null;
  let issued_at_local = null;
  let exp = null;

  if (vm_id) {
    try {
      const ht = await parseJson(
        await fetch(`${baseUrl}/api/hatch/token`, {
          method: 'POST',
          headers: { ...headers, Authorization: 'Bearer ' + access_token },
          body: JSON.stringify({
            vmAddress: `wss://${vm_id}.metaaivm.com/`,
            vmName: vm_id
          }),
          credentials: 'include'
        }),
        'hatch/token'
      );
      hatch_token = ht.token || null;
      if (hatch_token) {
        const seg = hatch_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(atob(seg + '='.repeat((4 - (seg.length % 4)) % 4)));
        issued_at = payload.iat ? new Date(payload.iat * 1000).toISOString() : null;
        issued_at_local = payload.iat ? new Date(payload.iat * 1000).toLocaleString() : null;
        exp = payload.exp ?? null;
      } else {
        warnings.push('hatch/token 未返回 token');
      }
    } catch (err) {
      warnings.push(err.message);
    }
  }

  return {
    vm_id,
    access_token,
    hatch_token,
    issued_at,
    issued_at_local,
    exp,
    warnings
  };
}

/**
 * 优先从已打开的 muse.ai 标签页拉取 Token；若无已打开标签页则由扩展直接请求 https://muse.ai
 */
async function fetchMuseTokenResilient() {
  const tabs = await callExtApi(ext.tabs.query.bind(ext.tabs), {
    url: ['https://muse.ai/*', 'https://*.muse.ai/*']
  });
  if (tabs && tabs.length > 0) {
    const activeTab = tabs.find((t) => t.active) || tabs[0];
    try {
      const results = await callExtApi(
        ext.scripting.executeScript.bind(ext.scripting),
        {
          target: { tabId: activeTab.id },
          func: requestMuseToken,
          args: ['']
        }
      );
      if (results && results[0]) {
        if (results[0].error) {
          throw new Error(results[0].error.message || String(results[0].error));
        }
        if (results[0].result) {
          return results[0].result;
        }
      }
    } catch (_) {
      // 标签页注入失败时回退到扩展同源请求
    }
  }
  return requestMuseToken('https://muse.ai');
}

/**
 * 触发浏览器下载 JSON 文件
 */
function downloadJsonFile(filename, jsonObject) {
  const content = toJsonString(jsonObject);
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * 复制 JSON 文本到剪贴板并给出临时按钮反馈（带回退机制）
 */
async function copyJsonWithFeedback(buttonEl, jsonObject) {
  const text = toJsonString(jsonObject);
  const origText = buttonEl.textContent;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    buttonEl.textContent = '✅ 已复制 JSON';
  } catch (err) {
    setStatus(`复制失败：${err.message}`, true);
    buttonEl.textContent = '❌ 复制失败';
  }
  setTimeout(() => {
    buttonEl.textContent = origText;
  }, 1500);
}

function setStatus(message, isError = false) {
  const box = document.getElementById('status-box');
  if (!message) {
    box.classList.add('hidden');
    return;
  }
  box.textContent = message;
  box.classList.remove('hidden');
  box.classList.toggle('error', Boolean(isError));
}

function setBadge(text, kind) {
  const badge = document.getElementById('status-badge');
  badge.textContent = text;
  badge.className = `badge badge-${kind}`;
}

function maskToken(str) {
  if (!str || str.length < 12) return '***';
  return `${str.slice(0, 6)}...${str.slice(-4)} (len=${str.length})`;
}

function updateUI() {
  const cookieCount = state.cookies.length;
  const httpOnlyCount = state.cookies.filter((c) => c.httpOnly).length;
  const hasCookies = cookieCount > 0;
  const hasToken = Boolean(state.tokenObj && (state.tokenObj.access_token || state.tokenObj.hatch_token));
  const hasVmId = Boolean(state.vmId);
  const hasAny = hasCookies || hasVmId || hasToken;

  document.getElementById('cookie-stats').textContent = hasCookies
    ? `共 ${cookieCount} 项（含 ${httpOnlyCount} 个 HttpOnly）`
    : '未读取到 Cookie';

  document.getElementById('vmid-stats').textContent = hasVmId
    ? state.vmId
    : '未获取';

  document.getElementById('token-stats').textContent = hasToken
    ? (state.tokenObj.issued_at_local ? `签发于 ${state.tokenObj.issued_at_local}` : '已获取 access_token')
    : '未读取';

  document.getElementById('bundle-stats').textContent = hasAny
    ? `含 ${[hasCookies && 'cookies', hasVmId && 'vm_id', hasToken && 'token'].filter(Boolean).join(' + ')}`
    : '等待读取';

  document.getElementById('btn-dl-cookies').disabled = !hasCookies;
  document.getElementById('btn-cp-cookies').disabled = !hasCookies;
  document.getElementById('btn-dl-vmid').disabled = !hasVmId;
  document.getElementById('btn-cp-vmid').disabled = !hasVmId;
  document.getElementById('btn-dl-token').disabled = !hasToken;
  document.getElementById('btn-cp-token').disabled = !hasToken;
  document.getElementById('btn-dl-all').disabled = !hasAny;
  document.getElementById('btn-cp-all').disabled = !hasAny;

  const summaryPreview = {
    vm_id: state.vmId || null,
    cookies_count: cookieCount,
    http_only_count: httpOnlyCount,
    cookie_keys: state.cookies.map((c) => c.name),
    token: state.tokenObj
      ? {
          access_token: maskToken(state.tokenObj.access_token),
          hatch_token: maskToken(state.tokenObj.hatch_token),
          issued_at: state.tokenObj.issued_at,
          exp: state.tokenObj.exp
        }
      : null,
    exported_at: state.exportedAt || null
  };
  document.getElementById('summary-output').textContent = toJsonString(summaryPreview).trim();
}

async function refreshAll() {
  setBadge('读取中...', 'warn');
  setStatus('');
  state.exportedAt = new Date().toISOString();
  const errors = [];

  try {
    state.cookies = await fetchMuseCookies();
    if (state.cookies.length === 0) {
      errors.push('未检测到 muse.ai 的 Cookie，请先登录 https://muse.ai');
    }
  } catch (err) {
    errors.push(`读取 Cookie 失败：${err.message}`);
  }

  try {
    const tokenObj = await fetchMuseTokenResilient();
    state.tokenObj = tokenObj;
    state.vmId = tokenObj.vm_id || '';
    if (Array.isArray(tokenObj.warnings) && tokenObj.warnings.length > 0) {
      errors.push(...tokenObj.warnings);
    }
  } catch (err) {
    errors.push(`拉取 Token/vm_id 提示：${err.message}`);
  }

  updateUI();

  if (state.cookies.length > 0 && state.tokenObj && state.tokenObj.hatch_token) {
    setBadge('就绪', 'ok');
    setStatus('✅ 已成功读取完整 JSON 凭证（cookies.json、vm_id.json、token.json）');
  } else if (state.cookies.length > 0) {
    setBadge('Cookie 就绪', 'warn');
    setStatus(errors.join('；') || '已读取 Cookie JSON', false);
  } else {
    setBadge('未就绪', 'err');
    setStatus(errors.join('；'), true);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-fetch').addEventListener('click', refreshAll);

  document.getElementById('btn-dl-cookies').addEventListener('click', () => {
    downloadJsonFile('cookies.json', buildCookiesPayload());
  });
  document.getElementById('btn-cp-cookies').addEventListener('click', (e) => {
    copyJsonWithFeedback(e.currentTarget, buildCookiesPayload());
  });

  document.getElementById('btn-dl-vmid').addEventListener('click', () => {
    downloadJsonFile('vm_id.json', buildVmIdPayload());
  });
  document.getElementById('btn-cp-vmid').addEventListener('click', (e) => {
    copyJsonWithFeedback(e.currentTarget, buildVmIdPayload());
  });

  document.getElementById('btn-dl-token').addEventListener('click', () => {
    downloadJsonFile('token.json', buildTokenPayload());
  });
  document.getElementById('btn-cp-token').addEventListener('click', (e) => {
    copyJsonWithFeedback(e.currentTarget, buildTokenPayload());
  });

  document.getElementById('btn-dl-all').addEventListener('click', () => {
    downloadJsonFile('muse-credentials.json', buildAllCredentialsPayload());
  });
  document.getElementById('btn-cp-all').addEventListener('click', (e) => {
    copyJsonWithFeedback(e.currentTarget, buildAllCredentialsPayload());
  });

  refreshAll();
});
