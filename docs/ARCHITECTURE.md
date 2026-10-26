# dsh-music-companion · 架构设计

> 一句话：让 DSH 里的 AI **知道你此刻在听什么**，能接话、能记口味，然后在 QQ 上**主动把下一首推给你**。

版本：v0 设计稿（2026-10-26）
作者：Soyoanon

---

## 1. 为什么要做这个

2026 年 10 月，DSH 生态里冒出过三个音乐插件：

| 项目 | 做了什么 |
|---|---|
| `doitian/dsh-music` | 在 DSH 窗口里放歌，带 7 个 agent 工具和一个 AI DJ |
| `ZhaoZiyangShaanxi/dsh-netease-music` | 迷你播放条、液态玻璃卡片、自动登录本地网易云 |
| `Caiccc-a11y/dsh-wyymusic-player` | 在右侧栏听歌 |

它们的共同点是：**播放器**。你把歌放进 DSH，它负责播好、管好队列。

但"一起听"这件事的重点根本不在播放。真正的体验是这样的：

> 你在网易云点了《晴天》，三分钟后手机 QQ 弹出一条消息：
> 「哦你在听晴天欸，这首歌你是不是从小听到大的那首？刚副歌那段和声其实有点走调哈哈」
>
> 你回：「你怎么知道」
>
> 她说：「因为上个月你单曲循环了 47 遍，我记着呢」

**播放器解决"听"，这个项目解决"陪"。**

两者不冲突——你想在 DSH 窗口里看歌词、拖进度条，装前三个里的任意一个；你只是想要"有人在旁边"的感觉，装这个。

---

## 2. 设计目标与非目标

### 目标

1. **不碰客户端**：不给网易云打补丁、不注入、不改 dll，只读它自己写在磁盘上的状态。
2. **跨机器可跑**：桌面机器和 agent 所在服务器物理隔离，中间只用 HTTP。
3. **每一环都能挂**：网断了、客户端没开、服务器重启，聊天照常进行，只是暂时"听不见"。
4. **零外部依赖**：服务端只用 Node 内置模块，不引框架、不用数据库，`git clone` 完就能跑。
5. **可被审计**：所有数据是磁盘上的 JSON，出问题 `cat` 一下就知道。

### 非目标

- **不做播放器**。DSH 里放歌已有成熟实现，重复造轮子没意义。
- **不做实时「一起听」房间**。网易云的实时房间接口不稳定、对同一账号多端登录敏感，拿小号synchronized 播放是高风险动作。本项目的"一起"是**异步陪伴**。
- **不处理账号密码**。桌面侧读的是客户端**已经登录后**落盘的会话，服务端只认 token，拿不到你的网易云账号。
- **不做移动端**。手机上的网易云状态拿不到，桌面才有。

---

## 3. 系统架构

```
┌───────────────────── 你的电脑（Windows） ─────────────────────┐
│                                                              │
│   网易云音乐客户端                                             │
│        │  登录后把会话写进                                     │
│        │  %LOCALAPPDATA%\Netease\CloudMusic\webapp*\           │
│        │  + LocalPrefs.json（DPAPI 加密）+ Cookies（sqlite）    │
│        ▼                                                     │
│   ┌──────────────────────────────────────────────┐          │
│   │  dsh-music-companion  （DSH host 插件）        │          │
│   │                                              │          │
│   │  watcher  每 20s 读一次 now-playing           │          │
│   │     │  只在「歌换了」或「进度跨过 30s 网格」时报 │          │
│   │     ▼                                        │          │
│   │  uplink   POST /v1/now-playing               │          │
│   │  downlink 每 30s GET /v1/recommendations     │          │
│   └──────────────────────────────────────────────┘          │
│                                                              │
└───────────────────────────────┬──────────────────────────────┘
                                │  HTTPS（出站，NAT 后面也能连）
                                │  Authorization: Bearer <token>
                                ▼
┌───────────────────── 服务器（Linux / 云主机） ─────────────────┐
│                                                              │
│   ┌──────────────────────────────────────────────┐          │
│   │  music-hub  （Node，~200 行，无依赖）          │          │
│   │                                              │          │
│   │  POST /v1/now-playing    ← 桌面推上来的播放态 │          │
│   │  GET  /v1/now-playing    →                           │          │
│   │  POST /v1/recommendations ← agent 写推荐      │          │
│   │  GET  /v1/recommendations → 桌面拉结果        │          │
│   │  GET  /v1/taste          → 口味聚合           │          │
│   │                                              │          │
│   │  状态全在磁盘：                                │          │
│   │    state/now-playing.json                    │          │
│   │    state/history.jsonl                       │          │
│   │    state/recommendations.jsonl               │          │
│   │    state/taste.json                          │          │
│   └──────────────────────────────────────────────┘          │
│                                │ 127.0.0.1:8787              │
│                                ▼                             │
│   ┌──────────────────────────────────────────────┐          │
│   │  mcp-music  （MCP server，~150 行）           │          │
│   │                                              │          │
│   │  music_now_playing()  → 现在在听啥            │          │
│   │  music_history(n)     → 最近听了啥            │          │
│   │  music_taste()        → 他喜欢啥              │          │
│   │  music_recommend()    → 推一首                │          │
│   └──────────────────────────────────────────────┘          │
│                                │                             │
│                                ▼                             │
│                        QQ agent（已有）                       │
└──────────────────────────────────────────────────────────────┘
```

三个组件、两条链路，中间只有一个 HTTP 边界。

---

## 4. 组件详解

### 4.1 `dsh-music-companion` — 桌面侧（DSH host 插件）

跑在 DSH 的 host 半区（`ctx.server` 有 Node 权限，能读文件、发请求）。

**watcher**

每 20 秒读一次 **Windows 系统媒体会话（SMTC）**：

```
GlobalSystemMediaTransportControlsSessionManager.RequestAsync()
  → GetCurrentSession()
     → SourceAppUserModelId      "cloudmusic.exe" / "Spotify.exe" / 浏览器
     → TryGetMediaPropertiesAsync()
          Title / Artist / AlbumTitle
     → GetPlaybackInfo()          Playing / Paused
     → GetTimelineProperties()    Position / EndTime
```

> **为什么走 SMTC 而不是读网易云内部**：SMTC 是 Windows 10+ 的系统级标准，任务栏那个小播放条就是它。它不碰客户端内部结构、不依赖客户端版本、天然跨播放器（网易云 / Spotify / foobar2000 / 网页播放器都能拿到）。读 cookie + sqlite 那条路只在 Windows 且客户端登录时成立，还容易随版本失效。

**实测（2026-10-26，本机）**：稳定拿到 `cloudmusic.exe` / `贵人` / `回春丹` / `Playing`。

**已知限制**：网易云不上报 timeline，`Position` / `EndTime` 恒为 `00:00:00`。所以：

- 进度标为**可选**，拿不到就不传；
- 幂等键退化为 `sha1(title:artist)`，同一首歌在一天内只记一次"开始听"；
- 需要更精确的进度时，由 v0.3 的「网易云增强适配器」补（读客户端内部状态，Windows 专属，装不装都行）。

> 非 Windows 平台第一版直接不支持，README 里明说。macOS 的 `MPNowPlayingInfoCenter` 是同类东西，v0.3 再补。

**uplink**

算出幂等键：

```
key = sha1(`${title}:${artist}`)
```

key 与上一次相同 → 不发。不同 → `POST /v1/now-playing`。
播放/暂停切换单独上报（`{"status":"paused"}`），不重复写 history —— 一首歌反复暂停十次也只算听了一次。

**downlink**

每 30 秒 `GET /v1/recommendations?since=<上次拿到的 id>`，拿到新推荐后：

- 在 DSH 里发一条 notification / 写一条会话事件（"她推荐你听《xxx》，理由是……"）
- 可选：做成侧边栏小组件，点一下用 `music_play` 之类的工具调起播放

**配置**（存 `~/.dsh/music-companion.json`，0600）：

```json
{
  "hubUrl": "https://your-host:18080",
  "token": "…",
  "pollSeconds": 20,
  "notifyOnRecommendation": true
}
```

### 4.2 `music-hub` — 服务器侧（纯 Node）

一个 `http.createServer`，无依赖，`node hub.mjs` 就起来。默认监听 `127.0.0.1:8787`，由反向代理（Caddy / nginx / 云厂商的端口映射）暴露到公网。

职责很窄：

- **认证**：`Authorization: Bearer <MUSIC_HUB_TOKEN>`，token 从环境变量读，常量时间比较。
- **写入**：`POST /v1/now-playing` 原子写 `now-playing.json`（`writeFile` + `rename`），并 append 一行到 `history.jsonl`。
- **限流**：同一 `trackId` 60 秒内只接受一次进度更新（防客户端抖动把磁盘写爆）。
- **读取**：`GET /v1/now-playing`、`GET /v1/taste`、`GET /v1/recommendations?since=`。
- **清理**：`history.jsonl` 超过 50 MB 时轮转（保留最近 30 天）。

**为什么是文件不是数据库**：单用户、写频率 < 0.1 Hz、读全部在 127.0.0.1。SQLite 在这里是过度设计，JSON 的好处是 agent 可以直接 `cat` 来调试。

### 4.3 `mcp-music` — 供 agent 调用的 MCP server

挂在 web profile 的 `cordis.patch.yml` 里，stdin/stdout 的 MCP 协议，四个工具：

| 工具 | 返回 | 用途 |
|---|---|---|
| `music_now_playing()` | track 对象 或 `null` | "他在听什么" |
| `music_history(limit)` | track 数组 | "最近听过的" |
| `music_taste()` | `{ likes, avoid, recentObsession }` | 推荐依据 |
| `music_recommend({title, artist?, reason})` | `{ id }` | 写进桌面能拉到的队列 |

`music_taste()` 的数据来源有两条路，按可用性选：

1. **优先**：`state/taste.json` —— 由 agent 自己在对话中维护（她可以调 `music_taste` 读、也可以直接写文件）
2. **兜底**：从 `history.jsonl` 做简单的频次聚合（近 30 天出现最多的 artists）

不做"自动画像"——画像该由**她**按人的方式建立，不是统计程序拍出来的。

---

## 5. 两条数据流

### 5.1 上行：陪听

```
你按下播放
  → 20s 内 watcher 读到变化
  → POST /v1/now-playing {track, progress, playing}
  → hub 写盘 + 记 history
  → hub 判断：歌变了？→ 调 qq-bridge 的 notify-ai（带一句提示词）
  → agent 醒来，调 music_now_playing() 拿到完整信息
  → 她决定要不要说话（不是每首歌都值得接话）
```

**关键设计**：hub **不把歌名直接塞进对话**，只发一个「有变化」的信号，让 agent 自己决定要不要调工具、要不要说话。这样她能有"懒得理你这首"的余地——真人也是这样。

**节流**：同一次唤醒 3 分钟内不再唤醒（`notify-ai` 会打断当前回合，是已知坑）。

### 5.2 下行：推歌

```
agent 在闲聊中摸清你的口味
  → 调 music_recommend({title, artist, reason})
  → hub 写 recommendations.jsonl
  → 30s 内桌面 downlink 拉到
  → DSH 弹一条：她推了《xxx》，理由……
```

**闭环**：你听了那首歌 → 上行链路记录 → 她的 `music_taste` 里就有"我推的这首他听了/没听"，下次推荐更准。

这就是 A2 和 A3 的联系点：**听 → 记 → 推 → 再听**。

---

## 6. HTTP 协议

所有请求/响应都是 JSON，`Content-Type: application/json`。

### `POST /v1/now-playing`

```json
{
  "track": {
    "title": "贵人",
    "artists": ["回春丹"],
    "album": "",
    "id": null,
    "duration": null
  },
  "progress": null,
  "playing": true,
  "device": "desktop-windows",
  "source": "smtc/cloudmusic.exe"
}
```

`id` / `duration` / `progress` 都可为 `null` —— 走 SMTC 时拿不到，走 v0.3 增强适配器时才补齐。服务端与 agent 都必须容忍 `null`。

响应：`201 {"ok":true,"changed":true}`

### `GET /v1/now-playing`

```json
{ "track": {...}, "progress": null, "playing": true, "stale": false, "updatedAt": "2026-10-26T03:12:00Z" }
```

超过 10 分钟没更新时返回 `{ "stale": true, ... }`，让 agent 知道"可能已经没在听了"。

### `GET /v1/recommendations?since=<id>`

```json
{ "items": [ { "id": 7, "title": "海阔天空", "artist": "Beyond", "reason": "你上次循环了三天《真的爱你》", "createdAt": "..." } ] }
```

### `POST /v1/recommendations`

```json
{ "title": "海阔天空", "artist": "Beyond", "reason": "…" }
```

响应：`201 {"id":7}`

### `GET /v1/taste`

```json
{ "likes": ["周杰伦", "陈奕迅"], "avoid": ["重金属"], "recentObsession": ["《晴天》47 遍"] }
```

---

## 7. 安全与隐私

这个项目的敏感点是**听歌口味**——它比大多数人以为的更私密。

| 风险 | 处置 |
|---|---|
| token 泄露 → 别人能伪造播放状态 / 读到你的口味 | token 只存环境变量与 0600 文件；hub 日志不打印 token；轮换只需重启 |
| 仓库里混进真实数据 | `.gitignore` 覆盖 `state/`、`*.jsonl`、`~/.dsh/music-companion.json`；CI 加 gitleaks |
| 网易云 cookie 被记录 | **绝不进入本项目任何代码路径**——桌面插件只在内存里用，不落盘、不上送、不日志 |
| hub 暴露公网被别人扫到 | 必须 HTTPS + Bearer；无 token 一律 401，不做"公开只读"选项 |

**仓库永远不含**：网易云账号、cookie、你自己的 token、真实的 `state/` 目录。

---

## 8. 失败模式

| 挂了 | 表现 | 恢复 |
|---|---|---|
| 网易云没开 / 未登录 | watcher 静默跳过，不上报 | 下次开起来自动恢复 |
| 桌面断网 | uplink 失败，指数退避重试（20s→40s→80s，封顶 5 分钟） | 网络恢复后自动续 |
| 服务器重启 | hub 起来后状态从磁盘恢复；桌面 downlink 重连 | 无感 |
| hub 挂了 | agent 调工具报错，她在聊天里说"我暂时听不见你" | systemd `Restart=always` |
| 你 10 分钟没动静 | `now-playing` 标 `stale`，agent 不主动提音乐 | 自动 |
| 一首歌循环一天 | history 里全是同一条，taste 聚合会偏 | 按 `trackId` 去重后按天统计 |

原则：**任何一环挂掉，都不应该让聊天本身出错**。音乐是附加层，不是依赖。

---

## 9. 路线图

**v0.1 — 能看见**（约 3 个晚上）
- [ ] 桌面 watcher 能读到 now-playing（Windows）
- [ ] `music-hub` 收 / 存 / 给
- [ ] `mcp-music` 的 `music_now_playing` + `music_history`
- [ ] agent 在 QQ 里能说"你现在在听《x》"

**v0.2 — 能记住**
- [ ] `music_taste` 读写
- [ ] `music_recommend` + 桌面通知
- [ ] 端到端 demo GIF 进 README

**v0.3 — 能复用**
- [ ] 抽掉「QQ」和「DSH」的耦合，做成通用「now-playing bridge」
- [ ] macOS 支持（AppleScript 读 Music.app；网易云 macOS 版状态读法待调研）
- [ ] 其他音乐源适配器接口（Spotify / 本地播放器）

**明确不做**
- 实时一起听房间
- 自动播放控制（替你切歌）——除非用户显式要求

---

## 10. 开源形态

```
dsh-music-companion/
├── README.md                  # 中英双语，开头一张 GIF
├── LICENSE                    # MIT
├── docs/
│   ├── ARCHITECTURE.md        # 就是这份
│   └── SETUP.md               # 从零到跑通的完整步骤
├── packages/
│   ├── dsh-plugin/            # 桌面侧：DSH host 插件
│   │   ├── package.json       # dsh.bundle + dsh.client 元数据
│   │   └── src/
│   │       ├── index.ts       # 插件入口（ctx.server 挂 watcher）
│   │       ├── netease.ts     # 读客户端状态（DPAPI + sqlite）
│   │       └── uplink.ts      # 上行/下行
│   ├── music-hub/             # 服务器侧
│   │   ├── hub.mjs
│   │   └── state/.gitkeep
│   └── mcp-music/             # MCP server
│       └── server.mjs
├── deploy/
│   ├── music-hub.service      # systemd
│   ├── Caddyfile.example
│   └── docker-compose.yml
└── examples/
    └── cordis.patch.example.yml
```

**发布节奏**：先 private 跑通 v0.2 的真实闭环，把 GIF 和真实对话截图放 README，再 public。第一个开源项目宁可小而完整，不要大而空。

**License**：MIT —— 这个领域大家都在互相抄思路，别设门槛。

---

## 11. 待定问题

### 已解决（2026-10-26 实测）

1. ~~**now-playing 怎么读**~~ → **走 Windows SMTC**，不读网易云内部。实测拿到 `cloudmusic.exe / 贵人 / 回春丹 / Playing`，零侵入、跨播放器。
2. **顺手验证过但不采用的路线**（留档，避免以后重复踩）：
   - 网易云客户端本地监听 `127.0.0.1:20017`，但 `GET /` 返回 404、`/api`、`/status` 等全部无响应 → 不是公开 HTTP 接口，暂时放弃。
   - 读客户端 cookie 链**是可行的**：`LocalPrefs.json` 的 `os_crypt.encrypted_key` 走 DPAPI `ProtectedData.Unprotect` 得到 32 字节 AES-256 key，`Cookies` 表里 `MUSIC_U`（`v10` 前缀 + 12B nonce + ciphertext + 16B tag）用 AES-256-GCM 可解开 994 字节，带上去调 `/api/nuser/account/get` **返回 `code: 200` 且 profile 完整**。这条路留着做 v0.3 的「增强适配器」（能拿到歌曲 id、专辑封面、真实进度），但**不作为第一版的主路径**——它太依赖客户端版本和 Windows。

### 还没定

3. **回环端口怎么暴露**：雨云 NAT 只有 10 个端口配额。选项：(a) 面板再开一个 map 到 8787；(b) 桌面侧开 SSH 反向隧道 `ssh -R 8787:127.0.0.1:8787`，不占公网端口；(c) 服务器上跑 Caddy 反代，复用 443。
4. **是否支持多设备**：现在假设只有一台桌面。多设备要加 `device` 维度和"最后活跃设备"判定，v0.3 再说。
5. **推荐是不是要落成"播放队列"**：v0.2 只做通知，不自动播放——自动播放越权感太强。
6. **项目名**：暂定 `dsh-music-companion`，可换。

