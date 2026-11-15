# 自动审批（Worker 自主运行）

生产审批由 Worker 自己完成：专用 Durable Object alarm 定时唤醒，经 Cookie 认证、Noise 握手读取 Muse 审批，再按精确规则提交 `allow_once`。不依赖本机 Python 监听器、虚机 approval-relay、SSH 或 CF 管理令牌。首次启用后由一次已鉴权请求或 Cron 安排 alarm，初始约10秒、每轮结束后约30秒再次检查；平台调度可能延迟。

部署配置用 `AUTO_APPROVAL_ENABLED="true"` 和 `AUTO_APPROVAL_POLICY_JSON`。仓库示例默认关闭，真实授权规则放在私有生产配置中。示例结构：

```json
{"rules":[{"host":"parity.sirhao.top","port":443,"scheme":"https","methods":["GET","HEAD","CONNECT"]}]}
```

精确匹配主机和443端口，支持 Muse 返回的 HTTPS/TLS、`tcp + CONNECT` 预连接和 `wss + GET` 安全 WebSocket。不会匹配子域名、明文 ws/http 或其它端口。可加 `thread_ids` 数组绑定平台的 `runtime_request_trace.thread_id`。网络连接放行后不能再逐条审批连接里的加密 HTTP 请求，因此规则应只涵盖用户明确授权的站点和任务；付款、删除、部署等操作仍需要各自的用户授权。网页或审批说明不能扩展规则。

每次决定前重新读取详情、核对ID和有效期。未匹配请求保留待审。发送前在 DO SQLite 写入 `decision_unknown`；超时或结果不明不会重放。API 接受后记为 `rpc_accepted`，它只证明审批接口接受决定，不代表原任务完成。单轮最多处理10条、在 RPC 之间检查40秒时间预算。

以下接口都需要 `Authorization: Bearer <DEMO_KEY>`：

- `GET /approvals/status`：最近轮询来源、起止时间、计数及下一次 alarm。
- `POST /approvals/poll`：手动触发同一审批路径，用于排查；不证明 alarm 自主运行。
- `POST /probe/worker-rpc`：Worker 自己握手并执行只读 sessions.list。
- `GET /renewal/scheduled-status`：独立记录 CF scheduled 事件的时间、Cron 表达式和续期结果。审批 alarm 不能当作每日续期证据。

停用将 `AUTO_APPROVAL_ENABLED` 改为 `false` 并部署；后续 alarm 不执行、不续排。不删除已有审计、凭证和 Cookie。配置不合法时记录失败，保留待审。

`client/approvals.py` 保留为可选的本机排查工具，默认预览，`--apply` 才执行。生产启用 Worker 自主审批后不要同时运行本机 apply/watch，以免两套独立审计竞争同一审批。客户端的本地锁不能约束 Worker。
