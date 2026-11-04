# 交付验证记录 · 2026-11-04

## 0.2.0 公开仓库验证

公开源码与已部署 Worker 源文件逐项一致。隔离发布副本完成：JavaScript 11项、Python接入器/部署30项、MCP HTTP客户端8项、真实本地Worker与接入器24项集成检查，均通过；`wrangler deploy --dry-run` 通过。配置示例只有占位符，发布前对照本机实际角色密钥逐文件检查，无匹配。真实 Muse 平台 hook 与AI执行仍由部署环境验收。

## 0.1.0 历史验证


版本：CF Muse Channel 0.1.0。验证主机为 macOS；Node.js 24.11.1、Python 3.12.13、Wrangler 4.99.0、websockets 17.1。所有网络集成使用本地官方 Workers 运行时与临时密钥，不连接真实 Muse AI、不发布 Cloudflare 云端资源。

| 检查 | 实际结果 |
| --- | --- |
| Python 配置、SQLite 所有权、取消／人工恢复、接收落盘、安装与 hook envelope | 26 项通过 |
| Worker 与网页协议 | 11 项通过 |
| 真实 Worker WebSocket + 真实 Python 接入器集成 | 24 项通过 |
| Wrangler deploy --dry-run | 通过；Worker、DO、静态资源打包成功 |
| Edge 桌面页面 | 用户态 Edge 打开本地页面，中文表单、空态、禁用发送和桌面排版可见；未做手机真实浏览器或完整网页点击收发验收 |
| 真实 Cloudflare 云端部署 | 未执行 |
| 真实 Muse hook／AI 执行 | 未执行，须由部署环境按 ACCEPTANCE.md 验收 |

集成覆盖角色和房间隔离、浏览器子协议认证、20 帧受控重放、确认后补发后续积压、未知任务结果拒绝、自身角色收据拒绝、消息落盘、接入器领取、稳定任务 ID 去重、进度、唯一正式结果、客户端接收证据，以及 CF 本地运行时和接入器重启后的待处理消息／发件箱恢复。测试中的 run_id 为显式模拟值，不是平台执行证明。

最初通信 PoC 另做过本地 TLS/WSS 测试；交付项目的集成脚本使用显式允许的 loopback `ws://`，生产配置只允许 `wss://`，证书采用默认验证，不包含跳过 TLS 验证的生产选项。

复现命令：

```bash
npm ci
npm test
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
.venv/bin/python scripts/smoke_test.py
npm run build
```

真实 Muse 部署还必须核对平台 hook schema、delivery 会话、HATCH_HOOK_RUNTIME、后台进程管理和出站代理环境。文件脚本能生成待注册定义，不意味着已经注册或唤醒真实 AI。
