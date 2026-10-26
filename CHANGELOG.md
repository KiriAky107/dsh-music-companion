# 更新日志

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
