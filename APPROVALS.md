# 自动审批（客户端）

通过现有 CF Noise 连接调用 Muse 的审批 API，不依赖已断连的虚机 Cookie 审批中继。首次需用户明确授权目标站点及用途，策略文件表达该授权；网页正文或审批说明不能扩大策略。

示例策略仅允许 parity.sirhao.top 的443 HTTPS/TLS只读网络连接，匹配精确主机、端口与GET/HEAD/CONNECT方法，提交的决定始终为allow_once，不设置永久信任。其它目标继续待审。

```sh
# 安全提供 DEMO_KEY 环境变量，先预览。
.venv/bin/python client/approvals.py --url https://muse-demo.sirhao.top --policy approval-policy.example.json
# 执行已明确授权的决定，或在当前任务窗口持续处理。
.venv/bin/python client/approvals.py --url https://muse-demo.sirhao.top --policy approval-policy.example.json --apply
.venv/bin/python client/approvals.py --url https://muse-demo.sirhao.top --policy approval-policy.example.json --apply --watch --duration 3600
```

默认只预览；watch默认每15秒检查，最长2小时。单实例文件锁防止多个监听器同时提交。本地SQLite审计在RPC前持久化decision_unknown；请求超时或结果不明时保留未知，后续不自动重放，需只读核对平台实际状态。rpc_accepted仅表示API接受，不保证原工具已经继续或完成。

每次决定前重新读取审批详情、核对ID和有效期。字段不完整、过期或策略不匹配都会保留待审，不从说明文字猜测目标。当前功能不代替付款、删除、部署等操作的专门授权，也不会自动拒绝未匹配的请求。

本地状态和审计文件位于忽略目录.local，不应提交；输出不包含原始命令、Cookie、token或完整异常。运行审批监听不会安装或启动系统服务，关闭本地进程即停止后续轮询。

实际Muse记录把HTTPS预连接表示为`scheme=tcp, method=CONNECT, port=443`，客户端对此显式支持；这只批准目标站点的443连接，不是解密后逐个HTTP方法审批。可在规则中加入`thread_ids`数组，将放行绑定到平台返回的`runtime_request_trace.thread_id`；不匹配或缺少来源时保留待审。本轮真实任务监听使用这种会话绑定。

本轮真实任务已观察到一条新请求：当前教程会话访问catfk.com:443，白名单/会话匹配后提交allow_once，随后独立读取平台详情确认status=approved、decision=allow_once。原工具是否完成仍要从任务产物验证，审批成功不能当作任务成功。
