# 验证记录 · 2026-11-15

## 此次仓库替换

原 `43ea75f` 的网页、MCP、DO 消息房间和 hook 接入器已按用户要求由 Cookie 连接版替换，Git 历史保留。参考旧版复用了密钥哈希比较、未知提交不重跑、稳定回执和结果查询的设计。

本次版本新增了限定长度的密钥哈希校验、原子回执写回、`result` 只读查询命令，以及 Worker 自动 Cookie 轮换、SQLite 持久化和每日续期。替换提交不恢复旧协议，当时未部署或改动线上服务；后续获授权部署见文末记录。

- 26 项 Workers 测试通过：认证隔离、密钥边界、固定上游、Cookie 分段、错误脱敏、响应大小和二进制透传，以及续期并发、SQL 持久化、Cron 与真实 Worker/DO 路由。
- 8 项 Python 测试通过：并发防重、未知提交留回执、历史基线、只读结果恢复、凭证导入与分段无损。
- TypeScript 和 Wrangler dry-run 检查通过。已在替换后的仓库实际路径执行检查。

## 已完成的独立 CF demo 实测

站点：<https://muse-demo.sirhao.top>。以下是真实部署的独立 demo 结果，本次提交不会自动更新它。

| 阶段 | 结果 |
| --- | --- |
| CF → muse.ai | HTTP 200 |
| CF → api.muse.ai 根路径 | HTTP 404，收到服务响应 |
| CF → hatch.metaaivm.com 根路径 | HTTP 401，收到服务响应 |
| Cookie 换证 | 成功 |
| Muse WebSocket Upgrade | 成功 |
| Noise 握手与只读 sessions.list | 成功 |
| 独立侧会话测试 | 提交在历史中确认，真实收到“CF Cookie demo 连接成功。” |

最初认证返回 403。补齐固定 SDK 的请求头后，换证、WebSocket、Noise 和聊天依次通过；本机经自有服务器出口的 Cookie 认证对照也返回 200，不能把最初 403 当作 Cookie 过期。

Cookie 无损拆分后存入 CF Secrets，没有使用凭证包里的静态 token.json，也没有提交用户凭证或真实回执。

## 网络路径订正与未验证项

真实 Noise/聊天测试经临时 SSH SOCKS 通道访问 CF，通道已在测试结束后关闭；CF → Muse 始终由真实 Worker 执行。随后用户提供浏览器截图，证实从其浏览器直接访问自定义域名 `/health` 正常。此前终端的 TLS 失败不能泛化为“用户电脑访问不了”。

尚未接入微信或企业微信，没有网页聊天、跨回合会话绑定或长期队列；也没有做持续运行、断线自动恢复或大规模媒体测试。截至替换提交，新增鉴权、只读结果查询和 Cookie 自动续期仅有本地验证；后续线上验证结果见文末。

默认新 Worker 名称为 cf-muse-cookie，不覆盖旧线上 cf-muse-channel 服务和 DO 数据。新协议客户端需要使用新地址。


## 新版部署验收（2026-11-15）

用户随后明确要求部署，将提交 `a1086d2` 发布到同一测试 Worker `muse-cf-cookie-demo` 和 <https://muse-demo.sirhao.top>，保留现有 Secrets；没有修改原微信、企微服务或旧 CF 消息房间。

- 部署前版本：`1fdb6f32-4ee6-49cb-9b26-9fb7dd8d28d1`；已记录供核查，未删除。
- 新版版本：`1ffc341e-e358-41cb-a287-e258c10b28e3`。
- 健康接口返回 `service=cf-muse-channel`、`version=1.0.0`。
- 专用 `MuseCredentials` SQLite DO 已创建。
- 真实手动续期返回 `ok=true`、`needs_login=false`，`last_verified_at` 和 `last_rotated_at` 均已更新；随后状态读取保持一致，证明轮换已写入持久状态。
- 轮换后的 Cookie 换证、Muse WebSocket Upgrade 及 Noise `sessions.list` 均通过。
- 新建独立测试侧会话，仅发送一次确认消息，历史确认提交后收到真实回复：“CF 自动续期部署验证成功。”，回执状态为 succeeded；未自动重发。
- Cron 已部署为 `54 20 * * *`（UTC），对应每天北京时间 04:54。下一次为 2026-11-16 04:54；本轮未等待定时触发，仅验证了与 Cron 共用的真实续期逻辑。

本轮终端验证仍经自有服务器的临时 SSH SOCKS 出口；测试后关闭，不是 Worker 运行依赖。生产配置保存在被忽略的 `wrangler.production.jsonc`，没有提交用户凭证。

部署后的回滚需要同时考虑 DO 和 Cookie 状态：不能通过回退到旧、不保存轮换 Cookie 的逻辑来恢复已被服务端撤销的旧凭证，也不能删除凭证 DO。发生问题时先保留当前持久状态并核查错误，停止有风险的流量；需要回退时准备兼容当前 DO 绑定的代码版本。
