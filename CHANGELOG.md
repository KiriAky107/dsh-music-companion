# 更新日志

## v0.4.0 — 2026-10-27

**装一个插件就够了。** hub 和四个工具都并进 watcher 包，不再需要单独起服务、也不用配 MCP。

### 新增

- `packages/watcher/lib/hub.mjs`：hub 的可嵌入版本（`createHub()` 工厂），插件启动时自己起一个本地 hub
- `packages/watcher/lib/tools.mjs`：四个工具改成由宿主直接注册（`ctx.tools.register`），不再依赖 MCP
- `packages/watcher/lib/config.mjs`：包内配置加载副本，插件形态下路径按包位置反推
- `config.json` 新增 `hub.embedded`（默认 `true`，设为 `false` 可强制不起本地 hub）与 `hub.embeddedToken`

### 变更

- `index.js` 现在一次做完四件事：起 hub、读 SMTC、注册四个工具、管生命周期
- `lib/ticker.mjs` 改用包内 `./config.mjs`，不再跨包引 `packages/shared`
- `package.json` 升到 `0.4.0`，`files` 补齐 `lib/config.mjs` / `lib/hub.mjs` / `lib/notify.mjs` / `lib/tools.mjs`

### 为什么

以前装完插件只能读媒体会话，还得自己起 hub、自己挂 MCP，对普通用户门槛太高。现在 `hub.url` 留空或指向本机就用内置 hub；指向服务器就自动跳过本地 hub，行为完全不变。

### 已知限制

- 本地 hub 只绑 `127.0.0.1`，别的机器访问不到（要跨机器还是得单独部署 `packages/music-hub`）

---

## v0.3.0 — 2026-10-27

**跟着 DSH 一起跑。** watcher 从独立脚本变成标准 host 插件，同时补齐口味画像和推荐闭环。

### 新增

- `packages/watcher/index.js` + `cordis.patch.yml`：watcher 现在是标准 DSH host 插件，用 `ctx.effect` 注册定时器与销毁逻辑，装进 profile 后随 DSH 一起启动、一起退出
- `packages/watcher/lib/ticker.mjs`：把采集与上报逻辑抽成 `createTicker()`，插件与 CLI 共用同一套代码
- `packages/watcher/lib/netease.mjs`：改为按歌名建索引 + 三级歌手匹配（修掉了「SMTC 只报主歌手、网易云队列里是全歌手」导致 id 永远为 null 的坑）
- `packages/watcher/icon.svg`、`packages/watcher/locale/{en,zh}.json`
- `music_taste` 工具：读写口味画像（歌手好感度 -5..5、风格标签、笔记）
- 推荐闭环：`music_recommend` 写入 `pending`，换歌时匹配，被听到就自动标 `listened`
- `docs/PUBLISHING.md`：插件市场上架流程与当前差距

### 变更

- `packages/watcher/package.json` 补齐 `main` 入口、`dsh.bundle.patch`、`files` 清单、`dsh-plugin` 关键词
- README「快速开始」第 2 步拆成「作为插件」和「独立进程」两种方式

### 已知限制

- host 插件只在 DSH 启动时加载，`install_bundle` 之后必须重启一次才生效
- 只有 Windows 能读 SMTC

---

## v0.2.0 — 2026-10-26

**主动开口。** 换歌时 hub 按策略决定要不要叫醒 agent，说不说由她自己判断。

### 新增

- `packages/music-hub/src/notify.mjs`：发言策略引擎（免打扰时段、最小间隔、来源过滤、模板渲染）
- 三种通知后端：`none`（只记录）/ `qq-bridge`（通过聊天桥接叫醒）/ `webhook`（通用）
- `hub.mjs` 在换歌时调用 `notifier.maybeNotify()`，fire-and-forget，不阻塞上报
- `config.example.json` 的 `behavior.notify` 配置段

### 变更

- 四个 `package.json` 版本号统一到 `0.2.0`
- README 补充「主动开口」配置说明

### 已知限制

- `qq-bridge` 的 `notify-ai` 触发的是 **silent 回合**，agent 必须显式调用发送工具（如 `qq_send_private_message`），纯文本输出不会发出去
- 推荐给用户之后「听没听」的反馈还没追踪（v0.3）
- 口味画像 `music_taste` 还没做（v0.3）

---

## v0.1.0 — 2026-10-25

**能看见、能记住。** 知道在听什么、听过什么、听了多久。

### 新增

- `packages/watcher`：Windows SMTC 读取当前播放；从网易云客户端本地队列补 song id / duration / album
- `packages/music-hub`：纯 Node、零依赖；JSON 落盘、原子写；`/v1/now-playing`、`/v1/history`、`/v1/recommend(ations)`
- `packages/mcp-music`：三个工具 `music_now_playing` / `music_history` / `music_recommend`
- `packages/shared/config.mjs`：三组件统一配置加载（**环境变量 > config.json > 默认值**）
- 播放进度（SMTC 不报 position 时用本地累加推断）、来源标签（netease / bilibili / other）、听完/跳过判定（`listenedSeconds`）
- `deploy/`：服务器一键安装脚本与 Windows 部署脚本
