# CF Muse Channel

一个独立的个人消息渠道：浏览器通过 Cloudflare WSS 与 Muse 双向通信。包含聊天网页、Workers + Durable Objects 服务、Muse Python 接入器、hook 模板和部署交接说明。它不依赖企业微信、微信账号或 Muse 浏览器 Cookie。

```text
聊天网页 ⇄ CF Worker / Durable Object ⇄ Muse 接入器 ⇄ Muse 平台 hook / AI
```

第一版支持文字任务、进度、正式回复、断线补发和消息去重。接入器把消息先存本地 SQLite 再确认接收；hook 每次取一个任务，正式回复使用稳定 ID。执行状态未知时等待人工核对，不按超时自动重新执行或取消任务。

## 我们自己使用的 MCP

新增四个工具：`send_message`、`get_task`、`get_messages`、`cancel_task`，通过 HTTPS 访问 CF 消息账本，使用个人 USER_TOKEN，无需 Cloudflare 账号密钥或 Muse 专用密钥，也不会挤掉聊天网页的 WSS 连接。安装和配置见 [MCP 接入说明](docs/MCP.md)。

MCP 需要本版本 Worker 与 Muse 接入器一并更新：旧版没有 HTTP 接口，也不识别取消控制消息。此处只提供 stdio MCP 服务，不自动修改本机助手配置；实际挂载后才能从助手调用。

## 交给 Muse

从 https://github.com/Sirhap/cf-muse-channel 克隆本项目或上传源码 ZIP，再发送 [部署任务说明](docs/DEPLOY_WITH_MUSE.md) 开头的提示词。Cloudflare Worker 由自己部署；已有 Worker 时，Muse 只使用私有连接配置安装接入器并通过平台 hooks API 注册新渠道。首次完整部署流程也保留在说明中。无需改动已有微信／企微服务。

## 环境与验证

- Cloudflare 账号可用 Workers 和 SQLite Durable Objects。
- Node.js 22+，Python 3.12+；Muse 环境需要允许后台进程、出站 WSS 和平台自定义 hook。
- `npm ci` 安装锁定 Wrangler；`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt` 安装接入器。
- `npm test`：Worker 协议与浏览器纯逻辑测试。
- `.venv/bin/python -m unittest discover -s tests -p 'test_*.py'`：本地状态、配置、安装与 hook 回归。
- `.venv/bin/python scripts/smoke_test.py`：启动独立本地 Workers，测试真实 WebSocket 与真实 Python 接入器；不调用真实 Muse AI，不部署云端。
- `npm run build`：打包验证，不部署。

本项目的兼容日期为 `2026-06-16`，与已验证的 Wrangler 4.99.0 及其本地 workerd 一致；升级运行时应重新执行测试。CF 云端和 Muse AI 的实际执行需要按 [验收清单](docs/ACCEPTANCE.md) 分别记录，不能由本地回归替代。

## 使用

部署完成后打开 Worker 地址，填写 `main` 房间及个人访问密钥连接，输入问题。密钥和聊天仅保存在当前页面内存；页面刷新会清除它们。未确认发送保持同一消息 ID 重试，浏览器收到结果后才确认接收。

网页显示“CF 已保存”只表示服务已持久化；“Muse 接入器已接收”只表示接入器落盘；进度和正式回复由真实 Muse worker 提供。`/health` 只检测 Worker，不证明 Muse 执行通畅。

个人版每个房间、每个角色同时一个连接；新连接替换旧连接。仅配置的 `ROOM_ID` 可连接。当前单房间最多存 10000 条记录，达到上限拒绝新消息，不静默删除消息或幂等键；需要清理时先导出备份和检查在途任务，再迁移新房间／命名空间并轮换配置。多用户授权、审批以及跨设备历史同步未包含在第一版；媒体直发已包含，见协议里的媒体一节。

## 文件

- `worker/`、`wrangler.jsonc`：CF 服务及 SQLite Durable Object。
- `public/`：无外部依赖的聊天网页。
- `muse_adapter/`：持久化接入器和命令行。
- `hooks/`：Muse 收件轮询和助手规则。
- `scripts/init_config.py`：在仓库外生成私有配置与独立角色密钥。
- `scripts/prepare_muse.py`：生成绝对路径 CLI、hook 定义及 systemd 用户单元，不自动安装或重启。
- `docs/PROTOCOL.md`：供其它客户端接入的消息协议。

源代码压缩包不包含真实密钥、运行状态、依赖目录或本地测试数据。`config.example.json` 只含占位符。用户访问密钥与 Muse 密钥分别管理，前者不能用于接入器角色。需要密钥轮换时先给出方案并处理待确认记录；不要把配置和消息正文打印到日志或聊天。
