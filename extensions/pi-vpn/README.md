# pi-vpn — Pi 专属独立 VPN 出口

Pi 原生扩展：为 Pi 管理一个**独立的 Mihomo sidecar**，
与日常用的 Clash Verge 完全隔离（独立端口 / 独立 secret / 独立配置）。

## 布局

- 扩展本体：`~/.pi/agent/extensions/pi-vpn/index.ts`（零依赖，仅 node 内建模块）
- 二进制：`~/.pi/agent/bin/mihomo.exe`（Mihomo Meta v1.19.32）
- 运行目录：`~/.pi/agent/pi-vpn/`
  - `config.yaml` —— 生效配置，**AI 可直接读改**（有护栏，改完跑 `vpn_reload`）
  - `config.good.yaml` —— 上次可用的配置（reload 失败自动回滚）
  - `.secret` —— 首次启动生成的 controller 鉴权 secret
  - `settings.json` —— 端口 / 自启 / 阈值（默认 mixed 18090、api 127.0.0.1:19097）
  - `meta.json` —— 当前选择、出口偏好
  - `mihomo.log` / `mihomo.pid` —— 日志与 pid

## 端口（与 Verge 错开）

| 用途 | pi-vpn | Clash Verge |
|---|---|---|
| HTTP/SOCKS mixed | 127.0.0.1:18090 | 127.0.0.1:7890 |
| SOCKS | 127.0.0.1:18091 | — |
| Controller API | 127.0.0.1:19097 | 127.0.0.1:9097 / pipe |

## 订阅来源

不存订阅 URL、不做远程更新。代理列表来自 Clash Verge 的本地订阅缓存
（`%APPDATA%/io.github.clash-verge-rev.clash-verge-rev/profiles/<current>.yaml`）。
在 Verge 里更新订阅后，跑 `/vpn-update`（或 `vpn_update` 工具）重新导入并重启，
尽量保留原来的 mode 与节点选择。

## 模型工具 / 命令

工具：`vpn_status vpn_start vpn_stop vpn_restart vpn_proxies vpn_switch
vpn_speedtest vpn_health vpn_mode vpn_use vpn_update vpn_reload`

命令：`/vpn`（状态）、`/vpn-switch <关键词>`、`/netcheck`（一键诊断）、`/vpn-update`

## 护栏（AI 改配置也不能踩的线）

- 不得绑定 Verge 的端口（7890/7891/7892/7895/7896/7898/7899/9090/9097）
- controller 只允许 `127.0.0.1`
- `allow-lan` 必须 false，TUN 保持关闭
- secret 不允许使用默认值
- 违反时拒绝启动并说明原因；`vpn_reload` 失败自动回滚到 `config.good.yaml`

## 生命周期

sidecar 是 detached 常驻进程（pid 文件管理），`/reload` 与 Pi 重启不会掐断连接；
只在 `vpn_stop` 时关闭。第二个 Pi 实例会自动认领已在跑的实例。## 订阅源（插件自管）

- 存储：`~/.pi/agent/pi-vpn/subscriptions.json`（本机文件，不进代码不进日志）
- 增加：`vpn_sub_add {url}` 直接加；`vpn_sub_add {fromVerge:true}` 从 Clash Verge 配置导入当前订阅
- 更换订阅：再跑一次 `vpn_sub_add` 即可（同 URL 去重，不同 URL 新增并可用 `vpn_sub_use <id>` 切换）
- 更新节点：`vpn_update`（或 `/vpn-update`）经 sidecar 自己抓取 → 校验（含 `proxies:` 与节点数）→ 重建配置 → 重启 → 尽量恢复原节点
- 查看：`vpn_sub_list`（URL 脱敏显示 `https://host/abc...xyz`），删除：`vpn_sub_remove <id>`
- 无订阅时 `vpn_update` 回退到 Verge 本地缓存；`settings.json` 里 `updateIntervalHours`（默认 24）+ `autoUpdateOnStart`（默认 false）控制过期提醒与启动自更新
- 远端下发的注释头若回显订阅链接，构建配置时自动剔除，token 不进 `config.yaml`、日志与模型上下文
