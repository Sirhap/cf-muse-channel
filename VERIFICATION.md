# 验证记录 · 2026-11-15

## 此次仓库替换

原 `43ea75f` 的网页、MCP、DO 消息房间和 hook 接入器已按用户要求由 Cookie 连接版替换，Git 历史保留。参考旧版复用了密钥哈希比较、未知提交不重跑、稳定回执和结果查询的设计。

本次版本新增了限定长度的密钥哈希校验、原子回执写回、`result` 只读查询命令，以及 Worker 自动 Cookie 轮换、SQLite 持久化和每日续期。它不恢复旧协议，不部署或改动线上服务。

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

尚未接入微信或企业微信，没有网页聊天、跨回合会话绑定或长期队列；也没有做持续运行、断线自动恢复或大规模媒体测试。本次新增鉴权、只读结果查询和 Cookie 自动续期的测试为本地验证，未将当前完整版本重新部署做第二轮云端测试。

默认新 Worker 名称为 cf-muse-cookie，不覆盖旧线上 cf-muse-channel 服务和 DO 数据。新协议客户端需要使用新地址。
