/**
 * config.mjs — 配置加载（插件包内副本）
 *
 * 和 packages/shared/config.mjs 同一套逻辑，只有一处不同：
 * 本文件在 packages/watcher/lib/ 下，`packages/watcher/lib/../../..` 才是仓库根。
 *
 * 优先级从高到低：环境变量 > config.json > 内置默认值。
 * 读不到、读坏了都不抛异常——配置是可选增强，缺了也得能跑起来。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = 'dsh-music-companion';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function candidatePaths() {
  const list = [];

  const explicit = (process.env.MUSIC_CONFIG || '').trim();
  if (explicit) list.push(path.resolve(explicit));

  // 包根目录（packages/watcher/lib/../../.. == 仓库根）
  list.push(path.join(HERE, '..', '..', '..', 'config.json'));

  // 在仓库根目录直接跑时，config.json 就在手边
  list.push(path.resolve(process.cwd(), 'config.json'));

  const home = os.homedir();
  if (process.env.XDG_CONFIG_HOME) {
    list.push(path.join(process.env.XDG_CONFIG_HOME, APP_DIR, 'config.json'));
  }
  if (home) {
    list.push(path.join(home, '.config', APP_DIR, 'config.json'));
  }
  if (process.env.APPDATA) {
    list.push(path.join(process.env.APPDATA, APP_DIR, 'config.json'));
  }

  return list;
}

export function findConfigPath() {
  return candidatePaths().find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

let cached = null;

/** 读配置。没有配置文件就是空对象，不是错误。 */
export function loadConfig() {
  if (cached) return cached;

  const file = findConfigPath();
  if (!file) {
    cached = {};
    return cached;
  }

  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    cached = { __file: file, ...parsed };
  } catch (err) {
    console.warn(`[config] ${file} 读不出来（${err.message}），按默认值继续`);
    cached = {};
  }
  return cached;
}

/** 取值优先级：环境变量 > 配置文件里的值 > 默认值。空字符串当作"没设"。 */
export function pick(envName, cfgValue, fallback) {
  const e = process.env[envName];
  if (e !== undefined && e !== null && String(e).trim() !== '') return e;

  if (cfgValue !== undefined && cfgValue !== null && cfgValue !== '') return cfgValue;

  return fallback;
}

/** 把值转成数字，转不动就退回默认值 */
export function pickNumber(envName, cfgValue, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = pick(envName, cfgValue, fallback);
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 启动时打一行，方便确认到底读的是哪份配置 */
export function describeConfig() {
  const file = findConfigPath();
  return file ? `配置文件：${file}` : '配置文件：未找到，用默认值 + 环境变量';
}
