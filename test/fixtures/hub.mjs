// A controllable clock keeps the HTTP contract tests deterministic without sleeps.
let now = Number(process.env.TEST_NOW);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [now]));
  }
  static now() { return now; }
};

process.on('message', (message) => {
  now = message.now;
  process.send({ now });
});

if (process.argv[2] === 'standalone') {
  await import('../../packages/music-hub/src/hub.mjs');
} else {
  const { createHub } = await import('../../packages/watcher/lib/hub.mjs');
  const hub = createHub({
    host: '127.0.0.1',
    port: Number(process.env.MUSIC_HUB_PORT),
    token: process.env.MUSIC_HUB_TOKEN,
    dataDir: process.env.MUSIC_HUB_DATA,
    staleMs: 600_000,
    behavior: { onSongChange: 'silent' },
  });
  await hub.start();
  process.on('SIGTERM', async () => {
    await hub.stop();
    process.exit(0);
  });
}
