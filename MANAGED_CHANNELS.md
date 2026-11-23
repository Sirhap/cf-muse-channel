# CF 独立渠道托管

`ManagedChannels` 将腾讯渠道接收、Muse Noise 调用、原生会话连接和回复投递放在 Cloudflare Durable Object 中。微信使用腾讯 iLink 长轮询；企业微信使用腾讯 WSS；Muse 回复使用独立 WSS 订阅唤醒，15 秒历史查询作补查。同一会话连续回合复用订阅连接，空闲读取超过 120 秒后关闭；断线重连仍然只读核对已有任务。Muse 虚机里的 Python 网关、Core 和 bridge 不参与这条链路。Muse 自身仍负责执行用户任务。

转发前清理独占一行的 `[[hatch_widget:…]]` 交互组件标记，保留正文、普通方括号和行内示例。只有组件、没有正文时给出渠道不支持显示的说明。

本版支持文字收发、图片/常规文件/6MB 内小视频双向传输（微信 AES-128-ECB / 企微 AES-256-CBC 与分片上传，入站写入 Muse 沙箱 `workspace/cf-inbound-media/`，出站识别 Muse 独立返回的图片或视频、`[[FILE:...]]` 与 `outbox.jsonl` 的 `send_file`）、微信与企微语音转文字、发送者白名单、私聊会话隔离、企微群聊隔离、非白名单审批与 Cookie 401 失效去重告警、微信主动推送缺失/拒收自动企微兜底、定时任务主动推送接口（`POST /managed/push` / `POST /admin/managed/push`）和 `/ping`、`/help`、`/status`、`/queue`、`/new`、`/stop`。微信群消息不接收；超大附件（>6MB）保留在沙箱并给出路径提示。 企微明确以 `846697` 拒收原生图片或视频消息时，会把原件作为普通附件另发一次。

## 定时任务主动推送

这里的发件箱是 Muse 虚机里的本地 `outbox.jsonl` 文件。脚本把待发给微信或企微的消息追加到文件，渠道 Worker 从上次保存的位置读取新增内容。使用这条链路无需开启邮箱或配置邮件连接器。

切换 CF 托管后原虚机 `weixin-bot` / `wecom-bot` 已停用，`ManagedChannels` 通过以下两种方式支持定时任务推送：

1. **零改虚机自动追踪（默认开启）**：固定从主账号 `primary-account` 的 Muse 虚机读取，不随新会话账号池切换。通过同一条 Noise 连接用 `POST /fs/stats` 检查 `workspace/<channel>-bot/state/outbox.jsonl` 大小，用 HTTP Range 读取新增完整行。合规的待发记录与新偏移在同一 SQLite 事务提交。全新来源首次从文件末尾接续。暂时断连或发现虚机变化时保留原进度。
2. **直推接口（可选）**：定时任务或脚本也可直接调用 `POST /managed/push`（`Authorization: Bearer <DEMO_KEY>`，JSON `{"id":"可选幂等键","channel":"auto|weixin|wecom","chat":"可选白名单接收者","text":"正文"}`）秒级送达；`channel` 为 `auto` 时优先最新活跃渠道，微信无可用 `context_token` 时自动回退到已启用的企微，相同 `id` 严格幂等去重。

升级已有分离部署时，先发布凭证 Worker，再发布渠道 Worker。旧发件箱偏移只有渠道归属，升级后在 `/admin/managed/status` 显示 `legacy_offset_unverified` 并等待核对。以主账号的实际发件箱与已有投递台账确定最后已处理的完整行，再用管理员权限读取 `GET /admin/managed/outbox/adopt`，取得当前主虚机 `vm_id` 和每个渠道的 `expected_offset`、文件大小。向同一路径 POST 提交 `channel`、`expected_offset`、核对后的字节 `offset` 和 `vm_id`。若还有已核实来自同一虚机的旧待发附件，可同时提供 `file_task_ids`。遇到 409 重新对账，保留原通知和投递记录。未核实归属前保持该渠道补扫暂停。

## 部署

可以在一个 Worker 中同时部署 `MuseCredentials` 和 `ManagedChannels`，使用默认配置并显式启用 `MANAGED_CHANNELS_ENABLED=true`；也可复制 `wrangler.managed.example.jsonc` 为忽略的 `wrangler.managed.local.jsonc`，填写账号、独立 Worker 名、自定义域名和已有凭证 Worker 名。后一种方式共享已有凭证 DO，只运行一份 Cookie 轮换、每日续期和自动审批，不复制轮换中的 Cookie，也不重复配置 Cron。凭证 Worker 必须保留运行。

独立托管 Worker 需要自己的 `DEMO_KEY` 和 `MUSE_ADMIN_KEY`，均通过 Secret 上传。已有凭证 Worker 的 Cookie、VM ID 和 Secret 保持原样。不要将渠道 Token、Secret 或发送者列表提交到 Git。

登录 `/admin/login` 后进入 `/admin/managed`，配置机器人账号、Token/Secret、允许的发送者 ID 和启用开关。配置保存在 SQLite DO，不在页面回显 Secret。`/admin/managed/status` 显示连接回包、任务与投递状态；这里只显示连接情况，手机收到正式回复才算端到端成功。

隔离的 `POST /admin/managed/probe-native` 使用单独的 DO 实例，连续提交三条输入到同一个 Muse 会话，不接收腾讯消息；GET 返回原生输入回执与输出记录。重复 POST 返回同一记录，不重提。它验证输入到达先后和回复同步，不校验回答内容质量，也不要求恰好回复三次。

不接管已有账号的连接预检使用已鉴权的 `POST /admin/managed/connectivity`：微信只读取认证配置，企微只做 WSS Upgrade 后立即关闭，不订阅机器人、不消费消息。它不能证明企微订阅或正式收发成功。

首次验收可先调用已鉴权的 `POST /admin/managed/probe`，再读 `GET /admin/managed/probe`。它独立创建一个 Muse 侧会话并只提交一次测试消息，不连接腾讯账号。重复 POST 返回同一回执。`succeeded` 和 `event_received=true` 分别证明真实回复与 WSS 事件；它不能代替手机验收。

## 现有账号切换

1. 先完成隔离测试、自动测试和独立 Muse 调用，两个新渠道保持未启用。
2. 核对旧接收端在途和待投递结果。设置可逆的接收端停用标记，同时让旧服务和自愈逻辑尊重标记，再停止旧微信、企微网关。保留代码、配置、凭证和账本。
3. 停止后再查在途并冻结最新微信 `sync.json`。首次提交微信配置时可带 `initialCursor`，值取冻结文件的 `buf`；游标与入站任务在同一事务提交。不得使用运行中提前读取的游标冒充冻结检查点。
4. 启用 CF 渠道，验证腾讯鉴权、成功回包和持续连接，再分别发手机消息核对任务、Muse 回复与腾讯发送回执。
5. 新旧接收端禁止同时运行。遇到问题先停 CF 接收，核对已提交任务和未知投递，再恢复旧接收端；不能直接重放未知任务。

## 故障边界

入站按原消息 ID 和会话唯一去重。连续输入立即交给同一个 Muse 会话，不在 CF 等待上一轮回答完成，也不在 CF 合并文本；输入顺序与原文保留。Muse 原生决定如何接续、合并或调度。SQLite 只保留尚未写入连接的传输回执和去重记录。正式回复先入 SQLite 发件表，再提交腾讯。每个分片有持久发送边界；确认回执前断线会标为 `unknown`，禁止自动重发该片。缺少回执不等于没有送达。管理员取得收件人的明确确认后，可用 `POST /admin/managed/confirm-delivery` 提交 `task_id`、原 `message_id` 和 `received:true`，只核销一个短消息气泡的未知投递，留下确认来源与时间；接口不会重新发送。

提交前保存会话、历史序号和唯一设备标识。重启将中断的 `submitting` 转为 `unknown`；之后只读核对相同设备标识的用户消息，找到后核对原消息回执，绝不重提。无法确认时保留待核查记录，但不会阻止用户后续的新输入交给 Muse。替换账号或凭证前必须核对在途任务和未投递结果；仅关闭接收不受此限制。

新会话由 Muse 账号池选择账号，创建后固定使用该账号和虚机处理消息、取消、订阅、历史及附件。`/new` 创建的新会话可重新选择账号。原账号停用或重连发现虚机不符时，等归属恢复后接续原会话。旧会话只有在启用账号中唯一确认归属后才接续。

Muse 每产生一条完成的 assistant 消息，就按其消息 ID 去重并转回渠道；不等待整个会话进入 completed，也不要求一条输入对应一条回复。长任务的多段回答、连续输入后合并的一条回答，都由 Muse 原生决定。会话状态查询只用于调整补查频率，发生在回复投递之后。`/stop` 直接向 Muse 发送取消请求，后续新输入照常转交，不在 CF 等取消终态。

断线补查从已保存的 `after_seq` 正向翻页，每页 100 条，每轮最多 3 页。每一页的投递任务、输入回执和游标一并持久化。未完成的回复单独复查，旧未知提交从发送前的序号查回执。管理状态中的 `history_backlog` 是还有下一页的会话数，`pending_assistant` 是还在等待定稿的回复数。切回早期版本前先核对这两项及未知投递，保留 SQLite 账本。

CF 发生重启、网络断开或维护时，持久化 alarm 会重新连接渠道并核对已有任务。保活不能保证零停顿；网络和腾讯/Muse 服务仍是外部依赖。

部署时还需核对实际 DO 运行版本：Cloudflare 默认可能让活跃对象继续运行旧代码最多 5 分钟。参见 [官方代码更新策略](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)。不要仅凭 Worker 部署成功就进入账号切换；需要立即更新时，先确认没有在途提交/投递，再使用平台支持的 immediate 策略。当前固定 Wrangler 版本尚未实现该参数，可等待对象更新或使用官方 REST 部署接口，避免无依据升级依赖。

已有管理域名也可将 `MOBILE` 绑定到独立渠道 Worker 的 `ManagedChannels` 类（使用 `script_name`），并设置 `MANAGED_CHANNELS_ENABLED=true`，让原 `/admin` 与 `/channel-health` 直接读取同一份 CF 渠道状态。凭证 DO 保持原命名空间，Cron 与自动审批继续由原凭证 Worker 执行；托管开启后停止采样虚机中的旧渠道状态文件。
