# CF 独立渠道托管

`ManagedChannels` 将腾讯渠道接收、Muse Noise 调用、会话队列和回复投递放在 Cloudflare Durable Object 中。微信使用腾讯 iLink 长轮询；企业微信使用腾讯 WSS；Muse 回复使用独立 WSS 订阅唤醒，15 秒历史查询作补查。Muse 虚机里的 Python 网关、Core 和 bridge 不参与这条链路。Muse 自身仍负责执行用户任务。

本版支持文字收发、发送者白名单、私聊会话隔离、企微群聊隔离和 `/ping`、`/help`、`/status`、`/queue`、`/new`、`/stop`。微信群消息不接收。图片、语音、文件和视频传输、扫码登录、原 Core 的全部扩展命令，以及 hook 备用暂未接入；非文字消息会收到范围提示。

## 部署

可以在一个 Worker 中同时部署 `MuseCredentials` 和 `ManagedChannels`，使用默认配置并显式启用 `MANAGED_CHANNELS_ENABLED=true`；也可复制 `wrangler.managed.example.jsonc` 为忽略的 `wrangler.managed.local.jsonc`，填写账号、独立 Worker 名、自定义域名和已有凭证 Worker 名。后一种方式共享已有凭证 DO，只运行一份 Cookie 轮换、每日续期和自动审批，不复制轮换中的 Cookie，也不重复配置 Cron。凭证 Worker 必须保留运行。

独立托管 Worker 需要自己的 `DEMO_KEY` 和 `MUSE_ADMIN_KEY`，均通过 Secret 上传。已有凭证 Worker 的 Cookie、VM ID 和 Secret 保持原样。不要将渠道 Token、Secret 或发送者列表提交到 Git。

登录 `/admin/login` 后进入 `/admin/managed`，配置机器人账号、Token/Secret、允许的发送者 ID 和启用开关。配置保存在 SQLite DO，不在页面回显 Secret。`/admin/managed/status` 显示连接回包、任务与投递状态；这里只显示连接情况，手机收到正式回复才算端到端成功。

不接管已有账号的连接预检使用已鉴权的 `POST /admin/managed/connectivity`：微信只读取认证配置，企微只做 WSS Upgrade 后立即关闭，不订阅机器人、不消费消息。它不能证明企微订阅或正式收发成功。

首次验收可先调用已鉴权的 `POST /admin/managed/probe`，再读 `GET /admin/managed/probe`。它独立创建一个 Muse 侧会话并只提交一次测试消息，不连接腾讯账号。重复 POST 返回同一回执。`succeeded` 和 `event_received=true` 分别证明真实回复与 WSS 事件；它不能代替手机验收。

## 现有账号切换

1. 先完成隔离测试、自动测试和独立 Muse 调用，两个新渠道保持未启用。
2. 核对旧接收端在途和待投递结果。设置可逆的接收端停用标记，同时让旧服务和自愈逻辑尊重标记，再停止旧微信、企微网关。保留代码、配置、凭证和账本。
3. 停止后再查在途并冻结最新微信 `sync.json`。首次提交微信配置时可带 `initialCursor`，值取冻结文件的 `buf`；游标与入站任务在同一事务提交。不得使用运行中提前读取的游标冒充冻结检查点。
4. 启用 CF 渠道，验证腾讯鉴权、成功回包和持续连接，再分别发手机消息核对任务、Muse 回复与腾讯发送回执。
5. 新旧接收端禁止同时运行。遇到问题先停 CF 接收，核对已提交任务和未知投递，再恢复旧接收端；不能直接重放未知任务。

## 故障边界

入站按原消息 ID 和会话唯一去重；每会话串行，不同会话可分别推进。正式回复先入 SQLite 发件表，再提交腾讯。每个分片有持久发送边界；确认回执前断线会标为 `unknown`，禁止自动重发该片。缺少回执不等于没有送达。

提交前保存会话、历史序号和唯一设备标识。重启将中断的 `submitting` 转为 `unknown`；之后只读核对相同设备标识的用户消息，找到后继续等待原任务，绝不重提。无法确认时保持待核查，并阻止该会话后续任务越过它。替换账号或凭证前必须核对在途任务和未投递结果；仅关闭接收不受此限制。

收到 assistant 的一段完成文本时，还会检查整个会话的执行状态。远端仍运行时不会提前结束长任务；历史中的同一消息版本只保留最新版本。`/stop` 的取消回执仅说明请求已接收，实际停止或任务结束前不会释放下一任务。

CF 发生重启、网络断开或维护时，持久化 alarm 会重新连接渠道并核对已有任务。保活不能保证零停顿；网络和腾讯/Muse 服务仍是外部依赖。

部署时还需核对实际 DO 运行版本：Cloudflare 默认可能让活跃对象继续运行旧代码最多 5 分钟。参见 [官方代码更新策略](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)。不要仅凭 Worker 部署成功就进入账号切换；需要立即更新时，先确认没有在途提交/投递，再使用平台支持的 immediate 策略。当前固定 Wrangler 版本尚未实现该参数，可等待对象更新或使用官方 REST 部署接口，避免无依据升级依赖。
