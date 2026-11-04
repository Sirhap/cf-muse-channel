# 交给 Muse 的部署任务

## 已有 Worker：仅安装 Muse 端

如果用户已提供 Worker 地址、room 和 Muse 专用私有配置，请跳过本文第 2 节 Cloudflare 部署。不要要求 Cloudflare 登录或 API token，不重新生成密钥，不重新发布 Worker。安装接入器并注册 hook 后，按验收清单验证真实收发。必须使用与服务端相同版本的源码（本公开版本为 0.2.0），不混用旧 0.1.0 包。


把 ZIP 上传后，复制下面这段给 Muse：

```text
请部署附件中的 CF Muse Channel 独立项目。先阅读 README.md、本文件、docs/PROTOCOL.md 和 docs/ACCEPTANCE.md，核对代码、环境、Cloudflare 授权和平台 hooks 能力。

目标是新增一个 CF 渠道：网页 → CF WSS → 本地接入器 → Muse hook 执行 → 进度与正式回复回网页。不用企业微信／微信，不通过原生桥浏览器 Cookie，不修改现有渠道。

先准备依赖、独立 Worker 名称、私有密钥、绝对路径 CLI、hook 定义与 service，完成打包和本地检查。用平台实际支持的 hooks API/schema 注册 cf-muse-inbox，真实会话的 delivery target 由当前平台查询，不复制其它渠道的 ID，不假造 API 或 run_id；poll_interval_secs 至少 5 秒。涉及生产服务、已有资源覆盖或状态迁移先给具体方案确认；首次独立测试部署按这次授权执行。

不要把密钥、Cookie、token、账号凭证或聊天正文输出到日志／回复。最终告诉我 Worker 网页地址，通过安全文件方式交付 user-token.txt，并按验收清单记录真实 msgid、run_id、正式结果 ID 及浏览器接收确认。平台限制导致无法启用 hook 时明确报告已完成部分和阻碍，不能把模拟回复说成真实 Muse 执行。
```

## 1. 解包与检查

建议放在 `~/workspace/cf-muse-channel`。确认目录结构和 SHA256，不将测试状态目录一起带入。项目是独立应用；不要复制进原网关的状态目录。

```bash
cd ~/workspace/cf-muse-channel
npm ci
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
npm run build
```

Node 22+、Python 3.12+；若 `python3` 版本较低先选择已安装的 Python 3.12+。锁定依赖升级不属于部署必需操作。

## 2. Cloudflare 独立 Worker

使用 `npx wrangler whoami` 检查授权；需要登录时走平台支持的安全授权方式。不要在聊天中索取 API token 明文。检查拟用 Worker 名 `cf-muse-channel` 是否已存在，存在则选择新名称，禁止覆盖无关项目。

在 `wrangler.jsonc` 设置唯一 Worker 名和 `vars.ROOM_ID`（默认 `main`）。`workers_dev=true` 会发布个人网页；WSS 必须持有独立角色密钥才能使用。配置绑定 `CHANNEL_ROOMS` 和 `ChannelRoom`，首次部署创建独立 SQLite DO 命名空间，不使用旧项目的存储。

确定 Worker 的 workers.dev 子域名后，生成仓库外私有配置。`--server` 填实际地址，不使用示例地址：

```bash
.venv/bin/python scripts/init_config.py --server wss://实际Worker地址 --room main
```

默认生成 `~/.config/cf-muse-channel/`（0700）中的三个 0600 文件：`config.json`、`worker-secrets.json` 和 `user-token.txt`；脚本不会打印值，已有文件不会覆盖。若需要自定义私有目录，加 `--directory`，后续命令同步指定。

```bash
npm run deploy
npx wrangler secret bulk ~/.config/cf-muse-channel/worker-secrets.json
```

首次 Worker 未装入密钥时 WSS 拒绝连接；安装密钥后再验活。`USER_TOKEN` 给个人网页，`MUSE_TOKEN` 只给 Muse 接入器。两者不相同，且不写入源码／URL。若 Worker 名称或子域名变化，受控更新私有 `config.json`，不要重新生成整套密钥导致两侧不一致。

## 3. Muse 接入器

```bash
.venv/bin/python scripts/prepare_muse.py
```

在 `~/.config/cf-muse-channel/install/` 生成：

- `cf-muse`：包含实际项目路径和当前虚拟环境 Python 的 CLI。
- `cf-inbox.sh`：给平台执行的 hook 包装器。
- `cf-inbox.json`：禁用状态的待注册定义，必须按当前平台 schema 补齐 delivery。
- `cf-muse-channel.service`：systemd 用户单元，未自动安装。

先前台运行确认连接成功：

```bash
~/.config/cf-muse-channel/install/cf-muse run
```

确保没有第二个接入器使用同一角色连接；退出前台后，若 Muse 支持 systemd user 单元，再由已获授权的部署流程安装：

```bash
mkdir -p ~/.config/systemd/user
cp ~/.config/cf-muse-channel/install/cf-muse-channel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cf-muse-channel
```

若当前环境不支持 systemd user，使用平台已有进程管理能力运行同一 `cf-muse run`，保证唯一实例并在 VM 重建后恢复。若 Muse 环境依赖 HTTP 出站代理，使用现有私有代理配置为接入器提供 `HTTPS_PROXY`／`WSS_PROXY` 环境；交互终端的代理不会自动被 systemd 继承，不能把含代理凭证的地址打印出来。接入器对生产 WSS 使用 websockets 的环境代理选择，对显式允许的本地 ws 测试禁用代理。不要假定交互终端退出后程序仍然存活。退出码 2 表示认证／配置／持久状态需人工处理，禁止 supervisor 无限重启绕过错误。

## 4. 注册实际 Muse hook

查询平台当前 hooks schema 和当前目标会话，将生成的定义 `cf-inbox.json` 通过实际 hooks API 创建。补齐平台要求的 delivery 字段、核对真实绝对 `script_path`，设 `enabled=true`；保持 `id=cf-muse-inbox`、5 秒轮询、30 秒脚本执行超时。这个超时只限制取消息脚本，不是 AI 任务时长。

运行时必须由平台提供 `HATCH_HOOK_RUNTIME`；包装器提供 `CF_MUSE_CLI`。脚本只通过 runtime 的 `wake` / `silent` 接口输出。不要自行创建假的 runtime 文件来宣称部署通过。

重要边界：`poll` 在返回消息之前将其标记为 dispatched。平台未真正唤醒、worker 崩溃或响应未知时，任务不会自动重新执行；这避免已发生外部副作用的任务重复执行。通过平台日志和 `queue/status/results` 核查后，只有明确原执行未发生或已安全停止，才用 `recover --confirm-no-execution` 人工重新排队。长任务超过 15 分钟不因通信断线自动取消；平台自身终止策略仍需实测。

## 5. 交付用户与验收

打开 HTTPS Worker 网页，通过安全文件方式把 `user-token.txt` 交给用户，填写服务器、房间和密钥后连接。用户密钥只有页面当前内存保存；不要让浏览器记住或第三方同步它。按 [验收清单](ACCEPTANCE.md) 完成真实任务；若仅本地模拟测试通过，必须明确写“尚未真实 Muse 验收”。

本版本仅文字任务。用户提出附件、审批或多租户需求时，不把未实现能力写成已支持。出现满容量、状态损坏、认证失败应报告并制定受控恢复方案，不能清空队列来制造恢复成功。
