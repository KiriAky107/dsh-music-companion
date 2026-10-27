/**
 * ticker — watcher 的核心循环，抽出来给两种入口共用：
 *
 *   - `watcher.mjs`  CLI 入口，手动跑 / 调试用（`node watcher.mjs`）
 *   - `index.js`     DSH host 插件入口，桌面端启动时自动加载
 *
 * 两种入口的区别只有「谁来驱动 tick」：CLI 用 setInterval，插件用 ctx.effect。
 * 读 SMTC、匹配 song id、上报 hub 这些逻辑一模一样，所以放在这里。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { lookupNetease, neteaseStatus } from './netease.mjs';
import { loadConfig, pick, pickNumber, describeConfig } from '../../shared/config.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));

// smtc.ps1 和本文件同目录（既在 packages/watcher/lib/ 下，也在插件包里）
const PS1 = path.join(HERE, 'smtc.ps1');

/**
 * @param {object} [overrides] 插件 config 里的字段，优先级低于环境变量和 config.json
 * @returns {{ start: (log?: Function) => void, stop: () => void, tick: (log?: Function) => Promise<void>, intervalMs: number, describe: () => string }}
 */
export function createTicker(overrides = {}) {
  const CFG = loadConfig();

  const HUB_URL = String(
    pick('MUSIC_HUB_URL', CFG.hub?.url ?? overrides.hubUrl, 'http://127.0.0.1:8787'),
  ).replace(/\/+$/, '');
  const TOKEN = String(pick('MUSIC_HUB_TOKEN', CFG.hub?.token ?? overrides.token, '')).trim();
  const POLL_SECONDS = pickNumber(
    'MUSIC_POLL_SECONDS',
    CFG.watcher?.pollSeconds ?? overrides.pollSeconds,
    20,
    { min: 5 },
  );
  const DEVICE = String(pick('MUSIC_DEVICE', CFG.watcher?.device ?? overrides.device, 'desktop-windows'));

  // 不想被当成"在听歌"的来源（比如 B 站的长视频）。默认不过滤。
  const IGNORE_SOURCES = new Set(
    (Array.isArray(CFG.watcher?.ignoreSources) ? CFG.watcher.ignoreSources : []).map((s) =>
      String(s).toLowerCase(),
    ),
  );

  let timer = null;

  // 播放状态：换歌清零，暂停不累加
  let currentSong = null;
  let elapsedSeconds = 0;
  let lastTickAt = Date.now();
  let lastLoggedKey = null;
  let consecutiveErrors = 0;

  /* ---------------------------------------------------------------- */
  /* 读 SMTC                                                           */
  /* ---------------------------------------------------------------- */

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

  /* ---------------------------------------------------------------- */
  /* 推给 hub                                                          */
  /* ---------------------------------------------------------------- */

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

  /* ---------------------------------------------------------------- */
  /* 一轮                                                              */
  /* ---------------------------------------------------------------- */

  async function tick(log = () => {}) {
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
      ? String(info.artist)
          .split('/')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    // 配置里点名不要的来源（比如 bilibili），直接不上报 ——
    // 看网课不该被算成"在听歌"，也不该进她的听歌记录。
    const source = classifySource(info.app);
    const appId = String(info.app || '').toLowerCase();
    if (IGNORE_SOURCES.has(source) || IGNORE_SOURCES.has(appId)) {
      return;
    }

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
      source,
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

  /* ---------------------------------------------------------------- */
  /* 生命周期                                                          */
  /* ---------------------------------------------------------------- */

  function describe() {
    return `watcher：每 ${POLL_SECONDS}s → ${HUB_URL}${IGNORE_SOURCES.size ? `，忽略 ${[...IGNORE_SOURCES].join('/')}` : ''}`;
  }

  function start(log = () => {}) {
    if (timer) return;
    log(describe());
    log(describeConfig());
    const nst = neteaseStatus();
    log(`本地队列：${nst.enabled ? `${nst.tracks} 首可查 id` : '没读到，song id 会是 null'}`);

    // 立刻跑一轮，别等第一个间隔
    void tick(log);

    timer = setInterval(() => void tick(log), POLL_SECONDS * 1000);
    // 别让这个定时器把进程钉住（DSH 退出时应该能走）
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    tick: (log) => tick(log),
    intervalMs: POLL_SECONDS * 1000,
    describe,
  };
}
