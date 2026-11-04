# 验收与故障处理

每次记录实际版本、Worker 地址、部署时间、执行环境、通过／失败／未测与脱敏证据。所有记录区分 CF 持久化、接入器接收、Muse 执行和用户客户端接收。

1. 访问 HTTPS 页面；未带密钥的 WSS 请求被拒绝，用户密钥不能以 muse 角色连接。错误密钥不造成自动无限重连或输出凭证。
2. 用户发带唯一标记的问题。记录任务 ID，网页收到 CF stored，再收到 Muse 接入器接收确认。检查接入器 SQLite 中只存一条该 ID。
3. 平台 cf-muse-inbox 轮询真正触发 AI，记录实际 run_id；AI 调用 start 成功，然后用 update 发送有内容的进度，最终 reply。网页显示进度和正式结果，reply_to 对应原任务，只有一个 result:<task_id>。
4. 接入器 results 区分 cf_stored 和 client_received；只有后者证明浏览器确认接收，不代表用户已读。/health 绿色不能代替这些证据。
5. 停止仅测试用接入器，发送消息；恢复后只收到一次任务。不重复执行已经 dispatched/running 的任务。断开客户端后 Muse reply，在重连客户端确认后停止重放。
6. 断开连接恰好在发送与 stored 之间，重连用原 ID 补发；同 ID 异正文拒绝。接入器进程重启和 CF DO 重建后保留持久记录。
7. 用测试账号发预计超过 15 分钟的任务，约每两分钟真实 update；不因通道断线或脚本30秒限制取消 AI。任务无进度时核查真实平台执行，不自动将静默判断为失败或重新执行。
8. cancel 请求标记取消，AI 在下次 cancelled 检查时停止并用 --cancelled 结案；登记取消不等于所有外部动作已停止，需核查实际结果。
9. 模拟 hook 已取走但尚无执行证据：queue 保留 dispatched/running，后续 poll 不重复分发。只有人工证明原执行未发生后 recover，不将网络 ACK 当作执行确认。
10. 手机窄屏、键盘 Enter/Shift+Enter、错误连接和被另一连接替换时提示明确；聊天按文本显示，包含 HTML 的输入不执行脚本。

```text
版本／时间／环境：
Worker 与 room：
匿名／错误角色认证：
任务 ID：
CF stored／接入器 received：
平台 hook／真实 run_id：
进度记录／正式 result ID：
CF stored／浏览器 received：
断线／重启／重复 ID 验证：
取消／人工恢复验证：
未测及阻碍：
```

当前容量硬上限 10000 条记录，达到后拒绝新消息；不可删除历史幂等键后重放旧任务。先检查在途任务、备份 CF 和本地状态，再迁移新房间／新DO命名空间并更新配置。密钥轮换需要同步 CF secrets、本地 Muse 配置和用户密钥文件；不要仅改一侧。
