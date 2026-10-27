#!/usr/bin/env node
/**
 * 冒烟测试：起一个临时 hub，打几条请求，验证收/存/给都正常。
 *
 *   npm run test:smoke
 *
 * 不依赖网络，不留垃圾文件，失败直接 exit 1。
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { unusedPort } from '../test/helpers.mjs';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'music-smoke-'));
const CONFIG = path.join(DATA_DIR, 'config.json');
fs.writeFileSync(CONFIG, JSON.stringify({ behavior: { onSongChange: 'silent' } }));
const PORT = await unusedPort();
const TOKEN = 'smoke-test-token';
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHub(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error('hub 没能在 8 秒内起来');
}

async function post(payload, token = TOKEN) {
  const res = await fetch(`${BASE}/v1/now-playing`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

/** 所有 /v1/* 都要 token，包括只读接口 */
const getJson = async (p, token = TOKEN) => {
  const res = await fetch(`${BASE}${p}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json() };
};

function cleanup() {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* 无所谓 */
  }
}

/* ------------------------------------------------------------------ */

const hub = spawn(process.execPath, [path.join(ROOT, 'packages/music-hub/src/hub.mjs')], {
  env: { ...process.env, MUSIC_CONFIG: CONFIG, MUSIC_HUB_HOST: '127.0.0.1', MUSIC_HUB_PORT: String(PORT), MUSIC_HUB_TOKEN: TOKEN, MUSIC_HUB_DATA: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let hubLog = '';
hub.stdout.on('data', (d) => (hubLog += d));
hub.stderr.on('data', (d) => (hubLog += d));

let failed = false;
try {
  await waitForHub();
  console.log('✓ hub 起来了');

  // 1. 没数据时 GET 应该是 404
  {
    const r = await getJson('/v1/now-playing');
    assert.equal(r.status, 404, '空状态应返回 404');
    console.log('✓ 空状态返回 404');
  }

  // 2. 没 token 写应该被拒
  {
    const r = await post({ track: { title: 'x' } }, '');
    assert.equal(r.status, 401, '无 token 应 401');
    console.log('✓ 无 token 被拒');
  }
  // 2b. 只读接口同样要 token —— 公网暴露时不能让人白看你听什么
  {
    const r = await getJson('/v1/now-playing', '');
    assert.equal(r.status, 401, '无 token 读也应 401');
    console.log('✓ 无 token 读也被拒');
  }

  // 3. 正确写入
  {
    const r = await post({
      track: { title: '贵人', artists: ['回春丹'], album: '', id: null, duration: null },
      progress: null,
      playing: true,
      device: 'smoke',
      source: 'smtc/cloudmusic.exe',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.changed, true, '第一次应视为换歌');
    console.log('✓ 写入成功，changed=true');
  }

  // 4. 读回来
  {
    const { body: now } = await getJson('/v1/now-playing');
    assert.equal(now.track.title, '贵人');
    assert.deepEqual(now.track.artists, ['回春丹']);
    assert.equal(now.playing, true);
    assert.equal(now.stale, false);
    console.log('✓ 读回状态正确，未过期');
  }

  // 5. 历史里有且只有一条
  {
    const { items } = (await getJson('/v1/history?limit=10')).body;
    assert.equal(items.length, 1, '应该只有一条历史');
    assert.equal(items[0].track.title, '贵人');
    console.log('✓ 历史记录 1 条');
  }

  // 6. 同一首歌重复上报 → changed=false 且不追加历史
  {
    const r = await post({
      track: { title: '贵人', artists: ['回春丹'] },
      playing: true,
      device: 'smoke',
    });
    assert.equal(r.body.changed, false, '同一首歌应 changed=false');

    const { items } = (await getJson('/v1/history?limit=10')).body;
    assert.equal(items.length, 1, '重复上报不应追加历史');
    console.log('✓ 幂等生效，历史没变长');
  }

  // 7. 换歌 → changed=true 且历史追加
  {
    const r = await post({
      track: { title: '火车驶向云外，梦安魂于九霄', artists: ['刺猬'] },
      playing: true,
      device: 'smoke',
    });
    assert.equal(r.body.changed, true);

    const { items } = (await getJson('/v1/history?limit=10')).body;
    assert.equal(items.length, 2);
    assert.equal(items[0].track.title, '火车驶向云外，梦安魂于九霄', '最新的应该在前面');
    console.log('✓ 换歌追加历史，倒序正确');
  }

  // 8. 暂停不记历史
  {
    const r = await post({
      track: { title: '火车驶向云外，梦安魂于九霄', artists: ['刺猬'] },
      playing: false,
      device: 'smoke',
    });
    assert.equal(r.status, 200);
    const { items } = (await getJson('/v1/history?limit=10')).body;
    assert.equal(items.length, 2, '暂停不应追加历史');
    console.log('✓ 暂停不记历史');
  }

  // 9. 缺 title 应 400
  {
    const r = await post({ track: { artists: ['x'] } });
    assert.equal(r.status, 400);
    console.log('✓ 缺 title 返回 400');
  }

  console.log('\n全部通过');
} catch (err) {
  failed = true;
  console.error('\n失败：', err.message);
  if (hubLog) console.error('--- hub 日志 ---\n' + hubLog);
} finally {
  const stopped = hub.exitCode === null ? once(hub, 'exit') : Promise.resolve();
  hub.kill();
  await stopped;
  cleanup();
  if (failed) process.exit(1);
  process.exit(0);
}
