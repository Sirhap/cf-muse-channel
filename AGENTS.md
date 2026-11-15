# 项目协作约定

本目录是独立的 CF Muse Channel 项目，远程仓库为 https://github.com/Sirhap/cf-muse-channel。

- 用户要求本项目后续改动提交并推送到此仓库；操作前检查远程更新，保留已有历史，不强制推送。
- 只处理本项目，不将相邻 muse-mobile-channels 的改动带入提交。
- 私有配置、角色密钥、运行状态与依赖目录不进仓库。
- 运行与改动相匹配的测试；区分本地验证、Cloudflare 云端验证和真实 Muse 执行验证。
- Git 推送不等于生产部署；涉及已有线上资源、服务重启或状态迁移时，先确认具体操作范围。

- 当前实现为 CF Cookie 中转与 Python Noise 客户端；旧网页、MCP、hook 与 DO 房间实现已由用户授权整体替换，保留于历史基线 `43ea75f`。
- 仓库默认使用独立 Worker 名称 `cf-muse-cookie`；没有具体部署授权时，不更新既有线上 Worker，也不迁移或删除旧 DO 数据。
- Cookie 轮换存入专用 DO，所有续期/建连须串行；返回状态不得包含 Cookie、令牌或种子指纹。明确认证失效需重新导入，不得将网络错误误报为过期。
