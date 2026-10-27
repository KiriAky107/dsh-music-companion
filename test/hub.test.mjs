import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { unusedPort } from './helpers.mjs';

const EPOCH = Date.parse('2026-10-28T00:00:00Z');
const TOKEN = 'test-token';

async function fixture(t, kind) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-hub-test-'));
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ behavior: { onSongChange: 'silent' } }));
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  let child;
  let now = EPOCH;
  let log = '';

  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }

  async function start() {
    log = '';
    child = fork(new URL('./fixtures/hub.mjs', import.meta.url), [kind], {
      env: {
        ...process.env,
        MUSIC_CONFIG: config,
        MUSIC_HUB_PORT: String(port),
        MUSIC_HUB_HOST: '127.0.0.1',
        MUSIC_HUB_DATA: dir,
        MUSIC_HUB_TOKEN: TOKEN,
        MUSIC_HUB_STALE_SECONDS: '600',
        TEST_NOW: String(now),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.on('data', (chunk) => { log += chunk; });
    child.stderr.on('data', (chunk) => { log += chunk; });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(300) });
        if (response.ok) return;
      } catch { /* Wait for listen(). */ }
      await sleep(25);
    }
    throw new Error(`hub failed to start: ${log}`);
  }

  t.after(async () => {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await start();

  async function get(route) {
    const response = await fetch(`${url}${route}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  return {
    dir,
    get,
    async post(seconds, title, playing = true, extra = {}) {
      now = EPOCH + seconds * 1000;
      const acknowledged = once(child, 'message');
      child.send({ now });
      await acknowledged;
      const response = await fetch(`${url}/v1/now-playing`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          track: { title, artists: ['artist'] },
          device: 'desktop', source: 'netease', playing, ...extra,
        }),
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(response.status, 200);
      return response.json();
    },
    async restart() { await stop(); await start(); },
  };
}

for (const kind of ['embedded', 'standalone']) {
  test(`${kind} hub listening accounting`, async (t) => {
    await t.test('excludes pauses and keeps history deduplicated', async (t) => {
      const hub = await fixture(t, kind);
      await hub.post(0, 'A', true, { listenedSeconds: 0 });
      await hub.post(20, 'A', true, { listenedSeconds: 20 });
      await hub.post(40, 'A', false, { listenedSeconds: 40 });
      await hub.post(600, 'A', false, { listenedSeconds: 40 });
      await hub.post(620, 'A', true, { listenedSeconds: 40 });
      await hub.post(640, 'A', true, { listenedSeconds: 60 });
      assert.equal((await hub.get('/v1/now-playing')).listenedSeconds, 60);
      await hub.post(660, 'B', true, { listenedSeconds: 0 });
      const { items } = await hub.get('/v1/history');
      assert.equal(items.length, 2);
      assert.equal(items[0].track.title, 'B');
      assert.equal(items[0].listenedSeconds, 60);
      assert.equal(items[1].listenedSeconds, null);
    });

    await t.test('seeks do not count as listening', async (t) => {
      const hub = await fixture(t, kind);
      await hub.post(0, 'A', true, { progress: 0, listenedSeconds: 0 });
      await hub.post(20, 'A', true, { progress: 200, listenedSeconds: 20 });
      await hub.post(40, 'A', true, { progress: 5, listenedSeconds: 40 });
      await hub.post(60, 'B');
      assert.equal((await hub.get('/v1/history')).items[0].listenedSeconds, 40);
    });

    await t.test('watcher counters recover listening across missed resume reports', async (t) => {
      const hub = await fixture(t, kind);
      await hub.post(0, 'A', true, { listenedSeconds: 0 });
      await hub.post(20, 'A', false, { listenedSeconds: 20 });
      // Playback resumed while intermediate HTTP reports failed.
      await hub.post(140, 'A', true, { listenedSeconds: 60 });
      await hub.post(160, 'B');
      assert.equal((await hub.get('/v1/history')).items[0].listenedSeconds, 60);
    });

    await t.test('counter resets and stale gaps add no idle time', async (t) => {
      const hub = await fixture(t, kind);
      await hub.post(0, 'A', true, { listenedSeconds: 0 });
      await hub.post(20, 'A', true, { listenedSeconds: 20 });
      await hub.post(320, 'A', true, { listenedSeconds: 0 });
      await hub.post(340, 'A', true, { listenedSeconds: 20 });
      await hub.post(2000, 'A', true, { listenedSeconds: 1680 });
      await hub.post(2020, 'A', true, { listenedSeconds: 1700 });
      await hub.post(2040, 'B');
      assert.equal((await hub.get('/v1/history')).items[0].listenedSeconds, 60);
    });

    await t.test('old watchers still exclude pause and stale intervals', async (t) => {
      const hub = await fixture(t, kind);
      await hub.post(0, 'A');
      await hub.post(20, 'A', false);
      await hub.post(120, 'A', false);
      await hub.post(140, 'A');
      await hub.post(160, 'A');
      await hub.post(2000, 'A');
      await hub.post(2020, 'B');
      assert.equal((await hub.get('/v1/history')).items[0].listenedSeconds, 40);
    });

    await t.test('paused song selection survives restart without losing previous duration', async (t) => {
      const hub = await fixture(t, kind);
      await hub.post(0, 'A');
      await hub.post(20, 'A');
      await hub.post(40, 'B', false);
      const { startedAt } = await hub.get('/v1/now-playing');
      await hub.post(60, 'B', false);
      await hub.restart();
      await hub.post(80, 'B', false);
      assert.equal((await hub.get('/v1/now-playing')).startedAt, startedAt);
      await hub.post(100, 'B');
      const { items } = await hub.get('/v1/history');
      assert.equal(items.length, 2);
      assert.equal(items[0].track.title, 'B');
      assert.equal(items[0].listenedSeconds, 20);
    });

    await t.test('returning to the last played song preserves its counter', async (t) => {
      const hub = await fixture(t, kind);
      await hub.post(0, 'A');
      await hub.post(20, 'A');
      await hub.post(40, 'B', false);
      await hub.post(60, 'C', false);
      await hub.post(80, 'A');
      await hub.post(100, 'A');
      await hub.post(120, 'D');
      const { items } = await hub.get('/v1/history');
      assert.deepEqual(items.map((item) => item.track.title), ['D', 'A']);
      assert.equal(items[0].listenedSeconds, 40);
    });

    await t.test('listening counters survive hub restarts', async (t) => {
      const hub = await fixture(t, kind);
      await hub.post(0, 'A', true, { listenedSeconds: 0 });
      await hub.post(20, 'A', true, { listenedSeconds: 20 });
      await hub.restart();
      await hub.post(40, 'A', true, { listenedSeconds: 40 });
      await hub.post(60, 'B');
      const { items } = await hub.get('/v1/history');
      assert.equal(items.length, 2);
      assert.equal(items[0].listenedSeconds, 40);
    });

    await t.test('does not bridge device or source changes', async (t) => {
      const hub = await fixture(t, kind);
      await hub.post(0, 'A', true, { listenedSeconds: 0 });
      await hub.post(20, 'A', true, { listenedSeconds: 20, device: 'laptop' });
      await hub.post(40, 'A', true, { listenedSeconds: 40, device: 'laptop' });
      await hub.post(60, 'A', true, { listenedSeconds: 60, device: 'laptop', source: 'spotify' });
      await hub.post(80, 'B');
      assert.equal((await hub.get('/v1/history')).items[0].listenedSeconds, 20);
    });

    await t.test('legacy saved state does not become hours of listening on upgrade', async (t) => {
      const hub = await fixture(t, kind);
      fs.writeFileSync(path.join(hub.dir, 'now-playing.json'), JSON.stringify({
        track: { title: 'A', artists: ['artist'] }, device: 'desktop', source: 'netease',
        playing: true, startedAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T23:59:40Z',
      }));
      await hub.restart();
      await hub.post(0, 'A', true, { listenedSeconds: 0 });
      await hub.post(20, 'A', true, { listenedSeconds: 20 });
      await hub.post(40, 'B');
      assert.equal((await hub.get('/v1/history')).items[0].listenedSeconds, 20);
    });
  });
}
