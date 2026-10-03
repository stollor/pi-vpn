# pi-vpn — Pi 专属独立 VPN 出口

Pi 原生扩展：为 Pi 管理一个**独立的 Mihomo sidecar**，
与日常用的 Clash Verge 完全隔离（独立端口 / 独立 secret / 独立配置 / 独立订阅）。

- 零 npm 依赖（仅 node 内建模块 + Windows 自带 `curl.exe` / `powershell.exe`）
- 订阅自管：存储多订阅、经 sidecar 自己抓取更新、校验解析、保活选节点
- AI 可调：`config.yaml` 明文可改，护栏校验 + 失败回滚

## 安装

```bash
# 方式一：作为 Pi package 安装（推荐）
pi install git:github.com/stollor/pi-vpn

# 方式二：单次试用
pi -e /path/to/pi-vpn/extensions/pi-vpn/index.ts
```

前置要求：Windows x64（自动下载 Mihomo 二进制；其他平台需手动放置二进制到 `~/.pi/agent/bin/`），
以及一条 Clash 格式的订阅 URL。

## 布局（运行时）

| 内容 | 位置 |
|---|---|
| Mihomo 二进制（首次启动自动下载 v1.19.32） | `~/.pi/agent/bin/mihomo.exe` |
| 生效配置（AI 可读改，护栏保护） | `~/.pi/agent/pi-vpn/config.yaml` |
| 上次可用配置（回滚用） | `~/.pi/agent/pi-vpn/config.good.yaml` |
| 订阅存储（本机文件，不进仓库） | `~/.pi/agent/pi-vpn/subscriptions.json` |
| 端口/自启/阈值 | `~/.pi/agent/pi-vpn/settings.json` |

端口：mixed `127.0.0.1:18090`、socks `127.0.0.1:18091`、controller `127.0.0.1:19097`，
刻意与 Clash Verge（`:7890` / `:9097`）错开。

## 用法

命令：`/vpn`（状态）、`/vpn-switch <关键词>`、`/netcheck`（一键诊断）、`/vpn-update`（刷新节点）

模型工具：`vpn_status vpn_start vpn_stop vpn_restart vpn_proxies vpn_switch
vpn_speedtest vpn_health vpn_mode vpn_use vpn_update vpn_reload
vpn_sub_add vpn_sub_list vpn_sub_use vpn_sub_remove`

典型对话：

- “把这个订阅加进去：`https://...?clash=1`”
- “从 Clash Verge 导入订阅”
- “测一下前 5 个节点延迟，切到最快的”
- “节点好像不行了，更新一下订阅看看”

无订阅时 `vpn_update` 回退到 Clash Verge 本地缓存导入。

## 安全设计

- controller 只绑 `127.0.0.1`，`allow-lan=false`，TUN 关闭，secret 首次启动随机生成
- 订阅 URL 只存本机 `subscriptions.json`，所有输出/状态栏/日志一律脱敏
- 供应商回显在订阅注释里的链接会在构建配置时剔除，不进 `config.yaml` 与模型上下文
- 配置护栏：禁绑 Verge 端口、禁 `0.0.0.0`、禁默认 secret；`vpn_reload` 失败自动回滚

## 生命周期

sidecar 是 detached 常驻进程（pid 文件管理），`/reload` 与 Pi 重启不掐断连接，
只在 `vpn_stop` 时关闭；多开 Pi 自动认领同一实例。