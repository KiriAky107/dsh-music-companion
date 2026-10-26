#!/usr/bin/env node
/**
 * music-hub — 极简音乐状态中枢
 *
 * 只做三件事：收、存、给。没有数据库，没有依赖，出问题 `cat` 一下就能明白。
 *
 * 环境变量：
 *   MUSIC_HUB_PORT     监听端口，默认 8787
 *   MUSIC_HUB_HOST     绑定地址，默认 127.0.0.1（对公网暴露请用反代/隧道）
 *   MUSIC_HUB_TOKEN    写接口的共享密钥；不设则所有写接口直接拒绝
 *   MUSIC_HUB_DATA     数据目录，默认 ../data
 *   MUSIC_HUB_STALE_SECONDS  多久没更新算"没在听"，默认 600
 *
 * 接口：
 *   POST /v1/now-playing     每首歌只发一次（播放/暂停切换也发）
 *   GET  /v1/now-playing     当前状态（含 stale 标记）
 *   GET  /v1/history?limit=  最近听过的歌，默认 20
 *   POST /v1/recommend       agent 写推荐（v0.2 用）
 *   GET  /v1/recommendations 桌面轮询拉推荐
 *   GET  /health             存活探针（不需要 token）
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.MUSIC_HUB_PORT || 8787);
const HOST = process.env.MUSIC_HUB_HOST || '127.0.0.1';
const TOKEN = (process.env.MUSIC_HUB_TOKEN || '').trim();
const DATA_DIR = process.env.MUSIC_HUB_DATA || path.join(HERE, '..', 'data');
const STALE_MS = Number(process.env.MUSIC_HUB_STALE_SECONDS || 600) * 1000;

const FILES = {
  now: path.join(DATA_DIR, 'now-playing.json'),
  history: path.join(DATA_DIR, 'history.jsonl'),
  recs: path.join(DATA_DIR, 'recommendations.json'),
};

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

/** 原子写：先写临时文件再 rename，断电也不会留下半个 JSON */
const writeJson = (file, obj) => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
};

const readHistory = (limit) => {
  const lines = [];
  try {
    const raw = fs.readFileSync(FILES.history, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        /* 跳过坏行，不要让一行坏数据毁掉整个历史 */
      }
    }
  } catch {
    /* 文件还不存在 */
  }
  return lines.slice(-limit).reverse();
};

const appendHistory = (entry) => {
  fs.appendFileSync(FILES.history, `${JSON.stringify(entry)}\n`);
};

const trackKey = (track) =>
  `${(track?.title || '').trim()}|${(track?.artists || []).join(',')}`;

const log = (...args) => {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}]`, ...args);
};

/* ------------------------------------------------------------------ */
/* HTTP 小框架                                                         */
/* ------------------------------------------------------------------ */

const send = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
};

const readBody = (req, limit = 64 * 1024) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });

/** 写接口鉴权：Authorization: Bearer <token> 或 ?token=<token> */
const authorized = (req, url) => {
  if (!TOKEN) return false; // 没配 token 就等于没开写接口
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ') && header.slice(7).trim() === TOKEN) return true;
  return url.searchParams.get('token') === TOKEN;
};

/* ------------------------------------------------------------------ */
/* 业务                                                                */
/* ------------------------------------------------------------------ */

/** 上一首歌，用来判断是不是真的换歌了 */
let lastKey = (() => {
  const prev = readJson(FILES.now, null);
  return prev?.track ? trackKey(prev.track) : null;
})();

function handleNowPlaying(body) {
  if (!body || !body.track || !body.track.title) {
    return { status: 400, payload: { ok: false, error: 'track.title is required' } };
  }

  const track = {
    title: String(body.track.title).slice(0, 200),
    artists: Array.isArray(body.track.artists)
      ? body.track.artists.map((a) => String(a).slice(0, 100)).slice(0, 8)
      : [],
    album: body.track.album ? String(body.track.album).slice(0, 200) : '',
    id: body.track.id ?? null,
    duration: typeof body.track.duration === 'number' ? body.track.duration : null,
  };

  const playing = body.playing !== false;
  const now = new Date().toISOString();
  const key = trackKey(track);
  const changed = key !== lastKey;

  const state = {
    track,
    progress: typeof body.progress === 'number' ? body.progress : null,
    playing,
    device: body.device ? String(body.device).slice(0, 64) : 'unknown',
    source: body.source ? String(body.source).slice(0, 64) : 'unknown',
    updatedAt: now,
    stale: false,
  };
  writeJson(FILES.now, state);

  // 只有"换歌 + 在播放"才记历史，暂停/继续不记
  if (changed && playing) {
    appendHistory({ at: now, track, device: state.device });
    lastKey = key;
    log(`history += ${track.title} — ${track.artists.join('/') || '未知歌手'}`);
  }

  return { status: 200, payload: { ok: true, changed } };
}

function handleGetNowPlaying() {
  const state = readJson(FILES.now, null);
  if (!state) {
    return { status: 404, payload: { ok: false, error: 'no data yet' } };
  }
  const age = Date.now() - new Date(state.updatedAt).getTime();
  return {
    status: 200,
    payload: { ...state, stale: age > STALE_MS, ageSeconds: Math.round(age / 1000) },
  };
}

function handleRecommend(body) {
  if (!body || !body.title) {
    return { status: 400, payload: { ok: false, error: 'title is required' } };
  }
  const list = readJson(FILES.recs, []);
  const item = {
    id: `r${Date.now().toString(36)}`,
    title: String(body.title).slice(0, 200),
    artist: body.artist ? String(body.artist).slice(0, 100) : '',
    reason: body.reason ? String(body.reason).slice(0, 500) : '',
    at: new Date().toISOString(),
  };
  list.push(item);
  // 只留最近 200 条，免得无限长
  writeJson(FILES.recs, list.slice(-200));
  log(`recommend += ${item.title}${item.artist ? ` — ${item.artist}` : ''}`);
  return { status: 200, payload: { ok: true, item } };
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    // 所有 /v1/* 都要 token —— 这个 hub 可能直接暴露在公网，
    // 就算是只读接口，也不该让陌生人知道你此刻在听什么。
    // /health 例外，留给探针。
    if (url.pathname.startsWith('/v1/') && !authorized(req, url)) {
      return send(res, 401, { ok: false, error: 'unauthorized' });
    }

    switch (route) {
      case 'GET /health':
        return send(res, 200, { ok: true, service: 'music-hub', uptime: process.uptime() });

      case 'GET /v1/now-playing':
        return send(res, ...Object.values(handleGetNowPlaying()));

      case 'GET /v1/history': {
        const limit = Math.min(Number(url.searchParams.get('limit') || 20) || 20, 200);
        return send(res, 200, { ok: true, items: readHistory(limit) });
      }

      case 'GET /v1/recommendations':
        return send(res, 200, { ok: true, items: readJson(FILES.recs, []) });

      case 'POST /v1/now-playing': {
        const body = await readBody(req);
        const { status, payload } = handleNowPlaying(body);
        return send(res, status, payload);
      }

      case 'POST /v1/recommend': {
        const body = await readBody(req);
        const { status, payload } = handleRecommend(body);
        return send(res, status, payload);
      }

      default:
        return send(res, 404, { ok: false, error: `no route: ${route}` });
    }
  } catch (err) {
    log('request failed:', err.message);
    return send(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  log(`music-hub listening on http://${HOST}:${PORT}`);
  log(`data dir: ${DATA_DIR}`);
  log(TOKEN ? 'write endpoints: enabled' : 'WARNING: MUSIC_HUB_TOKEN empty — write endpoints disabled');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig} received, closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
