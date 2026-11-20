# Muse 桥凭证导出浏览器扩展（JSON 版 · 兼容 Chrome / Edge / Firefox）

本扩展用于一键读取并复制/导出包含 `HttpOnly` Cookie 在内的全套 JSON 格式凭证。

- `muse.ai` 的登录会话 Cookie 带有 `HttpOnly` 标记，页面内 JS（`document.cookie`）无法直接读取。
- 本扩展通过 WebExtensions 原生 `cookies` API 从浏览器底层读取完整有效 Cookie（自动剔除过期项、优先根路径），并优先在已打开的 `muse.ai` 标签页（若未打开标签页则自动回退由扩展直接同源请求）换取 `vm_id` 与 `access_token` / `hatch_token`。
- 所有**复制**和**导出**操作统一采用标准 JSON 格式：
  1. `cookies.json`：主力凭证（同时包含单行 `cookie` 请求头、`cookies` 键值映射字典与完整属性数组 `items`，可直接粘贴到 CF Worker `/admin` 后台）
  2. `vm_id.json`：虚拟机标识与 WebSocket 地址
  3. `token.json`：回退 Token 凭证（`access_token`、`hatch_token`、签发与过期时间）
  4. `muse-credentials.json`：全量聚合 JSON（一键复制或导出上述全部字段）

---

## 一、 安装方法

扩展源码目录：`muse-cookice-extension/`

### 1. Google Chrome / Microsoft Edge

1. 打开 `chrome://extensions/`（或 `edge://extensions/`）。
2. 开启 **开发者模式（Developer mode）**。
3. 点击 **加载已解压的扩展程序（Load unpacked）**，选择本仓库下的 `muse-cookice-extension` 目录。

### 2. Mozilla Firefox

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 点击 **临时载入附加组件（Load Temporary Add-on...）**，选择 `muse-cookice-extension/manifest.json`。

---

## 二、 使用步骤

1. 在浏览器中登录 <https://muse.ai>。
2. 点击浏览器工具栏中的 **Muse Bridge Credential Exporter** 图标。
3. 弹窗会自动读取 Cookie、`vm_id` 与 Token，支持：
   - **直接复制到 CF Worker `/admin` 管理台**：点击 `cookies.json` 或 `muse-credentials.json` 的 **「📋 复制 JSON」**，直接粘贴到 `/admin` 页面的「新 Cookie」输入框并点击「验证并保存」。
   - **导出 JSON 文件**：点击对应卡片的 **「💾 导出 *.json」** 或底部的 **「💾 导出全部 JSON」** 保存为本地 `.json` 文件。
