#!/usr/bin/env node
/**
 * MCP 冒烟测试：起一个临时 hub，用官方 SDK 的 client 连上 mcp-music，
 * 列工具、调工具，确认 agent 侧真的能拿到数据。
 *
 *   npm run test:mcp
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..', '..'); // packages/mcp-music/scripts → repo root
const DATA_DIR = path.join(ROOT, '.smoke-mcp-data');
const PORT = 18790;
const TOKEN = 'mcp-smoke-token';
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`${url} 没起来`);
}

fs.rmSync(DATA_DIR, { recursive: true, force: true });

const hub = spawn(process.execPath, [path.join(ROOT, 'packages/music-hub/src/hub.mjs')], {
  env: { ...process.env, MUSIC_HUB_PORT: String(PORT), MUSIC_HUB_TOKEN: TOKEN, MUSIC_HUB_DATA: DATA_DIR },
  stdio: 'ignore',
});

let failed = false;
try {
  await waitFor(`${BASE}/health`);

  // 造一条数据
  await fetch(`${BASE}/v1/now-playing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      track: { title: '贵人', artists: ['回春丹'], album: '鲜花', id: null, duration: null },
      playing: true,
      device: 'smoke',
    }),
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'packages/mcp-music/src/server.mjs')],
    env: { ...process.env, MUSIC_HUB_URL: BASE, MUSIC_HUB_TOKEN: TOKEN },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'mcp-music-smoke', version: '0.1.0' });
  await client.connect(transport);
  console.log('✓ client 连上 server');

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['music_history', 'music_now_playing', 'music_recommend']);
  console.log(`✓ 工具列表正确：${names.join(', ')}`);

  const now = await client.callTool({ name: 'music_now_playing', arguments: {} });
  const nowText = now.content?.[0]?.text ?? '';
  assert.ok(nowText.includes('贵人'), 'now_playing 应包含歌名');
  assert.ok(nowText.includes('回春丹'), 'now_playing 应包含歌手');
  assert.ok(nowText.includes('正在播放'), 'now_playing 应说明状态');
  console.log(`✓ music_now_playing → ${nowText}`);

  const hist = await client.callTool({ name: 'music_history', arguments: { limit: 5 } });
  const histText = hist.content?.[0]?.text ?? '';
  assert.ok(histText.includes('贵人'), 'history 应包含歌名');
  console.log(`✓ music_history → ${histText.split('\n')[0]}`);

  const bad = await client.callTool({ name: 'music_history', arguments: { limit: 999 } });
  assert.equal(bad.isError, undefined, 'limit 超范围应被夹紧而不是报错');
  console.log('✓ limit 被夹紧，没有炸');

  const rec = await client.callTool({
    name: 'music_recommend',
    arguments: { title: '花海', artist: '回春丹', reason: '跟你刚听的是同一支乐队' },
  });
  const recText = rec.content?.[0]?.text ?? '';
  assert.equal(rec.isError, undefined, 'recommend 不应报错');
  assert.ok(recText.includes('花海'), 'recommend 应回显歌名');
  const recs = await fetch(`${BASE}/v1/recommendations`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  }).then((r) => r.json());
  assert.equal(recs.items.length, 1, 'hub 上应有一条推荐');
  assert.equal(recs.items[0].reason, '跟你刚听的是同一支乐队');
  console.log(`✓ music_recommend → ${recText}`);

  await client.close();
  console.log('\n全部通过');
} catch (err) {
  failed = true;
  console.error('\n失败：', err.message);
} finally {
  hub.kill();
  await sleep(300);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
