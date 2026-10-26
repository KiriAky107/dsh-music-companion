#!/usr/bin/env node
/**
 * watcher — 把"你正在听什么"推给 music-hub
 *
 * 只做一件事：每 N 秒读一次 Windows 系统媒体会话（SMTC），
 * 歌变了或播放状态变了就 POST 一次。同样的状态重复出现不会重复发。
 *
 * 环境变量：
 *   MUSIC_HUB_URL      hub 地址，默认 http://127.0.0.1:8787
 *   MUSIC_HUB_TOKEN    写接口密钥
 *   MUSIC_POLL_SECONDS 轮询间隔，默认 20
 *   MUSIC_DEVICE       设备标识，默认 desktop-windows
 *
 * 用法：
 *   MUSIC_HUB_URL=https://your-host MUSIC_HUB_TOKEN=xxx node watcher.mjs
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PS1 = path.join(HERE, 'smtc.ps1');

const HUB_URL = (process.env.MUSIC_HUB_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TOKEN = (process.env.MUSIC_HUB_TOKEN || '').trim();
const POLL_SECONDS = Math.max(5, Number(process.env.MUSIC_POLL_SECONDS || 20));
const DEVICE = process.env.MUSIC_DEVICE || 'desktop-windows';

const log = (...args) => {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}]`, ...args);
};

/* ------------------------------------------------------------------ */
/* 读 SMTC                                                             */
/* ------------------------------------------------------------------ */

async function readSmtc() {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1],
    { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 },
  );

  // PowerShell 可能先打几行警告，真正的 JSON 在最后一行
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();

  if (!line) throw new Error('empty output from smtc.ps1');
  return JSON.parse(line);
}

/* ------------------------------------------------------------------ */
/* 推给 hub                                                            */
/* ------------------------------------------------------------------ */

async function push(state) {
  const res = await fetch(`${HUB_URL}/v1/now-playing`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(state),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`hub returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */

let lastKey = null; // 上一次上报的指纹，重复的不发
let consecutiveErrors = 0;

async function tick() {
  let info;
  try {
    info = await readSmtc();
  } catch (err) {
    log('读 SMTC 失败：', err.message);
    return;
  }

  // 没有播放器在跑：什么都不发，让 hub 自己按超时标 stale
  if (!info || !info.found || !info.title) {
    if (lastKey !== null) {
      log('播放器已退出或无媒体');
      lastKey = null;
    }
    return;
  }

  const playing = String(info.status || '').toLowerCase() === 'playing';
  const key = `${info.title}|${info.artist || ''}|${playing ? 'playing' : 'paused'}`;
  if (key === lastKey) return;

  const payload = {
    track: {
      title: info.title,
      artists: info.artist ? String(info.artist).split('/').map((s) => s.trim()).filter(Boolean) : [],
      album: info.album || '',
      id: null,
      duration: typeof info.duration === 'number' && info.duration > 0 ? info.duration : null,
    },
    progress: typeof info.position === 'number' && info.position > 0 ? info.position : null,
    playing,
    device: DEVICE,
    source: `smtc/${info.app || 'unknown'}`,
  };

  try {
    const result = await push(payload);
    lastKey = key;
    consecutiveErrors = 0;
    log(`${playing ? '▶' : '❚❚'} ${payload.track.title} — ${payload.track.artists.join('/') || '未知歌手'}`,
      result?.changed === false ? '(hub 认为没变)' : '');
  } catch (err) {
    consecutiveErrors += 1;
    log(`上报失败（第 ${consecutiveErrors} 次）：`, err.message);
    // 失败时不更新 lastKey，下一轮重试同一首歌
  }
}

log(`watcher 启动：每 ${POLL_SECONDS}s 读一次 SMTC → ${HUB_URL}`);

if (process.argv.includes('--once')) {
  // 单次模式：跑一轮就退出，用来验证链路是否通
  await tick();
  process.exit(0);
}

await tick();
setInterval(tick, POLL_SECONDS * 1000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig}，退出`);
    process.exit(0);
  });
}
