#!/usr/bin/env node
/**
 * watcher CLI —— 手动跑 / 调试用。
 *
 * 作为 DSH 插件时入口是 `index.js`，两者共用 `lib/ticker.mjs` 里的同一套逻辑。
 *
 * 环境变量（也支持仓库根的 config.json）：
 *   MUSIC_HUB_URL      hub 地址，默认 http://127.0.0.1:8787
 *   MUSIC_HUB_TOKEN    写接口密钥
 *   MUSIC_POLL_SECONDS 轮询间隔，默认 20
 *   MUSIC_DEVICE       设备标识，默认 desktop-windows
 *
 * 用法：
 *   node watcher.mjs            # 常驻
 *   node watcher.mjs --once     # 跑一轮就退出，用来验证链路
 */

import { createTicker } from './lib/ticker.mjs';

const log = (...args) => {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}]`, ...args);
};

const ticker = createTicker();

if (process.argv.includes('--once')) {
  // 单次模式：跑一轮就退出，用来验证链路是否通
  await ticker.tick(log);
  process.exit(0);
}

ticker.start(log);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig}，退出`);
    ticker.stop();
    process.exit(0);
  });
}
