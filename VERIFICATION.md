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

## 扩充全面测试（2026-11-15）

后续将自动化测试从 34 项扩充至 142 项（91 Workers/DO + 48 Python + 3 完整运行时重启/Cron），并完成 17 项真实线上检查。新增测试复现并修复了 Cookie 解析、凭证原子写入、URL/历史校验、回复聚合与错误脱敏问题。详细矩阵和首轮回显文案导致的失败记录见 [TESTING.md](TESTING.md)。本轮修复未自动部署，线上结果仍对应上一节的部署版本。

## Worker 自主审批与真实 Cron（2026-11-16）

本轮把审批移入 Worker：WebCrypto/Noise RPC、DO alarm、SQLite 决策审计共同运行，不依赖本机审批监听器。生产部署在原 `muse-cf-cookie-demo`，自定义域名不变；保留现有 Secrets 和已轮换 Cookie。

- 最新部署版本：`38ac307d-fa51-494b-8e70-63915e10eea6`（补上后台服务的 connect/CONNECT 审批形式）；POST 规则部署版本为 `97595978-5137-45e0-bc39-0d73a9c6069a`；WSS 自主审批首次验证版本为 `dc35a326-7993-4001-acd6-80135a9dd5b3`。
- `POST /probe/worker-rpc` 在生产返回200、`stage=worker_owned_noise_rpc`，由 Worker 自己执行真实 sessions.list。
- 接入任务访问 `muse-demo.sirhao.top:443` 时，实际审批形态为 `scheme=wss, method=GET`；补上该安全 WebSocket 匹配后，DO 自主 alarm 记录 `pending=1, approved=1, unknown=0`，来源为 `durable_object_alarm`。
- 后续两条自有 CF 域名的 HTTPS POST 也由 Worker 自主批准，SQLite 累计 `rpc_accepted=3`，当前待审为0；逐条独立查询 Muse 均为 `approved/allow_once`。
- 独立只读查询 Muse 审批详情确认 `status=approved, decision=allow_once`。没有调用本机 apply/watch 或手动 `/approvals/poll` 完成这一条决定。后续 alarm 继续自动推进。
- 生产规则限已授权的 `parity.sirhao.top`、`catfk.com`、`muse-demo.sirhao.top` 的443安全连接；仅自有 CF 域名额外允许已授权探测接口需要的 POST，普通站点不允许 POST。其它目标保留待审，没有永久放行。
- 临时增加一分钟 Cron，Cloudflare 真正触发 scheduled 并成功续期；审计保留 `cron="* * * * *"`、scheduled_time 和 `result.ok=true`。该临时 Cron 已删除，最终部署只保留 `54 20 * * *`。
- 每日北京时间04:54的首次实际触发在本次核对时尚未到来，不能宣布每日触发已验收。之后需读取 `/renewal/scheduled-status`，确认 `last_event.cron="54 20 * * *"`、预期日期的 scheduled_time 及 `result.ok=true`；手动 refresh、审批 alarm 和临时分钟 Cron 都不能替代这一证据。
- 自动化：102项 Workers/DO、72项 Python、3项完整运行时重启/Cron，共177项通过，TypeScript通过。新增测试包含 Python/Worker Noise双向互通、握手篡改拒绝、WSS规则、未知决定不重放、真实scheduled来源审计、私有渠道配置和最小补丁。

微信/企微本轮部署状态和真实手机收发证据另行记录；Worker RPC与审批通过不代表渠道收发已经完成。新增适配器不修改原任务状态机，见 [CHANNEL_INTEGRATION.md](CHANNEL_INTEGRATION.md)。

## 微信、企微切换（2026-11-16 01:11 CST）

虚机初次验证发现旧 SDK 0.3.2 不支持 route 参数且缺少分片重组，CF 早返回又跳过了 SDK 路径准备；旧 curl_cffi 默认 HTTP/2 时还会出现101后 Invalid active socket。已补 SDK 准备、固定 muse-cli 0.3.10，并显式使用 HTTP/1.1；没有禁用 TLS 校验。

- 虚机干净服务环境的 staged RPC 29.0秒、实际生产 native_bridge.connect 路径21.4秒，均完成 sessions.list、正常关闭。
- 原 native_bridge.py 仅新增12行 CF 分支；独立文件读取确认生产源码 SHA256 为 `16f25713a7cf23f0b2a0265ad58f042a26da28d55a1525025799a1deb31becf1`，与执行报告一致。
- 两个工作区 unit 和已安装 unit 设置 CF 私有配置路径、适配器路径、固定 SDK 路径；执行端校验 render_unit 一致，完成 daemon-reload 和仅两个执行服务的重启。独立读取工作区 unit 确认 CF 环境配置已写入。
- 微信仍 legacy、企微仍 core（gadget关闭、hook备用开启）；无在途核查后在路由锁内解除微信fallback，独立 stat 返回404。新版 daemon status 的PID和更新时间与切换报告一致。
- 新后台请求实际是 `scheme=connect, method=CONNECT, port=443`，没有thread_id；补上这个443隧道形式后 DO alarm 自主记录 approved=1、unknown=0，累计rpc_accepted=11。精确主机限制和可选任务绑定不变。
- 真实手机新入站和正式发送回执另行验收；配置/RPC成功不代表这一步已通过。

## 手机首轮验收与微信恢复（2026-11-16）

- 企微01:17:07的新测试入站生成Core任务51，走native/CF执行，01:17:25确认提交，01:17:57 succeeded并投递delivered，hook交接0条。核对live sender实现：Core直接send_frame(wait_response=True)，平台errcode=0才记delivered；不经过legacy outbox，因此旧results文件没有新行是预期行为。
- 微信首轮未通过CF验收：后台在CONNECT规则补齐前发生三次75秒超时并耗尽，消息在01:16:57进入hook备用，01:21:09正式回复ok=true，不能据此宣称CF通过。旧消息未重放。
- 修复生效后微信服务环境的两次新连接RPC成功（20.8秒、34.4秒）。01:25:12期间平台更换过虚机，自愈恢复了CF三变量和相同源码，耗尽预算随进程重启解除；无需再次重启。
- 01:31:26在路由锁内复查旧任务已终态后解除微信fallback。后台跟踪75秒无新连接超时，心跳推进；服务器对已失效的旧会话返回结构化404，程序按设计作废旧会话、等待下一条真实消息新建。锁存未重现、exhausted=false。
- 微信仍需新入站验证新会话创建、CF执行和正式发送回执；不能用首轮hook回复或只读RPC替代。
