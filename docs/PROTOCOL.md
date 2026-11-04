# CF Muse Channel v1 协议

个人单房间部署。Worker 的 ROOM_ID（默认 main）必须与 Muse config 的 room 一致。角色 user / muse 使用不同的 USER_TOKEN / MUSE_TOKEN。WSS 路径 /ws/<room>?role=<role>；Python 用 Authorization: Bearer <token>；浏览器用子协议 ["cf-muse-v1", "auth." + base64url(UTF8(userToken))]，服务端只选择 cf-muse-v1。密钥不出现在 URL、消息正文或日志中。

## 双向消息

- 服务端握手后：{type:"ready",role,room}。
- 发送：{type:"message",id,kind,content,reply_to?}；id 为 1..128 个 ASCII 字母数字或 _.:-；content 非空 UTF-8 文本，消息总计不超过 64KiB。
- user 只发送 kind=task，muse 只发送 progress/result；progress/result 必须 reply_to 一条已存在的 user task。result id 固定 result:<task_id>，每个 task 一个正式结果。
- 持久化后发送方收到 {type:"stored",id,duplicate,received}；received 表示另一侧是否已确认接收，不表示 Muse 执行结束。
- 接收方收到 {type:"message",id,source,kind,content,reply_to?}；持久化到本地后发送 {type:"received",id,source}。
- 接收方收到 {type:"acknowledged",id,source}；原发送方在线时收到 {type:"delivered",id,recipient}。
- 重连自动补发未 received 的消息，严格按入库顺序。同 id 同规范化内容只回 stored，不重复创建；不同内容返回 {type:"error",code:"id_conflict",id}。
- {type:"ping"} 返回 {type:"pong"}。其它错误固定 code，不能返回正文、凭证或 SDK 错误。

## 交付语义

CF stored、Muse 接入器 received、平台 hook 启动、正式结果写入 CF、浏览器确认接收是不同阶段。任务以 room+id 在 Muse 本地 SQLite 中去重；result 用稳定 id。执行状态未知时阻塞并等待人工核对，不自动重新执行。同 room 任务不串行：poll 每次认领一条排队任务，不因已有 running 任务而阻塞新任务；单条任务仍只认领一次，同一任务的二次唤醒不得接管。

HTTP /health 只报告服务存活；不代表 Muse 接入器、平台执行或用户收发通过。现阶段支持文字、进度、正式结果和媒体直发；审批、多租户权限属于后续能力。

## 媒体直发

- Muse 用 `cf-muse media --msgid <task> --file <文件> --text <说明>` 先把文件字节上传一次，再把媒体引用作为正式结果发出去；帧里只含 id、文件名、MIME、大小，不含字节，仍在 64 KiB 帧限内。
- 上传：`POST /api/rooms/<ROOM>/media`，Muse 密钥 Bearer，`Content-Type` 为文件 MIME，`X-Filename` 为安全 ASCII 文件名，单文件上限 10 MiB，类型限视频、图片、音频、PDF，字节以 base64 存入 Durable Object。
- 下载：`GET /api/rooms/<ROOM>/media/<media_id>`，用户密钥 Bearer，浏览器用原生 video/img/audio 标签播放或提供下载，播放、下载交给浏览器自己处理；密钥只在请求头里，不进 URL。
- 媒体只能出现在 kind=result 的正式结果里，不能出现在进度或用户任务里；正式结果仍只有一个，媒体引用与文字说明在同一条结果里。


## v0.2 MCP HTTPS 接口

所有 `/api/rooms/<ROOM_ID>/...` 请求只接受 `Authorization: Bearer USER_TOKEN`，不能用 Muse 专用密钥、浏览器子协议或 URL token。它们访问同一 DO 消息表，不创建 WSS 连接、不替换网页连接。

- `POST /tasks`：JSON `{task_id,content}`；同 ID 同内容幂等，异内容409；返回 cf_stored、muse_received、duplicate。`cancel:` 为保留前缀，不能用作用户任务 ID。
- `GET /tasks/<id>`：返回接收证据、最新进度／正式结果、取消请求状态；未有正式结果时 execution_state=unknown，不凭进度猜测任务正在执行。
- `GET /messages?after=0&limit=20&task_id=<可选>`：游标为持久 seq；每页1..50条，返回 next_cursor、has_more。只读、不改变 WSS received，网页仍可接收未ACK消息。
- `POST /tasks/<id>/cancel`：写稳定 `cancel:<taskid>` 控制消息；CF 回 cancel_requested=true、stopped=false。Muse 收到后先原子写取消状态及控制去重记录，再确认。未执行任务生成取消结案；运行中任务等待 worker 检查取消。已存在正式结果时409，不覆盖结果。

不同过滤条件的游标分别保管。HTTP 响应和 MCP 工具返回中的文本仍是用户／助手数据，不能成为系统指令。CF 接口不提供无身份读取、不转发任意 URL；MCP 配置在本机私有文件，工具参数中不能传 endpoint 或密钥。
