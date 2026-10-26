# dsh-music-companion

> 让你的 DSH 知道你在听什么，并且听得懂。

一个很小的扩展：桌面端读出系统媒体会话里正在播放的歌，经一个极简 hub 传给远端 agent。于是她能在聊天里自然接一句「你在听《春日影》？」，也能慢慢攒出你的听歌口味，哪天主动推一首过来。

**目前的更新状态：v0.1 可用——能看见、能查歌词、能回推歌**

---

## 它不做什么

先划清边界，省得误会：

- **不是播放器。** 在 DSH 里放歌这件事已经有人做得很好了（见[相关项目](#相关项目)）。
- **不上传音频。** 只传几行元数据，没有音频流。
- **不碰你的账号凭证。** 不读 cookie、不登录、不调网易云的私有接口。歌曲 ID 是从客户端自己的播放队列文件里读的，纯粹是本地文件。

## 它做什么

| 能力 | 版本 |
|---|---|
| 知道你此刻在听什么、有没有在听、听到第几秒 | v0.1 ✅ |
| 记住你最近听过哪些歌、每首听了多久 | v0.1 ✅ |
| 拿到歌曲 ID、时长、来源（音乐 / B站视频 / 其他） | v0.1 ✅ |
| agent 主动把歌推进你的推荐队列 | v0.1 ✅ |
| 换歌时自己决定要不要搭话（而不是每首都播报） | v0.2 |
| 攒够口味后主动推歌，并记住你听没听 | v0.2 |
| 打包成 DSH 插件，上架插件市场 | v0.3 |

---

## 架构

三层，中间只有一个 HTTP 边界。任何一层挂了都不影响聊天——音乐是附加层，不是依赖。

```
┌───────────────────────────┐
│  你的电脑                  │
│                           │
│  网易云 / Spotify / B站    │
│      ↓ 系统媒体会话(SMTC)  │
│  watcher  ── 每 20s 读一次  │
│      │  + 本地队列查 song id│
└──────┼────────────────────┘
       │  POST /v1/now-playing
       │  （每轮都发，带进度）
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
│  三个工具：在听什么 / 最近听 │
│  / 推首歌                   │
└──────┬────────────────────┘
       ▼
   DSH agent
```

### 为什么用系统媒体会话

Windows 10 起有个系统级接口 `Windows.Media.Control`，任务栏那个播放小条就是它。它不碰任何播放器的内部结构，换网易云、Spotify、foobar2000 都能读到，也不会随客户端版本失效。

代价是**网易云不上报播放位置**（`Position` 永远是 0）。所以进度是 watcher 自己累加推断的：每轮记一次时间差，只在 `playing` 为真时累加，换歌归零。拖进度条或长时间暂停会有偏差，v0.2 补精确值。

### 为什么读本地队列拿 song id

agent 想查歌词、拉热评、找相似歌，都得先有数字 id，而 SMTC 只给歌名和歌手。按名字去搜索接口反查，同名歌一撞就废。

网易云客户端自己会在 `%LOCALAPPDATA%\Netease\CloudMusic\webdata\file\playingList` 里写一份播放队列，带精确 id 和时长，是明文 JSON。读它比调接口更准、更快、也更不容易被风控。

匹配时有个坑：SMTC 常常只报主歌手（「指错」），本地队列里却是全部歌手（「指错/星尘」）。所以匹配是分级的——先找歌手集合完全一致的，再找歌手互相包含的，最后如果歌名在队列里唯一就直接用。

---

## 快速开始

需要 Node.js ≥ 22。

### 1. 起一个 hub

```bash
MUSIC_HUB_TOKEN=$(openssl rand -hex 24) node packages/music-hub/src/hub.mjs
```

默认监听 `127.0.0.1:8787`。数据落在 `packages/music-hub/data/`，纯 JSON，出问题 `cat` 一下就能明白。

要跨机器用（watcher 和 hub 不在同一台），把 `MUSIC_HUB_HOST` 设成 `0.0.0.0`，并且**务必设一个足够长的 `MUSIC_HUB_TOKEN`**——`/v1/*` 全部接口都要鉴权。

### 2. 在桌面端跑 watcher

```bash
MUSIC_HUB_URL=http://127.0.0.1:8787 \
MUSIC_HUB_TOKEN=<上面那个> \
node packages/watcher/watcher.mjs
```

**仅支持 Windows**（读的是系统媒体会话）。启动后每 20 秒读一次，每轮都上报（进度在变），但相同的歌只会写一次历史。

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
      MUSIC_HUB_TOKEN: "<同一个 token>"
```

现在问她「我在听什么」，她会去查。

---

## 工具

| 工具 | 说明 |
|---|---|
| `music_now_playing` | 现在在听什么：歌名、歌手、专辑、ID、时长、进度、来源 |
| `music_history(limit)` | 最近听过的歌，倒序，附「上一首听了多久」 |
| `music_recommend(title, artist, reason?, id?)` | 把一首歌放进推荐队列，等桌面端拉取 |

前两个只读，第三个是唯一有副作用的。

### 数据长什么样

hub 存的 `now-playing.json`：

```json
{
  "track": {
    "title": "陪葬夏天的健忘录",
    "artists": ["指错"],
    "album": "陪葬夏天的健忘录",
    "id": "2757490399",
    "duration": 218
  },
  "progress": 51,
  "playing": true,
  "device": "desktop-windows",
  "source": "netease",
  "startedAt": "2026-10-26T10:12:45.821Z",
  "updatedAt": "2026-10-26T10:13:36.317Z",
  "stale": false,
  "ageSeconds": 0
}
```

历史里每条还多一个 `listenedSeconds`——它是「换到下一首之前，这首听了多久」。配合 `duration` 就能判断你是听完了还是跳过：

- 听了 40s / 218s ≈ 18% → 跳过
- 听了 195s / 218s ≈ 89% → 听完


---

## 设计取舍

- **状态用 JSON 文件，不用数据库。** 单用户、写频率不到 0.1Hz、读全在本机。文件的好处是出问题能直接看，agent 也能直接读。
- **同一首歌反复暂停不重复记。** 幂等键是 `歌名|歌手`，一首歌听一下午只算听了一次。
- **进度是自己算的，不是读的。** 网易云不报位置，只能靠累加计时。这是已知的精度损失，明写在数据里而不是假装准。
- **hub 不主动把歌名塞进对话。** v0.2 会改成「只告诉 agent 有变化」，由她自己决定接不接话——真人也不是每首歌都要评论。
- **来源单独一个字段。** SMTC 会把 B 站视频也算成"正在播放"，所以 `source` 用来区分 `netease` / `bilibili` / `other`，免得听歌记录里混进一堆网课。

---

## 相关项目

这几个都是「在 DSH 里放歌」，和我们方向不同，但值得一看：

- [doitian/dsh-music](https://github.com/doitian/dsh-music) — 带 AI DJ 的网易云播放器
- [ZhaoZiyangShaanxi/dsh-netease-music](https://github.com/ZhaoZiyangShaanxi/dsh-netease-music) — 读取本地客户端实现自动登录
- [Caiccc-a11y/dsh-wyymusic-player](https://github.com/Caiccc-a11y/dsh-wyymusic-player) — 右侧栏播放器

## 许可

MIT
