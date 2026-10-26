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

import { lookupNetease, neteaseStatus } from './netease.mjs';

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

/**
 * 把 SMTC 的 AppUserModelId 归成人能看懂的来源。
 * agent 需要区分「在听歌」和「在看网课」——B 站也会往 SMTC 里塞视频标题。
 */
function classifySource(app) {
  const a = String(app || '').toLowerCase();
  if (a.includes('cloudmusic') || a.includes('netease')) return 'netease';
  if (a.includes('bilibili')) return 'bilibili';
  if (a.includes('qqmusic')) return 'qqmusic';
  if (a.includes('spotify')) return 'spotify';
  if (/(chrome|msedge|firefox|brave|opera|vivaldi)/.test(a)) return 'browser';
  return 'other';
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

let currentSong = null;      // 当前歌曲指纹（歌名|歌手），用来判断换歌
let elapsedSeconds = 0;      // 这首歌已播放的秒数（暂停不累加，换歌清零）
let lastTickAt = Date.now();
let lastLoggedKey = null;    // 日志去重：只在上报内容真的变了时打一行
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
    if (currentSong !== null) {
      log('播放器已退出或无媒体');
      currentSong = null;
      elapsedSeconds = 0;
      lastLoggedKey = null;
    }
    return;
  }

  const playing = String(info.status || '').toLowerCase() === 'playing';
  const artists = info.artist
    ? String(info.artist).split('/').map((s) => s.trim()).filter(Boolean)
    : [];

  // SMTC 只有歌名和歌手；真正的数字 id 在网易云客户端自己的播放队列里。
  // 匹配不上（比如用 B 站听）就留空，hub 那边只是少一个字段，不影响记录。
  const local = lookupNetease(info.title, artists);
  const duration =
    local?.durationSeconds ??
    (typeof info.duration === 'number' && info.duration > 0 ? info.duration : null);

  // 进度：SMTC 对网易云不报 timeline，只能自己累加。
  // 暂停期间不计时、换歌清零 —— 这就是"这首歌听了多久"。
  const songKey = `${info.title}|${info.artist || ''}`;
  const now = Date.now();
  if (songKey !== currentSong) {
    currentSong = songKey;
    elapsedSeconds = 0;
  }
  if (playing) {
    elapsedSeconds += Math.max(0, (now - lastTickAt) / 1000);
  }
  lastTickAt = now;

  const payload = {
    track: {
      title: info.title,
      artists,
      album: local?.album || info.album || '',
      id: local?.id || null,
      duration,
    },
    // 优先用 SMTC 报的进度（有的播放器会报）；网易云不报，就用自己累加的
    progress:
      typeof info.position === 'number' && info.position > 0
        ? info.position
        : Math.round(elapsedSeconds),
    playing,
    device: DEVICE,
    source: classifySource(info.app),
    sourceApp: info.app || '',
  };

  try {
    const result = await push(payload);
    consecutiveErrors = 0;

    // 每轮都发（进度要更新），但日志只在上报内容真的变了时打，免得刷屏
    const logKey = `${songKey}|${playing ? 'playing' : 'paused'}`;
    if (logKey !== lastLoggedKey) {
      lastLoggedKey = logKey;
      log(
        `${playing ? '▶' : '❚❚'} ${payload.track.title} — ${payload.track.artists.join('/') || '未知歌手'}`,
        result?.changed === false ? '(hub 认为没变)' : '',
      );
    }
  } catch (err) {
    consecutiveErrors += 1;
    log(`上报失败（第 ${consecutiveErrors} 次）：`, err.message);
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
