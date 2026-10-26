/**
 * notify — 「要不要叫醒她」的判断与投递
 *
 * 单独拆出来，是因为这段逻辑以后会长大（更多过滤条件、更多投递方式），
 * 而 hub 只该负责收、存、给。
 *
 * 设计原则：**hub 只负责"提醒"，不负责"说什么"**。
 * 我们发过去的只有一句中性的事实（换歌了），说不说、说什么由 agent 自己判断。
 * 这样即使策略写错了，最坏结果也只是"她被多叫醒几次"，而不是"她乱说话"。
 *
 * 配置（config.json 的 behavior 段）：
 *   onSongChange   "ask"（默认，叫醒她让她自己决定）| "silent"（从不主动）
 *   ignoreSource   来源黑名单，比如 ["bilibili"] —— 看视频不该触发
 *   minGapSeconds  两次提醒的最小间隔，默认 180，防连切歌刷屏
 *   quietHours     免打扰时段 ["23:30","07:00"]，支持跨零点
 *   notify         投递目标，见下面 parseTarget
 */

const DEFAULTS = {
  onSongChange: 'ask',
  ignoreSource: [],
  minGapSeconds: 180,
  quietHours: ['23:30', '07:00'],
};

/** "23:30" → 1410（当天第几分钟） */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 当前是否处于免打扰时段。
 * 支持跨零点：["23:30","07:00"] 表示 23:30 → 次日 07:00。
 * 时间段解析失败的项直接忽略，不让配置错误把主动发言整体关死。
 */
export function inQuietHours(hours, nowMs = Date.now()) {
  if (!Array.isArray(hours) || hours.length < 2) return false;
  const start = toMinutes(hours[0]);
  const end = toMinutes(hours[1]);
  if (start == null || end == null || start === end) return false;

  const d = new Date(nowMs);
  const cur = d.getHours() * 60 + d.getMinutes();
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** 模板里的 {title} 之类，缺值就替换成空串，绝不留 undefined */
export function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] == null ? '' : String(vars[k]),
  );
}

/**
 * 解析投递目标。
 * 目前只支持 qq-bridge：它有一个 POST /api/console/notify-ai 接口，
 * 能把一句提醒悄悄塞进指定会话，且**不会**把 agent 的回复自动发到 QQ
 * （silent 回合），所以"她如果想说话必须自己调 qq_send_message"——
 * 天然就是"不想说就闭嘴"的语义。
 */
function parseTarget(notify) {
  if (!notify || typeof notify !== 'object') return null;
  const kind = String(notify.kind || 'none');

  if (kind === 'none' || kind === '') return null;

  if (kind === 'qq-bridge') {
    const base = String(notify.url || '').replace(/\/+$/, '');
    const token = String(notify.consoleToken || '');
    const key = String(notify.key || '');
    if (!base || !token || !key) {
      return { error: 'qq-bridge 需要 url / consoleToken / key 三个都填' };
    }
    return {
      kind,
      url: `${base}/api/console/notify-ai`,
      token,
      key,
      message:
        notify.message ||
        '【音乐】主人刚换成了《{title}》— {artists}。想聊就说两句，不想说就安静待着。',
    };
  }

  // 通用 webhook：以后接飞书/钉钉/自建服务用，这里先留一个正经实现
  if (kind === 'webhook') {
    const url = String(notify.url || '');
    if (!url) return { error: 'webhook 需要 url' };
    return {
      kind,
      url,
      token: String(notify.token || ''),
      headers: notify.headers && typeof notify.headers === 'object' ? notify.headers : {},
      message: notify.message || '《{title}》— {artists}',
    };
  }

  return { error: `未知的 notify.kind: ${kind}` };
}

export function createNotifier(behavior, log = () => {}) {
  const cfg = { ...DEFAULTS, ...(behavior || {}) };
  const target = parseTarget(cfg.notify);

  let lastSentAt = 0;
  let lastReason = '还没触发过';

  const ignored = new Set(
    (Array.isArray(cfg.ignoreSource) ? cfg.ignoreSource : []).map((s) =>
      String(s).toLowerCase(),
    ),
  );

  function describe() {
    if (!target) return '主动发言：未配置（只记录，不打扰）';
    if (target.error) return `主动发言：配置有误 —— ${target.error}`;
    const bits = [`主动发言：开（${target.kind}）`];
    if (ignored.size) bits.push(`忽略来源 ${[...ignored].join(',')}`);
    if (cfg.minGapSeconds > 0) bits.push(`最小间隔 ${cfg.minGapSeconds}s`);
    if (inQuietHours(cfg.quietHours)) bits.push('当前处于免打扰');
    return bits.join(' · ');
  }

  /** 判断是否该叫醒。返回 { notify: boolean, reason } */
  function shouldNotify(state, changed, nowMs = Date.now()) {
    if (!target) return { notify: false, reason: '未配置投递目标' };
    if (target.error) return { notify: false, reason: target.error };
    if (cfg.onSongChange === 'silent') return { notify: false, reason: '策略=silent' };
    if (!changed) return { notify: false, reason: '同一首歌' };
    if (!state?.playing) return { notify: false, reason: '不在播放' };

    const source = String(state.source || '').toLowerCase();
    if (source && ignored.has(source)) return { notify: false, reason: `忽略来源 ${source}` };

    if (inQuietHours(cfg.quietHours, nowMs)) return { notify: false, reason: '免打扰时段' };

    const gapMs = Math.max(0, Number(cfg.minGapSeconds) || 0) * 1000;
    const since = nowMs - lastSentAt;
    if (lastSentAt && since < gapMs) {
      return { notify: false, reason: `距上次 ${Math.round(since / 1000)}s < ${cfg.minGapSeconds}s` };
    }

    return { notify: true, reason: '换歌且在播放' };
  }

  /** 真正投递。永不抛异常 —— 叫不醒她不该影响 hub 记录。 */
  async function send(state, nowMs = Date.now()) {
    const track = state?.track || {};
    const message = renderTemplate(target.message, {
      title: track.title,
      artists: (track.artists || []).join(' / '),
      album: track.album,
      source: state?.source,
      id: track.id,
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
      const headers = { 'content-type': 'application/json', ...(target.headers || {}) };
      if (target.token) {
        // qq-bridge 认 x-console-token；通用 webhook 用 Bearer 更常见，两个都带上不冲突
        headers['x-console-token'] = target.token;
        headers.authorization = `Bearer ${target.token}`;
      }
      const res = await fetch(target.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          target.kind === 'qq-bridge' ? { key: target.key, message } : { message, track },
        ),
        signal: ac.signal,
      });
      const text = (await res.text()).slice(0, 300);
      if (!res.ok) {
        lastReason = `投递失败 ${res.status}: ${text}`;
        log(`notify 失败 ${res.status}: ${text}`);
        return false;
      }
      lastSentAt = nowMs;
      lastReason = `已投递：${message.slice(0, 60)}`;
      log(`notify → ${target.kind} ok: ${message.slice(0, 80)}`);
      return true;
    } catch (error) {
      const msg = error?.name === 'AbortError' ? '超时 5s' : error?.message || String(error);
      lastReason = `投递异常：${msg}`;
      log(`notify 异常：${msg}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    describe,
    shouldNotify,
    lastReason: () => lastReason,
    /**
     * 对外唯一入口。**故意不 await**（调用方 fire-and-forget）：
     * 网络慢不能拖住 watcher 的上报。
     */
    maybeNotify(state, changed, nowMs = Date.now()) {
      const verdict = shouldNotify(state, changed, nowMs);
      if (!verdict.notify) {
        lastReason = verdict.reason;
        return false;
      }
      void send(state, nowMs);
      return true;
    },
  };
}
