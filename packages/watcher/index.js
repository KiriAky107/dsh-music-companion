/**
 * DSH host 插件入口。
 *
 * 装进 DSH Desktop 之后，桌面端一启动就会自动读 SMTC 并上报 ——
 * 不需要手动开终端，也不需要配开机自启的计划任务。
 *
 * 逻辑全在 `lib/ticker.mjs`，CLI 入口（`watcher.mjs`）用的是同一套。
 *
 * 诊断说明：宿主进程的 console.log 不会进 DSH 的日志文件，所以这里把关键
 * 节点额外写到 `%TEMP%\music-watcher-boot.log`。插件"装了但没动静"时先看它。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTicker } from './lib/ticker.mjs';

const stamp = () => new Date().toTimeString().slice(0, 8);
const BOOT_LOG = path.join(os.tmpdir(), 'music-watcher-boot.log');

/** 写一行诊断；写不进去就算了，绝不因为日志把插件搞挂。 */
function trace(...args) {
  const text = args
    .map((a) => (a instanceof Error ? a.stack || a.message : String(a)))
    .join(' ');
  try {
    fs.appendFileSync(BOOT_LOG, `[${new Date().toISOString()}] ${text}\n`);
  } catch {
    /* ignore */
  }
}

export function apply(ctx, config = {}) {
  trace('apply() 被调用，config =', JSON.stringify(config));
  const log = (...args) => {
    console.log(`[music-watcher ${stamp()}]`, ...args);
    trace(...args);
  };

  let ticker;
  try {
    ticker = createTicker({
      hubUrl: config.hubUrl,
      token: config.token,
      pollSeconds: config.pollSeconds,
      device: config.device,
    });
    log('ticker 已创建', ticker.describe());
  } catch (err) {
    log('初始化失败：', err && err.message ? err.message : err);
    return;
  }

  try {
    // ctx.effect 的返回值是清理函数：插件被卸载 / 桌面端退出时自动停掉定时器
    ctx.effect(() => {
      log('effect 回调执行，启动 ticker');
      ticker.start(log);
      return () => {
        log('停止上报');
        ticker.stop();
      };
    }, 'music-watcher');
    log('ctx.effect 注册成功');
  } catch (err) {
    log('ctx.effect 注册失败：', err && err.message ? err.message : err);
  }
}
