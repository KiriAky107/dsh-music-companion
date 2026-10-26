# dsh-music-companion

> 让你的 DSH 知道你在听什么。

一个很小的扩展：桌面端读出系统媒体会话里正在播放的歌，经一个极简 hub 传给远端 agent。于是她能在聊天里自然接一句「你在听《贵人》？」，也能慢慢攒出你的听歌口味。

**状态：v0.1 骨架，能看见，还不会主动说话。**

---

## 它不做什么

先划清边界，省得误会：

- **不是播放器。** 在 DSH 里放歌这件事已经有人做得很好了（见[相关项目](#相关项目)）。
- **不上传音频。** 只传「歌名 + 歌手 + 播放状态」几个字符串。
- **第一版不碰你的音乐账号。** 不读 cookie、不登录、不调网易云私有接口。

## 它做什么

| 能力 | 版本 |
|---|---|
| 知道你此刻在听什么、有没有在听 | v0.1 ✅ |
| 记住你最近听过哪些歌 | v0.1 ✅ |
| 换歌时决定要不要搭话（而不是每首都播报） | v0.2 |
| 攒够口味后主动推歌，并记住你听没听 | v0.2 |
| 打包成 DSH 插件，上架插件市场 | v0.3 |

---

## 架构

三层，中间只有一个 HTTP 边界。任何一层挂了都不影响聊天——音乐是附加层，不是依赖。

```
┌───────────────────────────┐
│  你的电脑                  │
│                           │
│  网易云 / Spotify / …      │
│      ↓ 系统媒体会话(SMTC)  │
│  watcher  ── 每 20s 读一次  │
│      │                    │
└──────┼────────────────────┘
       │  POST /v1/now-playing
       │  （只在换歌/暂停时发）
       ▼
┌───────────────────────────┐
│  music-hub（一台小服务器）  │
│  收 · 存 · 给              │
│  纯 Node，零依赖，无数据库   │
└──────┬────────────────────┘
       │  127.0.0.1
       ▼
┌───────────────────────────┐
│  mcp-music                 │
│  两个工具：在听什么 / 最近听 │
└──────┬────────────────────┘
       ▼
   DSH agent
```

### 为什么是系统媒体会话

Windows 10 起有个系统级接口 `Windows.Media.Control`，任务栏那个播放小条就是它。它不碰任何播放器的内部结构，换网易云、Spotify、foobar2000 都能读到，也不会随客户端版本失效。

（代价：网易云不上报播放进度，所以第一版没有「听到第 38 秒」这种精度。以后要做，得单独写一个网易云适配器。）

---

## 快速开始

需要 Node.js ≥ 22。

### 1. 起一个 hub

```bash
MUSIC_HUB_TOKEN=$(openssl rand -hex 24) node packages/music-hub/src/hub.mjs
```

默认监听 `127.0.0.1:8787`。数据落在 `packages/music-hub/data/`，纯 JSON，出问题 `cat` 一下就能明白。

### 2. 在桌面端跑 watcher

```bash
MUSIC_HUB_URL=http://127.0.0.1:8787 \
MUSIC_HUB_TOKEN=<上面那个> \
node packages/watcher/watcher.mjs
```

**仅支持 Windows**（读的是系统媒体会话）。启动后每 20 秒读一次，只在换歌或播放/暂停切换时上报。

### 3. 把 mcp-music 挂进 agent

```bash
npm install --prefix packages/mcp-music
```

然后在 DSH 的 MCP 配置里加一条：

```yaml
mcp-servers:
  mcp-music:
    command: node
    args: ["/absolute/path/to/packages/mcp-music/src/server.mjs"]
    env:
      MUSIC_HUB_URL: "http://127.0.0.1:8787"
```

现在问她「我在听什么」，她会去查。

---

## 工具

| 工具 | 说明 |
|---|---|
| `music_now_playing` | 现在在听什么，含播放状态与「多久没更新」 |
| `music_history(limit)` | 最近听过的歌，倒序 |

两个都是只读、无副作用。

---

## 设计取舍

- **状态用 JSON 文件，不用数据库。** 单用户、写频率不到 0.1Hz、读全在本机。文件的好处是出问题能直接看，agent 也能直接读。
- **同一首歌反复暂停不重复记。** 幂等键是 `歌名|歌手`，一首歌听一下午只算听了一次。
- **上报只发变化。** 每 20 秒轮询，但只有指纹变了才发请求，一小时实际请求量是个位数。
- **hub 不主动把歌名塞进对话。** v0.2 会改成「只告诉 agent 有变化」，由她自己决定接不接话——真人也不是每首歌都要评论。

---

## 相关项目

这几个都是「在 DSH 里放歌」，和我们方向不同，但值得一看：

- [doitian/dsh-music](https://github.com/doitian/dsh-music) — 带 AI DJ 的网易云播放器
- [ZhaoZiyangShaanxi/dsh-netease-music](https://github.com/ZhaoZiyangShaanxi/dsh-netease-music) — 读取本地客户端实现自动登录
- [Caiccc-a11y/dsh-wyymusic-player](https://github.com/Caiccc-a11y/dsh-wyymusic-player) — 右侧栏播放器

## 许可

MIT
