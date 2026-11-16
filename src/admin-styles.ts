export const adminStyles = `
  :root {
    color-scheme: light;
    --paper: #f7f1eb;
    --panel: #faf5ef;
    --ink: #271925;
    --muted: #685d60;
    --line: #cfc2b9;
    --sidebar: #261825;
    --coral: #b6422b;
    --green: #376323;
    --warning: #914322;
    --serif: Georgia, "Songti SC", "Noto Serif CJK SC", "SimSun", serif;
    font: 16px/1.55 "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  }
  *, *::before, *::after { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; background: var(--paper); color: var(--ink); }
  p, h1, h2 { margin: 0; }
  .shell { min-height: 100vh; display: grid; grid-template-columns: clamp(215px, 19vw, 290px) minmax(0, 1fr); }
  .icon { width: 1.25em; height: 1.25em; flex: none; vertical-align: -.22em; }
  .sidebar {
    position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; padding: 30px 21px;
    background: var(--sidebar); color: #f9ede4;
  }
  .brand { display: flex; align-items: center; gap: 12px; padding-inline: 6px; font: 700 clamp(23px, 2.35vw, 34px)/1.1 var(--serif); white-space: nowrap; letter-spacing: -.025em; }
  .brand .icon { color: #f68370; width: 1.35em; height: 1.35em; }
  .sidebar-label { color: #d2bfc8; margin: 47px 0 15px 12px; font-size: 12px; letter-spacing: .24em; }
  nav a {
    display: flex; align-items: center; gap: 10px; padding: 12px 14px; color: inherit; text-decoration: none;
    background: #4b2935; border-left: 5px solid #f47d69; border-radius: 6px; font-weight: 600;
  }
  nav a .icon { color: #f8a18e; }
  .sidebar-footer { display: flex; align-items: center; gap: 10px; margin: auto 0 0 7px; color: #edddd8; font-size: 14px; }
  .main { width: 100%; max-width: 1540px; min-width: 0; margin-inline: auto; padding: 0 clamp(22px, 3vw, 45px); }
  .topbar { min-height: 65px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .account-actions { display: flex; align-items: center; gap: 10px; }
  .account-actions form { margin: 0; }
  .login-link, .login-prompt a, .back-link { color: var(--coral); text-underline-offset: 4px; }
  fieldset { margin: 0; padding: 0; border: 0; min-width: 0; }
  fieldset:disabled { opacity: .55; }
  .login-prompt { margin-top: 14px; font-size: 14px; }
  .login-page { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--sidebar); }
  .login-card { width: min(100%, 440px); background: var(--paper); padding: 36px; border-radius: 16px; }
  .login-card .brand { margin-bottom: 34px; padding: 0; }
  .login-card .brand .icon { color: var(--coral); }
  .login-card h1 { font-size: 32px; }
  .login-card p { color: var(--muted); margin-top: 10px; }
  .login-card form { margin-top: 28px; }
  .login-card button { width: 100%; justify-content: center; }
  .login-card .login-error { color: var(--warning); margin-bottom: 15px; font-size: 14px; }
  .back-link { display: inline-block; margin-top: 22px; font-size: 14px; }
  .breadcrumb { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 14px; }
  .breadcrumb strong { color: var(--ink); }
  .environment { display: inline-flex; align-items: center; gap: 7px; padding: 4px 10px; border: 1px solid #9dadaa; border-radius: 5px; color: var(--green); background: #edf0e3; font-size: 12px; font-weight: 650; white-space: nowrap; }
  .environment span { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .heading { padding: 26px 0 24px; }
  h1, h2 { font-family: var(--serif); line-height: 1.15; letter-spacing: -.025em; }
  h1 { font-size: clamp(38px, 4.15vw, 62px); }
  h2 { font-size: clamp(22px, 2vw, 31px); }
  .heading p { margin-top: 8px; color: var(--muted); font-size: clamp(16px, 1.55vw, 22px); }
  .metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; margin-bottom: 24px; }
  .panel { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
  .metric { padding: 18px 21px 16px; min-width: 0; }
  .metric-label { font-weight: 650; font-size: 16px; }
  .metric-value { display: flex; align-items: center; gap: 10px; min-height: 1.35em; margin-top: 4px; font: 700 clamp(25px, 3.1vw, 46px)/1.2 var(--serif); }
  .metric-time { font-variant-numeric: tabular-nums lining-nums; }
  .metric-note, .muted { color: var(--muted); font-size: 13px; }
  .metric-note { min-height: 1.5em; }
  .health-icon { border-radius: 50%; background: #dce8ce; color: var(--green); display: grid; place-items: center; width: .96em; height: .96em; }
  .health-icon .icon { width: .62em; height: .62em; stroke-width: 3px; }
  .content-grid { display: grid; grid-template-columns: minmax(0, 1.62fr) minmax(0, 1fr); gap: 20px; align-items: stretch; }
  .editor, .overview { padding: 23px; min-width: 0; }
  .panel-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; }
  .panel-heading p { flex-basis: 100%; color: var(--muted); }
  form { margin-top: 19px; }
  label { display: block; margin-bottom: 5px; font-size: 14px; font-weight: 700; }
  input, textarea {
    display: block; width: 100%; color: var(--ink); background: #fcf7f2; padding: 10px 12px;
    border: 1px solid #a99c93; border-radius: 8px; font: inherit; font-size: 16px;
  }
  input { margin-bottom: 15px; }
  textarea { min-height: 126px; resize: vertical; line-height: 1.65; }
  .current-cookie { padding: 7px 11px; margin-bottom: 15px; background: #f2ebe4; border-radius: 8px; }
  .current-cookie-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
  .current-cookie-bar label { margin: 0 auto 0 0; }
  #current-cookie { min-height: 80px; font-family: ui-monospace, monospace; overflow-wrap: anywhere; font-size: 13px; }
  ::placeholder { color: #766b6b; opacity: 1; }
  :focus-visible { outline: 2px solid #b6422b; outline-offset: 3px; }
  .sidebar :focus-visible { outline-color: #f9b7a8; }
  #hint { display: block; margin-top: 5px; font-size: 12px; color: var(--muted); }
  code { font-size: .96em; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin-top: 17px; }
  button { display: inline-flex; align-items: center; gap: 6px; min-height: 42px; border-radius: 7px; padding: 8px 15px; font: inherit; font-size: 14px; font-weight: 650; cursor: pointer; }
  .primary { background: var(--coral); color: #fff7ef; border: 1px solid var(--coral); padding-inline: 22px; }
  .primary:hover { background: #983623; }
  .secondary { background: transparent; border: 1px solid #a99c93; color: var(--ink); }
  .quiet { background: transparent; border: 1px solid transparent; color: var(--muted); padding-inline: 8px; }
  .quiet:hover, .secondary:hover { color: var(--ink); background: #eee3db; }
  button:disabled { opacity: .6; cursor: wait; }
  #feedback { display: block; font-size: 13px; white-space: pre-line; overflow-wrap: anywhere; }
  #feedback:not(:empty) { margin-top: 11px; padding: 8px 10px; border-left: 3px solid currentColor; background: #f2ebe4; border-radius: 3px; }
  .side-panels { display: grid; grid-template-rows: auto 1fr; gap: 16px; min-width: 0; }
  .relay-mark { color: #c45038; font-size: 25px; line-height: 1; }
  .channels { list-style: none; padding: 0; margin: 8px 0 10px; }
  .channels li { display: grid; grid-template-columns: 29px 1fr auto; align-items: center; gap: 10px; min-height: 59px; font-weight: 650; }
  .channels li + li { border-top: 1px solid var(--line); }
  .channels .icon { width: 27px; height: 27px; }
  .tag { background: #ece6de; color: #544448; padding: 2px 9px; border-radius: 20px; font-size: 12px; white-space: nowrap; }
  .channel-detail { display: block; font-size: 12px; font-weight: 400; color: var(--muted); }
  .tag[data-tone="good"] { background: #dce8ce; color: var(--green); }
  .tag[data-tone="warning"] { background: #f3e2d7; color: var(--warning); }
  .approval-state { display: flex; align-items: center; gap: 9px; font-size: 20px; margin: 13px 0 4px; }
  [data-tone="good"] { color: var(--green); }
  [data-tone="warning"] { color: var(--warning); }
  .footer { border-top: 1px solid var(--line); margin: 24px 0 14px; padding: 10px 0; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 12px; color: var(--muted); font-size: 12px; }
  .footer span:first-child { display: inline-flex; align-items: center; gap: 6px; }
  @media (max-width: 1100px) {
    .shell { grid-template-columns: 192px minmax(0, 1fr); }
    .sidebar { padding-inline: 14px; }
    .brand { font-size: 23px; }
    .editor, .overview { padding: 18px; }
    .metric { padding-inline: 15px; }
  }
  @media (max-width: 880px) {
    .shell { grid-template-columns: 1fr; }
    .sidebar { position: static; height: auto; flex-direction: row; align-items: center; justify-content: space-between; padding: 12px 16px; }
    .sidebar-label, .sidebar-footer { display: none; }
    nav a { padding: 7px 9px; font-size: 13px; }
  }
  @media (max-width: 650px) {
    .main { padding-inline: 14px; }
    .topbar { min-height: 53px; }
    .heading { padding-block: 20px; }
    .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; margin-bottom: 14px; }
    .metric:first-child { grid-column: 1 / -1; }
    .metric { padding: 11px 13px; }
    .metric-value { font-size: 29px; }
    .content-grid { grid-template-columns: 1fr; gap: 14px; }
    .side-panels { gap: 14px; }
    .footer { margin-top: 17px; }
  }
`;
