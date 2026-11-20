export const adminStyles = `
  :root {
    color-scheme: light;
    --paper: #f6f1eb;
    --panel: #fbf7f2;
    --ink: #251823;
    --muted: #6c6064;
    --line: #d6cbc2;
    --sidebar: #241623;
    --coral: #b6422b;
    --green: #336220;
    --warning: #924221;
    --serif: Georgia, "Songti SC", "Noto Serif CJK SC", "SimSun", serif;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  }
  *, *::before, *::after { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; background: var(--paper); color: var(--ink); }
  p, h1, h2 { margin: 0; }
  .shell { min-height: 100vh; display: grid; grid-template-columns: clamp(210px, 17vw, 256px) minmax(0, 1fr); }
  .icon { width: 1.2em; height: 1.2em; flex: none; vertical-align: -.2em; pointer-events: none; }
  .sidebar {
    position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; padding: 26px 18px;
    background: var(--sidebar); color: #f9ede4;
  }
  .brand { display: flex; align-items: center; gap: 11px; padding-inline: 6px; font: 700 clamp(21px, 2vw, 28px)/1.1 var(--serif); white-space: nowrap; letter-spacing: -.02em; }
  .brand .icon { color: #f68370; width: 1.3em; height: 1.3em; }
  .sidebar-label { color: #cbb7c0; margin: 38px 0 12px 10px; font-size: 11px; letter-spacing: .22em; text-transform: uppercase; }
  nav { display: grid; gap: 6px; }
  nav a {
    display: flex; align-items: center; gap: 10px; padding: 11px 13px; color: inherit; text-decoration: none;
    border-left: 4px solid transparent; border-radius: 7px; font-weight: 600; opacity: .84; transition: background .15s, opacity .15s;
  }
  nav a:hover { background: rgba(255, 255, 255, .07); opacity: 1; }
  nav a[aria-current="page"] { background: #482733; border-left-color: #f47d69; opacity: 1; }
  nav a .icon { color: #f8a18e; }
  .sidebar-footer { display: flex; align-items: center; gap: 9px; margin: auto 0 0 6px; color: #e6d6d0; font-size: 13px; }
  .main { width: 100%; max-width: 1420px; min-width: 0; margin-inline: auto; padding: 0 clamp(20px, 2.8vw, 40px); }
  .topbar { min-height: 58px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .account-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .account-actions form { margin: 0; }
  .login-link, .login-prompt a, .back-link { color: var(--coral); text-underline-offset: 4px; font-weight: 600; }
  .link-btn { text-decoration: none; display: inline-flex; align-items: center; }
  fieldset { margin: 0; padding: 0; border: 0; min-width: 0; }
  fieldset:disabled { opacity: .55; }
  .login-prompt { margin-top: 14px; padding: 12px 14px; background: #f2eae2; border-radius: 8px; font-size: 14px; }
  .login-page { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--sidebar); }
  .login-card { width: min(100%, 420px); background: var(--paper); padding: 34px; border-radius: 16px; box-shadow: 0 18px 48px rgba(0, 0, 0, .26); }
  .login-card .brand { margin-bottom: 28px; padding: 0; }
  .login-card .brand .icon { color: var(--coral); }
  .login-card h1 { font-size: 28px; }
  .login-card p { color: var(--muted); margin-top: 8px; }
  .login-card form { margin-top: 24px; }
  .login-card button { width: 100%; justify-content: center; }
  .login-card .login-error { color: var(--warning); margin-bottom: 14px; font-size: 13px; }
  .back-link { display: inline-block; margin-top: 20px; font-size: 13px; }
  .breadcrumb { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 13px; }
  .breadcrumb strong { color: var(--ink); }
  .environment { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border: 1px solid #a5b5b2; border-radius: 999px; color: var(--green); background: #ebf0e2; font-size: 12px; font-weight: 650; white-space: nowrap; }
  .environment span { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .heading { padding: 22px 0 18px; }
  .heading-bar { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 14px 20px; }
  .heading-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .heading-with-badge { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  h1, h2 { font-family: var(--serif); line-height: 1.2; letter-spacing: -.02em; }
  h1 { font-size: clamp(26px, 2.6vw, 36px); }
  h2 { font-size: clamp(18px, 1.55vw, 22px); }
  .heading p { margin-top: 6px; color: var(--muted); font-size: 14px; }
  .metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 18px; }
  .panel { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); box-shadow: 0 1px 3px rgba(37, 24, 35, .03); }
  .metric { padding: 16px 18px 14px; min-width: 0; display: flex; flex-direction: column; justify-content: space-between; }
  .metric-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .metric-label { font-weight: 650; font-size: 13.5px; color: var(--muted); }
  .metric-value { display: flex; align-items: center; gap: 9px; min-height: 1.3em; margin: 8px 0 4px; font: 700 clamp(22px, 2.2vw, 30px)/1.2 var(--serif); }
  .approval-metric-val { font-size: clamp(20px, 1.9vw, 26px); }
  .approval-metric-val .icon { width: 1.05em; height: 1.05em; color: var(--coral); }
  .metric-time { font-variant-numeric: tabular-nums lining-nums; }
  .metric-note, .muted { color: var(--muted); font-size: 12.5px; }
  .metric-note { min-height: 1.4em; }
  .health-icon { border-radius: 50%; background: #dce8ce; color: var(--green); display: grid; place-items: center; width: .95em; height: .95em; }
  .health-icon .icon { width: .62em; height: .62em; stroke-width: 3px; }
  .editor, .overview { padding: 20px 22px; min-width: 0; }
  .panel-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; }
  .panel-heading p { margin-top: 4px; color: var(--muted); }
  form { margin-top: 14px; }
  label { display: block; margin-bottom: 5px; font-size: 13px; font-weight: 650; }
  input, textarea, select {
    display: block; width: 100%; color: var(--ink); background: #fffcf9; padding: 9px 11px;
    border: 1px solid #b5a89f; border-radius: 8px; font: inherit; font-size: 14px;
  }
  input, select { margin-bottom: 12px; }
  textarea { min-height: 120px; resize: vertical; line-height: 1.6; }
  .current-cookie { padding: 8px 12px; margin-bottom: 12px; background: #f2ebe4; border: 1px solid #dfd4ca; border-radius: 8px; }
  .current-cookie-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .current-cookie-bar label { margin: 0 auto 0 0; font-size: 12.5px; }
  #current-cookie { margin-top: 8px; min-height: 68px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; font-size: 12px; }
  ::placeholder { color: #877b7b; opacity: 1; }
  :focus-visible { outline: 2px solid #b6422b; outline-offset: 2px; }
  .sidebar :focus-visible { outline-color: #f9b7a8; }
  #hint { display: block; margin-top: 6px; font-size: 12px; color: var(--muted); }
  code { font-size: .94em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; border-radius: 7px; padding: 6px 14px; font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; transition: background .15s, border-color .15s, color .15s; white-space: nowrap; }
  .primary { background: var(--coral); color: #fff7ef; border: 1px solid var(--coral); }
  .primary:hover:not(:disabled) { background: #983623; border-color: #983623; }
  .secondary { background: #fffcf8; border: 1px solid #b5a79e; color: var(--ink); }
  .quiet { background: transparent; border: 1px solid transparent; color: var(--muted); padding-inline: 8px; }
  .quiet:hover:not(:disabled), .secondary:hover:not(:disabled) { color: var(--ink); background: #eee3db; }
  button:disabled { opacity: .55; cursor: not-allowed; }
  #feedback { display: block; font-size: 13px; white-space: pre-line; overflow-wrap: anywhere; }
  #feedback:not(:empty) { margin-top: 12px; padding: 9px 12px; border-left: 3px solid currentColor; background: #f2ebe4; border-radius: 6px; }
  .relay-mark { color: #c45038; font-size: 22px; line-height: 1; }
  .channels { list-style: none; padding: 0; margin: 10px 0 0; }
  .channels li { display: grid; grid-template-columns: 28px 1fr auto; align-items: center; gap: 11px; min-height: 54px; font-weight: 650; padding: 8px 12px; }
  .channels-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
  .channels-grid li { border: 1px solid #ded3c9; border-radius: 10px; background: #fffcf8; padding: 12px 15px; }
  .channels .icon { width: 25px; height: 25px; }
  .tag { display: inline-flex; align-items: center; background: #ece5dd; color: #524246; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .channel-detail { display: block; font-size: 12px; font-weight: 400; color: var(--muted); margin-top: 2px; }
  .tag[data-tone="good"] { background: #dce8ce; color: var(--green); }
  .tag[data-tone="warning"] { background: #f3e2d7; color: var(--warning); }
  .tag[data-tone="accent"] { background: #fae4dc; color: var(--coral); }
  [data-tone="good"] { color: var(--green); }
  [data-tone="warning"] { color: var(--warning); }
  .footer { border-top: 1px solid var(--line); margin: 22px 0 14px; padding: 12px 0; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 12px; color: var(--muted); font-size: 12px; }
  .footer span:first-child { display: inline-flex; align-items: center; gap: 6px; }
  .metrics-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 18px; }
  .section-block { margin-bottom: 18px; }
  .chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 6px; background: #eee6de; font-size: 12px; font-weight: 600; }

  /* 账号池工具栏与开关（参考 muse2api） */
  .pool-toolbar { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 14px 18px; }
  .pool-title-group { min-width: 260px; flex: 1; }
  .pool-title-group p { margin-top: 5px; color: var(--muted); }
  .pool-stats-pills { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .pool-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .strategy-picker {
    display: inline-flex; align-items: center; gap: 7px; margin: 0;
    padding: 3px 6px 3px 10px; border: 1px solid #b5a79e; border-radius: 7px;
    background: #fffcf8; font-size: 12px; font-weight: 650; color: var(--muted);
  }
  .strategy-picker select {
    width: auto; margin: 0; padding: 3px 6px; border: 0; background: transparent;
    font-size: 12.5px; font-weight: 650; color: var(--ink); cursor: pointer;
  }
  .strategy-picker select:focus { outline: none; }

  .table-wrap { overflow-x: auto; margin-top: 14px; border: 1px solid #ded4ca; border-radius: 10px; background: #fffcf8; }
  .data-table { width: 100%; border-collapse: collapse; font-size: 13.5px; text-align: left; }
  .data-table th, .data-table td { padding: 12px 14px; border-bottom: 1px solid #e6ddd4; vertical-align: middle; }
  .data-table th { background: #f4ede5; color: var(--muted); font-weight: 650; font-size: 12px; white-space: nowrap; }
  .data-table tr:last-child td { border-bottom: 0; }
  .data-table tr[data-enabled="false"] { background: #f8f4ef; opacity: .78; }
  .data-table .col-toggle { width: 68px; text-align: center; }
  .data-table td:first-child { text-align: center; }
  .data-table .col-actions { text-align: right; }
  .data-table td:last-child .actions { justify-content: flex-end; }
  .account-cell-title { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .account-cell-sub { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; font-size: 11.5px; color: var(--muted); }
  .account-id-pill { padding: 1px 7px; border-radius: 5px; background: #efe8e0; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .rename-btn { min-height: 22px; padding: 0 5px; font-size: 11px; color: var(--muted); border-radius: 4px; }
  .rename-btn:hover { background: #eee3db; color: var(--ink); }
  .stat-sub { font-size: 11.5px; color: var(--muted); margin-top: 2px; }
  .cooldown-btn { border: 0; background: #f3e2d7; color: var(--warning); padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; min-height: 24px; cursor: pointer; }
  .cooldown-btn:hover { background: #ead2c3; }

  /* 开关 Switch */
  .switch { position: relative; display: inline-block; width: 40px; height: 22px; margin: 0; vertical-align: middle; cursor: pointer; }
  .switch input { opacity: 0; width: 0; height: 0; position: absolute; margin: 0; }
  .switch-slider {
    position: absolute; inset: 0; border-radius: 999px; background: #cbc0b7;
    transition: background .18s;
  }
  .switch-slider::before {
    content: ""; position: absolute; left: 3px; top: 3px; width: 16px; height: 16px;
    border-radius: 50%; background: #fffcf8; box-shadow: 0 1px 3px rgba(0, 0, 0, .2);
    transition: transform .18s;
  }
  .switch input:checked + .switch-slider { background: var(--green); }
  .switch input:checked + .switch-slider::before { transform: translateX(18px); }
  .switch input:disabled + .switch-slider { opacity: .45; cursor: not-allowed; }
  .switch input:focus-visible + .switch-slider { outline: 2px solid var(--coral); outline-offset: 2px; }

  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .btn-sm { min-height: 30px; padding: 4px 10px; font-size: 12px; border-radius: 6px; }
  .btn-danger-quiet:hover:not(:disabled) { color: #b42318; background: #fbeae8; }
  .status-banner { margin-top: 12px; padding: 10px 12px; border-radius: 8px; background: #f2ebe4; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .inline-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .secret-field { position: relative; display: flex; align-items: center; margin-bottom: 12px; }
  .secret-field input { margin-bottom: 0; padding-right: 44px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .secret-eye-btn {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    min-height: 28px; width: 32px; padding: 0; border-radius: 6px;
    background: transparent; border: 1px solid transparent; color: var(--muted);
  }
  .secret-eye-btn:hover:not(:disabled) { background: #eee3db; color: var(--ink); }
  .secret-eye-btn .icon { width: 1.15em; height: 1.15em; }
  .modal-toggles-row { display: flex; flex-wrap: wrap; gap: 8px 20px; }
  label.toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; margin: 2px 0 4px; font-weight: 600; }
  label.toggle input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--coral); }
  details.config-details { margin-top: 12px; border-top: 1px dashed var(--line); padding-top: 12px; }
  details.config-details > summary { cursor: pointer; font-weight: 650; font-size: 14px; color: var(--coral); user-select: none; }

  /* 弹窗（更换 Cookie / 新增账号 / 批量导入 + 左右分栏同时预览） */
  .modal-backdrop {
    position: fixed; inset: 0; z-index: 100; display: grid; place-items: center;
    padding: 20px; background: rgba(28, 17, 26, .52); backdrop-filter: blur(3px);
  }
  .modal-dialog {
    width: min(100%, 960px); max-height: calc(100vh - 40px); overflow-y: auto;
    padding: 22px 24px; border-radius: 14px; background: var(--panel);
    box-shadow: 0 24px 64px rgba(20, 10, 18, .32); border: 1px solid #cbbdb2;
  }
  .modal-header {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding-bottom: 14px; border-bottom: 1px solid var(--line);
  }
  .modal-close { font-size: 13px; }
  .modal-account-fields {
    padding: 12px 14px; margin-bottom: 12px; border-radius: 10px;
    background: #f3ece4; border: 1px solid #dfd3c8;
  }
  .modal-split-grid {
    display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.12fr);
    gap: 16px; align-items: stretch;
  }
  .modal-input-pane, .modal-preview-pane {
    display: flex; flex-direction: column; min-width: 0;
  }
  .modal-input-pane textarea {
    flex: 1; min-height: 250px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12.5px; line-height: 1.55;
  }
  .cookie-label-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 10px; margin-bottom: 7px; min-height: 30px; }
  .cookie-label-bar label { margin-bottom: 0; }
  .cookie-quick-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
  .cookie-preview-card {
    flex: 1; display: flex; flex-direction: column; min-height: 250px;
    border: 1px solid #c9d4be; border-radius: 10px;
    background: linear-gradient(180deg, #f4f8ee 0%, #fbf7f2 100%);
    padding: 12px 14px;
  }
  .cookie-preview-card[data-empty="true"] {
    border-style: dashed; border-color: #c8bcb2;
    background: #f6efe8; justify-content: center; align-items: center; text-align: center;
  }
  .cookie-preview-empty { max-width: 350px; color: var(--muted); padding: 18px 10px; }
  .cookie-preview-empty strong { display: block; color: var(--ink); font-size: 14px; margin-bottom: 6px; }
  .cookie-preview-empty p { font-size: 12.5px; line-height: 1.55; }
  .cookie-preview-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 10px; padding-bottom: 9px; border-bottom: 1px dashed #cdd6c4; }
  .cookie-preview-title { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 650; color: var(--ink); }
  .cookie-preview-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
  .cookie-meta-chip {
    display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px;
    background: #ebe4dc; color: #3c2f34; font-size: 11.5px; font-weight: 600;
  }
  .cookie-meta-chip code { color: var(--ink); }
  .cookie-preview-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(175px, 1fr));
    gap: 7px; margin-top: 9px; max-height: 215px; overflow-y: auto; padding-right: 2px;
  }
  .cookie-item-pill {
    background: #fffcf8; border: 1px solid #dfd5cc; border-radius: 8px; padding: 7px 9px;
    display: flex; flex-direction: column; gap: 3px; min-width: 0;
  }
  .cookie-item-top { display: flex; align-items: center; justify-content: space-between; gap: 5px; }
  .cookie-item-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 700; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cookie-item-badges { display: inline-flex; align-items: center; gap: 3px; flex: none; }
  .cookie-badge { font-size: 9.5px; font-weight: 650; padding: 1px 5px; border-radius: 4px; background: #ece5de; color: #5d4f53; }
  .cookie-badge.httponly { background: #dce8ce; color: var(--green); }
  .cookie-badge.secure { background: #e5ebf3; color: #2b4c7e; }
  .cookie-item-val { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--muted); display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .cookie-item-val span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cookie-item-len { font-size: 10px; color: #8c7f82; flex: none; }
  .batch-preview-list { display: flex; flex-direction: column; gap: 7px; margin-top: 9px; max-height: 230px; overflow-y: auto; }
  .batch-preview-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-radius: 8px; background: #fffcf8; border: 1px solid #dfd5cc; font-size: 12.5px; }
  .modal-footer {
    display: flex; align-items: center; justify-content: flex-end; gap: 10px;
    margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line);
  }

  @media (max-width: 1100px) {
    .shell { grid-template-columns: 192px minmax(0, 1fr); }
    .sidebar { padding-inline: 14px; }
    .brand { font-size: 22px; }
    .editor, .overview { padding: 18px; }
    .metric { padding-inline: 15px; }
    .metrics-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 880px) {
    .shell { grid-template-columns: 1fr; }
    .sidebar { position: static; height: auto; flex-direction: row; align-items: center; justify-content: space-between; padding: 12px 16px; }
    .sidebar-label, .sidebar-footer { display: none; }
    nav { display: flex; gap: 6px; }
    nav a { padding: 7px 9px; font-size: 13px; }
    .grid-2, .inline-fields, .modal-split-grid, .channels-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 650px) {
    .main { padding-inline: 14px; }
    .topbar { min-height: 52px; }
    .heading { padding-block: 16px; }
    .metrics { grid-template-columns: 1fr; gap: 10px; margin-bottom: 14px; }
    .metric { padding: 13px 15px; }
    .footer { margin-top: 16px; }
  }
`;
