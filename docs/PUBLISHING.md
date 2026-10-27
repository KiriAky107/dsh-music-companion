# 发布到 DSH 插件市场

把本项目挂到插件市场的流程，以及我们目前卡在哪一步。

## 渠道

| 市场 | 地址 | 规模 | 上架方式 |
|---|---|---|---|
| **1024 Store** | https://deepseek1024.com | 11,000+ 插件 | 开 GitHub PR，机器人自动合并 |
| dshfind | https://dshfind.com | 小站 | 没找到公开投稿入口 |

注意：`dsh-plugin-market` / `dsh-community-market` 这类装在 DSH 里的市场插件是**多源聚合器**（抓 GitHub topic），本身不收投稿。

## 两条硬门槛（1024 Store）

1. **`package.json` 必须有 `dsh.bundle.patch`**，指向的 patch 文件得真在仓库里。
2. **发布到 npm** 才会显示「可安装」；没发 npm 也能收录，但只能看，装不了。

## 上架步骤

### 1. 补齐 bundle 声明

`packages/watcher/package.json` 里要有：

```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

patch 文件内容（本仓库已写好）：

```yaml
- insert:
    - id: music-watcher
      name: '@dsh-music/watcher'
      config: {}
```

### 2. 发 npm

`@dsh-music` 这个 scope 还没发过包。两种选择：

- **改用个人 scope**（`@<你的 npm 用户名>/dsh-music-watcher`），最省事
- 或者去 npm 建 `@dsh-music` 组织

发之前把 `private` 去掉（如果设了）。

### 3. 加 topic

仓库 Settings → Topics → 加 `dsh-plugin`。

### 4. 提 catalog JSON

在 [imsai-sh/awesome-deepseek-harness-plugins](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) 的 `catalog/plugins/` 下加一个文件，文件名是 `owner--repo.json`（斜杠换成两个短横）：`Soyoanon-mygo--dsh-music-companion.json`。

必填字段：`$schema` / `id` / `name` / `repository` / `category` / `description.{en,zh}` / `added`。
具体取值以仓库里的 `CONTRIBUTING.md` 为准（字段名和 schema 地址可能变）。

描述要客观中立，别用「最好用」「第一」这类最高级。

### 5. 等机器人

PR 只能动 `catalog/plugins/` 一个文件。过了静态检查就自动 squash merge，网站同步更新。`README.md` 和 `catalog/README.md` 由机器人重建，别手改。

## 我们现在的状态

- ✅ `packages/watcher` 已是标准 host 插件：有 `dsh.bundle.patch`、`cordis.patch.yml`、`main` 入口、`icon.svg`、`locale/{en,zh}.json`
- ❌ 还没发 npm
- ❌ 还没加 `dsh-plugin` topic
- ❌ 还没提 catalog JSON

## 但先别急

上架意味着**别人会装**。在那之前值得先确认：

1. 别人机器上 SMTC 读到的数据和我们一样（不同播放器、不同系统语言）；
2. 网易云本地队列路径在别人机器上也对（`%LOCALAPPDATA%\Netease\CloudMusic\webdata\file\playingList`）；
3. 没有网易云客户端的人怎么办——现在的降级是只有歌名歌手、没有 id 和时长。

这三条没验证过就上架，只会收到一堆「在我这儿用不了」。
