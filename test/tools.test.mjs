import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMusicTools } from '../packages/watcher/lib/tools.mjs';

test('now playing distinguishes listening duration from playback position', async (t) => {
  let state = {
    track: { title: 'A', artists: ['artist'], duration: 300 },
    progress: 240, listenedSeconds: 40, playing: true,
  };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => state }));
  const tool = createMusicTools({ hubUrl: 'http://127.0.0.1:8787', token: 'test-token' })
    .find((tool) => tool.name === 'music_now_playing');
  const description = await tool.execute();
  assert.match(description, /已听约 40 秒/);
  assert.match(description, /进度约 80%/);

  // A legacy hub with no listening counter must not invent one from progress.
  state = { ...state, listenedSeconds: undefined };
  assert.doesNotMatch(await tool.execute(), /已听约/);
});
