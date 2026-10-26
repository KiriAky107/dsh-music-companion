#!/usr/bin/env node
/**
 * mcp-music — 给 DSH agent 用的音乐工具（stdio MCP server）
 *
 * v0.1 只暴露两个只读工具：
 *   music_now_playing  现在在听什么
 *   music_history      最近听过什么
 *
 * 环境变量：
 *   MUSIC_HUB_URL   music-hub 地址，默认 http://127.0.0.1:8787
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const HUB = (process.env.MUSIC_HUB_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TOKEN = (process.env.MUSIC_HUB_TOKEN || '').trim();

/* ------------------------------------------------------------------ */
/* hub 客户端                                                          */
/* ------------------------------------------------------------------ */

async function hubGet(pathAndQuery) {
  const res = await fetch(`${HUB}${pathAndQuery}`, {
    headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`music-hub returned ${res.status}`);
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/* 格式化                                                              */
/* ------------------------------------------------------------------ */

const artistsOf = (track) =>
  track?.artists?.length ? track.artists.join('/') : '未知歌手';

function describeNow(now) {
  if (!now || !now.track) return '还没收到任何播放数据。可能是桌面端的 watcher 没在跑。';

  const bits = [
    `《${now.track.title}》`,
    artistsOf(now.track),
    now.playing ? '正在播放' : '已暂停',
  ];

  let line = bits.join(' — ');

  if (now.stale) {
    line += `（已经 ${now.ageSeconds} 秒没更新了，可能关掉了播放器）`;
  } else if (now.track.duration && typeof now.progress === 'number') {
    const pct = Math.round((now.progress / now.track.duration) * 100);
    line += `（进度约 ${pct}%）`;
  }

  if (now.track.album) line += `，专辑《${now.track.album}》`;
  return line;
}

function describeHistory(items) {
  if (!items?.length) return '还没有听歌记录。';
  return items
    .map((it, i) => {
      const t = it.track || {};
      const at = new Date(it.at).toLocaleString('zh-CN', {
        hour12: false,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      return `${i + 1}. ${at} 《${t.title}》— ${artistsOf(t)}`;
    })
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* MCP server                                                          */
/* ------------------------------------------------------------------ */

const server = new Server(
  { name: 'mcp-music', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const text = (s) => ({ content: [{ type: 'text', text: s }] });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'music_now_playing',
      description:
        '查看主人此刻正在听什么歌。当主人提到音乐、问你在听什么、或你想主动接话聊音乐时用。返回歌名、歌手、播放状态；如果很久没更新会标注可能已关闭。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'music_history',
      description:
        '查看主人在桌面上最近听过哪些歌（按时间倒序）。用来了解他的听歌口味、判断某首歌他是不是反复在听。',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: '返回多少条，默认 20，最多 100',
            minimum: 1,
            maximum: 100,
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    if (name === 'music_now_playing') {
      const now = await hubGet('/v1/now-playing');
      return text(describeNow(now));
    }

    if (name === 'music_history') {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const { items } = await hubGet(`/v1/history?limit=${limit}`);
      return text(describeHistory(items));
    }

    return { ...text(`未知工具：${name}`), isError: true };
  } catch (err) {
    // 工具失败要返回 isError，让 agent 知道"读不到"，而不是编一个答案
    return {
      content: [{ type: 'text', text: `读不到音乐数据：${err.message}` }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
