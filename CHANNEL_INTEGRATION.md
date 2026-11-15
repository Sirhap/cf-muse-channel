# 微信、企微通过 CF 连接 Muse

现有渠道网关仍负责腾讯协议、消息路由和回执。只替换原 native bridge 的连接边界：

`微信/企微网关 → 原消息/任务处理 → RelayGateway → CF /ws → Muse`

`client/bridge.py` 提供 `connect()`，读取本机owner-private JSON配置（url/key），完成真实sessions.list后返回同一SDK接口的连接。Cookie只在CF维护，不依赖虚机访问Muse公开域名。

`prepare_channel_integration.py`在已有native_bridge.py的connect()中增加显式环境开关分支；没有配置开关时原逻辑保持。脚本只生成补丁候选、检查语法，不直接修改服务或配置。

```sh
python3 scripts/prepare_channel_integration.py --bridge /path/native_bridge.py --output /private/path/native_bridge.cf.py
```

服务需要配置：

```sh
MUSE_CF_RELAY_CONFIG=/home/hatch/.config/cf-muse-channel/relay.json
MUSE_CF_RELAY_SOURCE=/absolute/path/client/bridge.py
```

配置JSON含url和key，必须是当前服务用户拥有且0600的普通文件。不要输出内容、提交仓库或将key写入聊天和命令行。传输适配器的相邻probe.py和Muse SDK依赖必须可用。

切换先备份源码、工作区服务单元和模式/标志文件，检查在途任务。企微core沿用原DB、账号与hook_handoff；微信legacy保留hook备用，只有确认无旧在途任务、队列歧义后才能在渠道路由锁内解除fallback锁存。不能重放旧失败任务或把未知任务迁到另一条路径。

修改后运行原服务解释器的真实CF RPC，再仅重启受影响runner/bridge；工作区unit副本需同步，避免换机自愈覆盖新环境。回滚移除环境开关、恢复源码和标志，保留所有任务账本。真正收发验收需要新的微信/企微入站消息及相应执行和出站回执，RPC和服务active不能代替收发证据。
