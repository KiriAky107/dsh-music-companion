import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { createHub } from '../packages/watcher/lib/hub.mjs';
import { unusedPort } from './helpers.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-ticker-test-'));
const configFile = path.join(dir, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({
  hub: { url: 'http://localhost:8787', token: 'configured-token' },
  watcher: { ignoreSources: ['browser'] },
}));
const savedEnv = { ...process.env };
process.env.MUSIC_CONFIG = configFile;
process.env.MUSIC_NETEASE_DIR = dir;
delete process.env.MUSIC_HUB_URL;
delete process.env.MUSIC_HUB_TOKEN;
delete process.env.MUSIC_POLL_SECONDS;

let sample;
let clock;
let requests;
let readSample;
const nativeFetch = globalThis.fetch;
const fakeExec = () => {};
fakeExec[promisify.custom] = async () => ({ stdout: JSON.stringify(await readSample()), stderr: '' });
const originalExec = childProcess.execFile;
childProcess.execFile = fakeExec;
syncBuiltinESMExports();
const { createTicker } = await import('../packages/watcher/lib/ticker.mjs');

after(() => {
  childProcess.execFile = originalExec;
  syncBuiltinESMExports();
  process.env = savedEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(t, { hubUrl = 'http://127.0.0.1:8787', realHttp = false } = {}) {
  clock = 0;
  sample = { found: true, title: 'A', artist: 'artist', app: 'cloudmusic.exe', status: 'Playing' };
  requests = [];
  readSample = async () => sample;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, token: options.headers.authorization, body: JSON.parse(options.body) });
    if (realHttp) return nativeFetch(url, options);
    return { ok: true, json: async () => ({ ok: true }) };
  });
  const ticker = createTicker({ hubUrl, token: 'local-dev' });
  t.after(() => ticker.stop());
  return {
    ticker,
    async tick(seconds, changes = {}) {
      clock = seconds * 1000;
      sample = { ...sample, ...changes };
      await ticker.tick();
      return requests.at(-1)?.body;
    },
  };
}

test('uses the embedded hub connection even when config and environment disagree', async (t) => {
  process.env.MUSIC_HUB_URL = 'http://[::1]:9999';
  process.env.MUSIC_HUB_TOKEN = 'environment-token';
  t.after(() => { delete process.env.MUSIC_HUB_URL; delete process.env.MUSIC_HUB_TOKEN; });
  const { tick } = setup(t);
  await tick(0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:8787/v1/now-playing');
  assert.equal(requests[0].token, 'Bearer local-dev');
});

test('CLI connections retain environment > config > defaults precedence', async (t) => {
  setup(t);
  const configured = createTicker();
  await configured.tick();
  assert.equal(requests[0].url, 'http://localhost:8787/v1/now-playing');
  assert.equal(requests[0].token, 'Bearer configured-token');
  process.env.MUSIC_HUB_URL = 'http://127.0.0.1:9999';
  process.env.MUSIC_HUB_TOKEN = 'environment-token';
  t.after(() => { delete process.env.MUSIC_HUB_URL; delete process.env.MUSIC_HUB_TOKEN; });
  await createTicker().tick();
  assert.equal(requests[1].url, 'http://127.0.0.1:9999/v1/now-playing');
  assert.equal(requests[1].token, 'Bearer environment-token');
});

test('a configured token can still report successfully to the real embedded hub', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(dir, 'embedded-'));
  const hub = createHub({
    port: await unusedPort(), token: 'local-dev', dataDir,
    behavior: { onSongChange: 'silent' },
  });
  await hub.start();
  t.after(() => hub.stop());
  const { tick } = setup(t, { hubUrl: hub.url, realHttp: true });
  await tick(0);
  const response = await nativeFetch(`${hub.url}/v1/now-playing`, {
    headers: { authorization: 'Bearer local-dev' },
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).track.title, 'A');
});

test('first samples and song changes start at zero', async (t) => {
  const { tick } = setup(t);
  assert.equal((await tick(3600)).progress, 0);
  assert.equal((await tick(3620)).progress, 20);
  const next = await tick(3640, { title: 'B' });
  assert.equal(next.progress, 0);
  assert.equal(next.listenedSeconds, 0);
});

test('counts the playing-to-paused interval and excludes paused-to-playing time', async (t) => {
  const { tick } = setup(t);
  await tick(0);
  assert.equal((await tick(20, { status: 'Paused' })).listenedSeconds, 20);
  assert.equal((await tick(600, { status: 'Paused' })).listenedSeconds, 20);
  assert.equal((await tick(620, { status: 'Playing' })).listenedSeconds, 20);
  assert.equal((await tick(640)).listenedSeconds, 40);
});

test('native seeks change progress without changing the listening counter', async (t) => {
  const { tick } = setup(t);
  const first = await tick(0, { position: 90 });
  assert.equal(first.progress, 90);
  assert.equal(first.listenedSeconds, 0);
  const forward = await tick(20, { position: 200 });
  assert.equal(forward.progress, 200);
  assert.equal(forward.listenedSeconds, 20);
  const back = await tick(40, { position: 5 });
  assert.equal(back.progress, 5);
  assert.equal(back.listenedSeconds, 40);
});

for (const interruption of ['no media', 'ignored source', 'read failure']) {
  test(`resets timing after ${interruption}`, async (t) => {
    const { tick } = setup(t);
    await tick(0);
    await tick(20);
    if (interruption === 'read failure') {
      readSample = async () => { throw new Error('SMTC unavailable'); };
      await tick(40);
      readSample = async () => sample;
    } else {
      await tick(40, interruption === 'no media' ? { found: false } : { app: 'chrome.exe' });
    }
    assert.equal(requests.length, 2);
    const resumed = await tick(3600, { found: true, app: 'cloudmusic.exe' });
    assert.equal(resumed.listenedSeconds, 0);
    assert.equal(resumed.progress, 0);
  });
}

test('does not count sleep or a backwards clock jump', async (t) => {
  const { tick } = setup(t);
  await tick(0);
  await tick(20);
  assert.equal((await tick(3600)).listenedSeconds, 20);
  assert.equal((await tick(3620)).listenedSeconds, 40);
  assert.equal((await tick(3600)).listenedSeconds, 40);
});

test('switching apps with identical metadata resets the fallback progress', async (t) => {
  const { tick } = setup(t);
  await tick(0);
  await tick(20);
  assert.equal((await tick(40, { app: 'Spotify.exe' })).listenedSeconds, 0);
});

test('skips overlapping polls and discards samples completed after stop', async (t) => {
  const { ticker } = setup(t);
  let finish;
  let reads = 0;
  readSample = () => { reads += 1; return new Promise((resolve) => { finish = resolve; }); };
  const first = ticker.tick();
  await ticker.tick();
  assert.equal(reads, 1);
  ticker.stop();
  finish(sample);
  await first;
  assert.equal(requests.length, 0);
});
