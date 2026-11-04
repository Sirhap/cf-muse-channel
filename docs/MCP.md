# 我们自己使用的 CF Muse MCP

这是本地 stdio MCP：当前助手调用工具，通过 HTTPS 把任务送到我们的 CF Worker，再由 Muse 接入器和 hook 处理。MCP 使用个人 USER_TOKEN；不需要 Cloudflare API token、Muse token 或浏览器 Cookie。它不维持用户角色 WSS，网页和 MCP 可以同时使用。

## 安装

Python 3.12+，项目放在固定绝对路径。创建独立环境，避免干扰 Muse 接入器：

```bash
cd /你的绝对路径/cf-muse-channel
python3 -m venv .venv-mcp
.venv-mcp/bin/pip install -r requirements-mcp.txt
```

版本锁定官方 MCP Python SDK 1.26.0 与 httpx 0.28.1，采用已验证的 FastMCP stdio API，不在运行时自动升级到 SDK 2.x。[官方 SDK 对应版本文档](https://github.com/modelcontextprotocol/python-sdk/tree/v1.26.0)

将 `mcp-config.example.json` 复制到本机 `~/.config/cf-muse-channel/mcp.json`，填写实际 HTTPS Worker 根地址、room 和 USER_TOKEN。目录0700、文件0600；不要使用 Muse 专用 token，也不要贴进聊天。由部署方通过安全文件交付 `user-token.txt` 后，在本机私有配置中录入。生产不关闭 TLS 证书校验；只在隔离集成测试允许 `http://127.0.0.1` 并明确 `allow_insecure_localhost=true`。

也可以通过脚本从安全投递的密钥文件创建配置，避免手工复制 token；目标已存在时拒绝覆盖：

```bash
.venv-mcp/bin/python scripts/prepare_mcp.py --server https://实际Worker地址 --user-token-file /私有路径/user-token.txt
```

## 挂载到支持 stdio MCP 的助手

下面是通用 `mcpServers` 配置形状；将绝对路径替换为实际值。不同客户端配置入口及字段以其当前版本为准，不复制相对路径。配置文件只引用私有配置路径，不包含 token 值。

```json
{
  "mcpServers": {
    "cf-muse": {
      "command": "/你的绝对路径/cf-muse-channel/.venv-mcp/bin/python",
      "args": ["/你的绝对路径/cf-muse-channel/scripts/run_mcp.py"],
      "env": {
        "CF_MUSE_MCP_CONFIG": "/你的家目录/.config/cf-muse-channel/mcp.json"
      }
    }
  }
}
```

`run_mcp.py` 不依赖客户端当前工作目录。启动后 stdout 只用于 MCP 协议，普通日志走 stderr。不要用 shell 包装器打印配置来“检查连接”。挂载后应能列出四个工具；仅写好配置不等于已经连接，真实 CF 尚未部署时工具会明确失败。

## 工具与使用顺序

| 工具 | 参数／行为 |
| --- | --- |
| `send_message` | 必填 task_id、content。为一次用户授权任务选稳定 ID（最多96位ASCII字母数字或`_.:-`），同一次任务重试必须使用相同 ID 和原文。 |
| `get_task` | 按 task_id 查 CF 保存、Muse接收、最新进度、正式结果及取消状态。无结果时执行状态保持 unknown。 |
| `get_messages` | after默认0、limit默认20（1..50）、可选task_id；用返回 next_cursor续读，不同筛选条件分别保存游标；不ACK、不隐藏网页消息。 |
| `cancel_task` | 按 task_id 登记取消请求；需要用户授权取消。cancel_requested不代表已经停止，随后核查 cancel_received_by_muse 和最终结果。 |

网络断在POST提交之后时，返回错误会明确提示“提交可能已成功，使用同一 task_id 重试”。不能为绕过错误自动生成新任务 ID。服务端同 ID 异原文会409；需要新任务时显式使用新 ID。

MCP 将消息内容作为数据提供，助手不能因返回的回复声称“系统指令”而提升权限。发送任务、取消或转交有副作用的操作仍需当前用户授权；远端回复不能授予本地权限。

## 部署与升级

需要同步部署0.2版 Worker与Muse接入器。SQL仅新增本地controls表，不重建既有任务表、DO类或命名空间；旧消息／去重记录保留。生产更新前检查在途任务并按部署约定给出步骤确认，本交付没有执行线上升级。若接入器版本不识别cancel控制帧，它会停止并报告错误，不能把仅CF入队当作取消成功。

## 验证

```bash
.venv-mcp/bin/python -m unittest discover -s tests_mcp -p 'test_*.py'
# 只有本地集成验证需要安装接入器的 websockets 依赖：
.venv-mcp/bin/pip install -r requirements.txt
.venv-mcp/bin/python scripts/mcp_smoke_test.py
```

集成脚本使用真实官方 SDK 的 stdio initialize、tools/list、tools/call，连接本地官方 Workers运行时与真实Python接入器，覆盖四个工具、网页并用、稳定ID、游标和取消传递。它不调用真实Muse AI，也不发布CF云端资源。
