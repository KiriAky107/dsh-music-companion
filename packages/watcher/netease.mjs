#!/usr/bin/env node
/**
 * netease.mjs — 从网易云客户端本地缓存里取出歌曲 ID
 *
 * 为什么读本地文件而不是调 API：
 *   Windows 的 SMTC 只给「歌名 + 歌手」，而 agent 要调歌词/评论接口需要数字 id。
 *   按名字去 /api/search/get 反查，同名歌一撞就废。
 *   网易云客户端自己有一份播放队列，精确、离线、零风控。
 *
 * 文件：%LOCALAPPDATA%\Netease\CloudMusic\webdata\file\playingList
 * 结构：{"list":[{"track":{"id":"2757490399","duration":217756,
 *          "name":"陪葬夏天的健忘录","artists":[{"name":"指错"},{"name":"星尘"}]}}]}
 *
 * 注意：SMTC 报的歌手常常只是主歌手（"指错"），而本地队列里是全部歌手
 *      （"指错/星尘"）。所以不能死磕精确匹配，要对歌手做一次宽松比对。
 *
 * 客户端退出后文件仍在（是上一次的队列），所以匹配失败属正常情况，返回 null 即可。
 */

import fs from 'node:fs';
import path from 'node:path';

const NETEASE_ROOT =
  process.env.MUSIC_NETEASE_DIR ||
  path.join(process.env.LOCALAPPDATA || '', 'Netease', 'CloudMusic');

const PLAYING_LIST = path.join(NETEASE_ROOT, 'webdata', 'file', 'playingList');

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();

const namesOf = (artists) =>
  (Array.isArray(artists) ? artists : [])
    .map((a) => norm(a?.name ?? a))
    .filter(Boolean);

const toResult = (t) => ({
  id: String(t.id),
  durationSeconds: typeof t.duration === 'number' && t.duration > 0 ? Math.round(t.duration / 1000) : null,
  album: t.album?.name || '',
  artists: (t.artists || []).map((a) => a?.name).filter(Boolean),
});

let cache = { mtimeMs: -1, byTitle: new Map(), count: 0 };

function loadIndex() {
  let st;
  try {
    st = fs.statSync(PLAYING_LIST);
  } catch {
    return cache;
  }
  if (st.mtimeMs === cache.mtimeMs) return cache;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(PLAYING_LIST, 'utf8'));
  } catch {
    // 客户端可能正在写这个文件，这一轮跳过，下一轮再试
    return cache;
  }

  // 兼容两种结构：{list:[{track}]}（队列）和 {track:{}}（单曲）
  const items = Array.isArray(data?.list)
    ? data.list
    : data?.track
      ? [{ track: data.track }]
      : [];

  const byTitle = new Map();
  for (const item of items) {
    const t = item?.track ?? item;
    if (!t?.name || !t?.id) continue;
    const key = norm(t.name);
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(t);
  }

  cache = { mtimeMs: st.mtimeMs, byTitle, count: items.length };
  return cache;
}

/**
 * 按「歌名 + 歌手」在网易云本地播放队列里查歌曲元数据。
 * 匹配顺序：歌名全等 + 歌手集合全等 → 歌名全等 + 歌手互相包含 → 歌名唯一命中。
 *
 * @param {string} title
 * @param {string[]} artists
 * @returns {{id: string, durationSeconds: number|null, album: string, artists: string[]}|null}
 */
export function lookupNetease(title, artists = []) {
  const { byTitle } = loadIndex();
  const candidates = byTitle.get(norm(title));
  if (!candidates?.length) return null;

  const wanted = namesOf(artists);

  // 1) 歌手集合完全相同
  const exact = candidates.find(
    (t) => namesOf(t.artists).join('/') === wanted.join('/'),
  );
  if (exact) return toResult(exact);

  // 2) 任一歌手互相包含 —— SMTC 只报主歌手时靠这条兜住
  if (wanted.length) {
    const loose = candidates.find((t) =>
      wanted.some((w) =>
        namesOf(t.artists).some((l) => l === w || l.includes(w) || w.includes(l)),
      ),
    );
    if (loose) return toResult(loose);
  }

  // 3) 歌名在队列里唯一，就直接用
  if (candidates.length === 1) return toResult(candidates[0]);

  return null;
}

/** 给自己看一眼：本地队列有没有读到、读到了多少首 */
export function neteaseStatus() {
  const { byTitle, count } = loadIndex();
  return {
    enabled: byTitle.size > 0,
    tracks: byTitle.size,
    queueItems: count,
    file: PLAYING_LIST,
  };
}
