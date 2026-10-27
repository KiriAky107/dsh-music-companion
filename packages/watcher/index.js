/**
 * DSH host 插件入口。
 *
 * 装进 DSH Desktop 之后，桌面端一启动就会自动读 SMTC 并上报 ——
 * 不需要手动开终端，也不需要配开机自启的计划任务。
 *
 * 逻辑全在 `lib/ticker.mjs`，CLI 入口（`watcher.mjs`）用的是同一套。
 */

import { createTicker } from './lib/ticker.mjs';

const stamp = () => new Date().toTimeString().slice(0, 8);

export function apply(ctx, config = {}) {
  const log = (...args) => console.log(`[music-watcher ${stamp()}]`, ...args);

  let ticker;
  try {
    ticker = createTicker({
      hubUrl: config.hubUrl,
      token: config.token,
      pollSeconds: config.pollSeconds,
      device: config.device,
    });
  } catch (err) {
    log('初始化失败：', err && err.message ? err.message : err);
    return;
  }

  // ctx.effect 的返回值是清理函数：插件被卸载 / 桌面端退出时自动停掉定时器
  ctx.effect(() => {
    ticker.start(log);
    return () => {
      log('停止上报');
      ticker.stop();
    };
  }, 'music-watcher');
}
