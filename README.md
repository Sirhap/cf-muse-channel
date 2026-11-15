# CF Muse Channel · Cookie 连接版

这个仓库现提供 CF Cookie 中转和 Python 验证客户端，替换原来的网页聊天、Durable Object 房间、MCP 与 hook 接入器实现。旧代码保留在 Git 历史中，替换前基线为 `43ea75f`。

```text
Python 客户端 ── HTTPS / WSS ── CF Worker ── Cookie 换证 / WSS ── Muse
       └──────────────── Noise 加密协议 ────────────────────────┘
```

CF 负责 Cookie 认证、WebSocket 中转和自主网络审批，Python 客户端处理渠道连接、会话与结果查询。Cookie 放在 CF Secret，客户端使用独立 `DEMO_KEY`，只连接配置好的 Worker。

当前版本提供微信、企业微信的连接适配器和最小接入补丁，见 [CHANNEL_INTEGRATION.md](CHANNEL_INTEGRATION.md)；实际部署与手机收发验收分别记录，不包含聊天网页。Worker 会接收服务端返回的新 Cookie，并自动续期；会话被服务端撤销或已失效时仍需重新登录导入。长连接断开或结果未知时不会自动重发任务。

## 快速开始

需要 Node.js 22+、Python 3.12+，以及你自己的 Muse 凭证。依赖固定版本，协议 SDK 固定到 Git 提交。

```sh
npm ci
cp .dev.vars.example .dev.vars
python3 -m venv .venv
.venv/bin/python -m pip install -r client/requirements.txt
```

导入凭证包，只读取 `cookies.txt`、`vm_id.txt`：

```sh
python3 scripts/secrets.py import /absolute/path/muse-credentials.zip
```

导入器在 `.dev.vars` 中生成独立随机 `DEMO_KEY`，已有密钥则保留；长 Cookie 无损拆成两个 Secret，文件权限设为 0600。静态 `token.json` 不使用，ZIP 中的其它内容不执行、不读取。

也可以编辑 `.dev.vars`：`DEMO_KEY` 为 32–512 字符且不含空白，`MUSE_COOKIE` 为 `a=b; c=d` 请求头字符串，`MUSE_VM_ID` 可留空自动查询。分段 Cookie 优先于单段 Cookie。不要把真实凭证写入源码、URL 或聊天记录。

```sh
npx wrangler types --env-file .dev.vars.example
npm run check
npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
npm run build
npm run dev
```

完整自动化回归使用 `npm run test:all`（当前 174 项测试，含本地运行时重启、实际 scheduled 事件、长任务结束标记与审批规则）；独立打包检查使用 `npm run build`。行为范围、已发现问题和 17 项线上检查见 [TESTING.md](TESTING.md)。

默认使用 `http://127.0.0.1:8787`。本地运行时的出站来自本机，不证明 CF 云端出站可用。

## 分阶段验证

另开终端，安全输入与 Worker 相同的测试密钥：

```sh
read -s DEMO_KEY
export DEMO_KEY
.venv/bin/python client/probe.py network --url http://127.0.0.1:8787
.venv/bin/python client/probe.py cookie --url http://127.0.0.1:8787
.venv/bin/python client/probe.py rpc --url http://127.0.0.1:8787
```

| 命令 | 能证明什么 |
| --- | --- |
| `network` | CF/本地 Worker 是否能收到固定 Muse 地址的 HTTP 响应，拒绝或不可达返回失败 |
| `cookie` | Cookie 换证和 Muse WebSocket Upgrade 成功；尚未证明 Noise RPC 可用 |
| `rpc` | Noise 握手后执行只读 `sessions.list`，不输出会话内容 |
| `chat` | 新建一个独立测试侧会话，发送一次消息并查询真实回复 |
| `result` | 根据已有回执查询同一会话的结果，不新建会话、不发送任务 |
| `renew` | 手动执行一次 Cookie 续期，只返回脱敏状态 |
| `status` | 查询最近认证、轮换及需重新登录的状态，不发起网络认证 |

前面三个阶段成功后再手动发送测试消息：

```sh
.venv/bin/python client/probe.py chat --url http://127.0.0.1:8787
```

默认消息只请求回复一句“CF Cookie demo 连接成功。”。提交前独占创建 `.local/chat-receipt.json`，同一文件不能再次提交；多个并发进程也只能有一个取得提交资格。结果写回采用原子替换和磁盘同步。

超时或断线后，执行只读查询：

```sh
.venv/bin/python client/probe.py result --url http://127.0.0.1:8787 --receipt .local/chat-receipt.json
```

回执保留会话、发送前历史序号和提交确认。发送前验证历史序号；只接受该用户消息之后的新回复，不把先前回复当成当前结果。同一快照中的多段完成文本会合并，仍有活动回复时继续等待；明确失败/取消返回对应终态。查询失败、结果未知或收到提交回执，都不能证明任务没有执行；不要直接新建任务重试。

`--timeout` 是等待结果的时间预算，单次网络调用可能额外耗时，超时不取消 Muse 任务。确认上次执行结果后，新的独立测试可指定新的 `--receipt` 文件。每次 `chat` 会建立新的测试侧会话，当前没有跨回合自动绑定会话或长期渠道队列。

## Cookie 自动续期

首次导入的 Cookie 作为 CF Secret 中的初始凭证。Worker 接收 Muse `/api/auth/check` 返回的 `Set-Cookie`，按服务端顺序处理“删除旧值 → 设置新值”，立即保存到专用 Durable Object 的 SQLite；随后换取 hatch token 时就使用新值。轮换后的 Cookie 不返回客户端，也不需要给 Worker 配置 CF 管理令牌。

同一账号的续期和建连串行执行，避免并发覆盖；Worker 重启后从持久化状态读取最新值，不回退到旧 Secret。更新导入的 Cookie 或 VM ID 后，种子指纹变化会触发重新初始化。

默认 Cron 为 `54 20 * * *`（UTC），即每天北京时间 04:54。连接 Muse 时同样会执行认证和保存轮换；定时任务不创建会话或发送用户消息。`GET /renewal/scheduled-status` 单独记录真正的 Cloudflare scheduled 调用，手动续期不会覆盖该记录；临时分钟级 Cron 成功不能当作每日 04:54 已经触发。有效期遵循服务端返回值，不承诺永久有效。

```sh
.venv/bin/python client/probe.py status --url https://your-worker.example.com
.venv/bin/python client/probe.py renew --url https://your-worker.example.com
```

明确认证 401 会标记 `needs_login=true`，停止后续自动认证，等待新凭证导入。网络失败保留 Cookie 并记录网络错误；普通 403 不直接归因为过期。导入新凭证并重新上传 Secrets 后，可调用 `renew` 核查恢复。状态接口只返回检查/轮换时间和错误代码，不返回 Cookie、令牌或种子指纹。

部署需要 SQLite Durable Objects；默认配置创建独立的 `MuseCredentials` 类和命名空间，只用于本账号凭证，与旧项目的聊天房间无关。

## 部署独立 Worker

先确认 CF 账号和 Worker 名称。默认名称为 `cf-muse-cookie`，与旧的 `cf-muse-channel` Worker 区分，避免误修改旧 Durable Object 服务。

```sh
npx wrangler whoami
npm run deploy
python3 scripts/secrets.py prepare
npx wrangler secret bulk .local/worker-secrets.json
```

账号使用命名 profile 时，为相关命令加 `--profile <名称>`。不要把账号令牌放入仓库。`prepare` 的输出只保存在忽略的私有文件中，不显示 Cookie、VM ID 或密钥。

需要自定义域名时，复制 `wrangler.custom-domain.example.jsonc` 为本地忽略的 `wrangler.production.jsonc`，填写自己的账号和未占用的子域名，再执行：

```sh
npx wrangler deploy --config wrangler.production.jsonc
python3 scripts/secrets.py prepare
npx wrangler secret bulk .local/worker-secrets.json --config wrangler.production.jsonc
```

使用部署输出的 HTTPS 地址替换上述 `--url`，依次测试 network、cookie、rpc、chat。已有独立验证站点是 <https://muse-demo.sirhao.top/health>；它是此前部署的 demo，不会因 Git 推送而更新。

旧项目的 `/ws/main` JSON 协议、HTTP 房间 API、MCP 和 hook 均不再存在。新 `/ws` 使用 Noise 二进制协议；旧客户端不能直接连接。仓库替换不迁移或删除线上旧房间、消息与在途任务，也不停止原有服务。

## 接口与边界

- `GET /health`：公开健康信息，只证明 Worker 能响应。
- `POST /probe/network`、`POST /probe/cookie`：需要 `Authorization: Bearer <DEMO_KEY>`。
- `GET /credentials/status`、`POST /credentials/refresh`：需要相同鉴权，提供脱敏状态与手动续期。
- `GET /approvals/status`、`POST /approvals/poll`、`POST /probe/worker-rpc`、`GET /renewal/scheduled-status`：同样鉴权，分别提供自主审批审计、手动轮询、Worker 自己执行的 Noise RPC 和 Cron 触发记录。
- `GET /ws`：需要相同鉴权和 WebSocket Upgrade，固定连接 Muse，不接受自定义目标或 URL 凭证。
- Cookie 换证保持与固定 SDK 一致的请求头；拒绝跨站重定向，认证 JSON 限制大小。
- 上游原始响应和可能包含 token 的异常不返回、不记录，错误只给阶段、HTTP 状态和固定代码。

持有 `DEMO_KEY` 就能通过你的 Muse 账号调用 RPC，不能公开分享。Cookie 认证失败时先区分网络、HTTP 拒绝和凭证问题，不能仅凭 403 就判断过期。

本地 Workers 模拟运行时使用 `2026-07-01`，与可安装的固定 workerd 版本一致；线上配置使用 `2026-11-15`。实际云端和真实 AI 验证见 [VERIFICATION.md](VERIFICATION.md)。

测试结束后，可确认账号及 Worker 名称再删除自己新建的测试 Worker；Muse 测试侧会话需另行归档。项目不申请容器或其它付费产品。

协议依赖：[muse-cli 固定版本](https://github.com/nikships/muse-cli/tree/2e42aeccbef71437f4ccd4faa626414f2461be7b)，MIT；[Cloudflare WebSocket 客户端](https://developers.cloudflare.com/workers/examples/websockets/#connect-to-a-websocket-server)。


## 长任务与网络审批

Muse 的进度消息也可能标为 `completed`，默认短回复模式不能据此认定后台任务已经结束。受控长任务可传 `--completion-marker LONGRUN_FINISHED:唯一编号`，并在任务要求里约定最终回复以该标记独占一行；回执会保存它，`result` 重连查询继续等待。客户端只在最新完成消息中找到独占行标记时结束，不接受进度文本中引用未来标记。标记仅用于等待结束，任务是否成功仍要独立核查文件、运行时间、检查点和错误数。等待上限支持3600秒，超时不重发或取消远程任务。

自动审批支持见 [APPROVALS.md](APPROVALS.md)：通过 CF 读取 Muse 网络审批，按用户授权的精确站点/端口/任务来源规则提交 `allow_once`，审计先落盘、超时不重放。生产运行由 Worker 的 Durable Object alarm 自主完成，不依赖本机监听器。仓库默认关闭，按用户授权配置精确规则；未匹配的请求继续待审。
