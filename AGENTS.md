# 项目协作约定

本目录是独立的 CF Muse Channel 项目，远程仓库为 https://github.com/Sirhap/cf-muse-channel。

- 用户要求本项目后续改动提交并推送到此仓库；操作前检查远程更新，保留已有历史，不强制推送。
- 只处理本项目，不将相邻 muse-mobile-channels 的改动带入提交。
- 私有配置、角色密钥、运行状态与依赖目录不进仓库。
- 运行与改动相匹配的测试；区分本地验证、Cloudflare 云端验证和真实 Muse 执行验证。
- Git 推送不等于生产部署；涉及已有线上资源、服务重启或状态迁移时，先确认具体操作范围。

- 当前实现包含可选 CF 独立文字渠道托管、CF Cookie 中转与 Python Noise 客户端；旧网页、MCP、hook 与 DO 房间实现已由用户授权整体替换，保留于历史基线 `43ea75f`。
- 仓库默认使用独立 Worker 名称 `cf-muse-cookie`；没有具体部署授权时，不更新既有线上 Worker，也不迁移或删除旧 DO 数据。
- Cookie 轮换存入专用 DO，所有续期/建连须串行；返回状态不得包含 Cookie、令牌或种子指纹。明确认证失效需重新导入，不得将网络错误误报为过期。

## 项目地图

- `src/index.ts`：Worker 入口与路由分发（`/ws`、`/managed/push`、`/admin/*`、Cron `scheduled`）。
- `src/credentials.ts` / `src/muse.ts`：`MuseCredentials` DO 与 `CookieController`（串行 Cookie 轮换、短效 `access_token`/`vmId` 缓存、锁外 WebSocket 升级、审批轮询 `AUTO_APPROVAL_POLL_MS`）。
- `src/noise.ts` / `src/wire.ts`：`NoiseXX` 握手与支持流级多路复用/自动排空未消费流的 `MuseRpc`。
- `src/managed/`：`ManagedChannels` DO（`runtime.ts`、`native.ts`、`outbox.ts`、`media.ts`、`crypto.ts`、`store.ts`、`protocol.ts`、`reply.ts`、`page.ts`），负责微信/企微文字与 6MB 内媒体双向托管、事件精准唤醒、纯 CF 侧 `outbox.jsonl` Range 增量追踪、主动推送与企微兜底。
- `client/`：Python Noise 中转与审批客户端（`probe.py`、`events.py`、`bridge.py`、`ws_transport.py`、`approvals.py`）。
- 常用命令：`npm run test:all`（类型检查 + Vitest + Python 单测 + 重启恢复测试）、`npm run build`（Wrangler dry-run 打包）。
