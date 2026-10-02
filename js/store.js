// Persistence. Everything lives under one key so a reset is one line, and a run in progress is
// stored as (origin seed, tier, the marks placed so far, what the run has cost) rather than a
// copy of the clue set or the solution — the generator is deterministic, so neither the trees nor
// the numbers have to travel through storage. The whole record for a settled 9×9 measures 304 B of
// JSON, 193 B of that being the ink; the rest is seven numbers and two short strings.

const KEY = 'tents.save.v1';

const defaults = () => ({
  settings: { sound: true, reduceMotion: false },
  best: {},
  resume: null,
  totals: { solved: 0, hints: 0, ms: 0 },
});

// Cell states are 0 undecided / 1 tent / 2 grass, written as [value, length] pairs. What that buys
// is the state a 继续 is actually taken from: an early board is nearly one long run of 0s, so the
// ink field is 6 B when the board is empty and 10-30 B once a couple of tents are down, against
// 51-163 B for one number per cell (measured on the `bytes|1` shipped boards; tools/scenarios.js
// `save` re-derives both directions byte by byte). What it costs: nothing once the board is
// settled — a finished board alternates tents and grass, every run then pays two numbers, and the
// pairs come out LONGER (5×5 69 B vs 51 B, 9×9 193 B vs 163 B). It is not compression, it is a bet
// on when saves happen, and the losing side is tens of bytes on a key that is a few hundred anyway.
// Trunks keep 0 and are redrawn from the seed, so they cost a run rather than a field. No offset is
// needed: nothing here is negative.
function rleEncode(board) {
  const out = [];
  let run = board[0] ?? 0;
  let n = 1;
  for (let i = 1; i < board.length; i++) {
    if (board[i] === run && n < 255) n++;
    else {
      out.push(run, n);
      run = board[i];
      n = 1;
    }
  }
  out.push(run, n);
  return out;
}

function rleDecode(pairs, len) {
  const b = new Uint8Array(len);
  let i = 0;
  for (let p = 0; p + 1 < pairs.length && i < len; p += 2) {
    const v = pairs[p];
    const n = pairs[p + 1];
    for (let k = 0; k < n && i < len; k++) b[i++] = v;
  }
  return b;
}

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

// 两段式解码。第一段只回答"这团东西像不像一份存档记录"，第二段才把合格的那几条盖到默认值上。
// 一条坏记录只丢它自己：`best` 按档丢、`resume` 整条丢、`settings`/`totals` 按键丢，其余照留。
// 为什么不能一把 `Object.assign(defaults(), JSON.parse(raw))` 了事：存档里 `resume.ink` 是
// `[2, 3, 1, ...]` 这种成对形状，一个 `null`、一个字符串、一个越界的格值都会顺着展开运算爬进
// `Uint8Array` 的构造和 `for` 循环，要么抛异常把整局冻死，要么把 300 格悄悄写成同一支笔。
// `dropped` 留在内存里，是为了让 tools/verify.sh 之外的 harness 能数出"到底丢了几条"。
function sanitize(parsed) {
  const dropped = [];
  const data = defaults();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    dropped.push('root');
    return { data, dropped };
  }

  if (parsed.settings && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings)) {
    for (const k of Object.keys(data.settings)) {
      if (typeof parsed.settings[k] === 'boolean') data.settings[k] = parsed.settings[k];
      else if (parsed.settings[k] !== undefined) dropped.push('settings.' + k);
    }
  } else if (parsed.settings !== undefined) {
    dropped.push('settings');
  }

  if (parsed.totals && typeof parsed.totals === 'object' && !Array.isArray(parsed.totals)) {
    for (const k of Object.keys(data.totals)) {
      if (isNum(parsed.totals[k], 0, Number.MAX_SAFE_INTEGER)) data.totals[k] = parsed.totals[k];
      else if (parsed.totals[k] !== undefined) dropped.push('totals.' + k);
    }
  } else if (parsed.totals !== undefined) {
    dropped.push('totals');
  }

  if (parsed.best && typeof parsed.best === 'object' && !Array.isArray(parsed.best)) {
    for (const [tier, rec] of Object.entries(parsed.best)) {
      const ok = rec && typeof rec === 'object'
        && isNum(rec.ms, 0, Number.MAX_SAFE_INTEGER)
        && isNum(rec.hints, 0, 1e6)
        && isNum(rec.moves, 0, 1e7)
        && (rec.size === undefined || typeof rec.size === 'string');
      if (ok) data.best[tier] = { ms: rec.ms, hints: rec.hints, moves: rec.moves, size: rec.size || '', at: isNum(rec.at, 0, Number.MAX_SAFE_INTEGER) ? rec.at : 0 };
      else dropped.push('best.' + tier);
    }
  } else if (parsed.best !== undefined) {
    dropped.push('best');
  }

  const r = parsed.resume;
  if (r && typeof r === 'object' && !Array.isArray(r)
    && typeof r.seed === 'string' && r.seed.length && r.seed.length < 64
    && typeof r.tier === 'string' && r.tier.length < 24
    && isInt(r.cells, 1, 40 * 40)
    && isNum(r.elapsedMs, 0, 1000 * 60 * 60 * 24)
    && isInt(r.moves, 0, 1e6) && isInt(r.hints, 0, 1e6)
    && Array.isArray(r.ink) && r.ink.length <= r.cells * 2 + 2
    && r.ink.every((v, i) => (i % 2 ? isInt(v, 1, 255) : isInt(v, 0, 2)))) {
    data.resume = { seed: r.seed, tier: r.tier, cells: r.cells, ink: r.ink, elapsedMs: r.elapsedMs, moves: r.moves, hints: r.hints };
  } else if (r !== undefined && r !== null) {
    dropped.push('resume');
  }

  return { data, dropped };
}

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // 隐私模式下连读都会抛：那就从一份干净的默认值开始，游戏必须照样能玩。
    return { data: defaults(), dropped: ['storage-unavailable'] };
  }
  if (!raw) return { data: defaults(), dropped: [] };
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { data: defaults(), dropped: ['unparseable'] };
  }
  return sanitize(parsed);
}

const boot = load();

export const Store = {
  data: boot.data,
  // 这一次启动里被丢掉的记录名。坏档不该让游戏变聋，但也不该悄悄被忘掉。
  dropped: boot.dropped,

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* private mode / quota — the game is still playable, just forgetful */
    }
  },

  setting(name) {
    return this.data.settings[name];
  },
  setSetting(name, value) {
    this.data.settings[name] = value;
    this.save();
  },

  best(tier) {
    return this.data.best[tier] || null;
  },
  // Best time is decided by *least help taken* first: a record must mean "I worked this board
  // out myself", and a fast run built on six hints is not that.
  recordBest(tier, { ms, hints, moves, size }) {
    const cur = this.data.best[tier];
    const better =
      !cur ||
      hints < cur.hints ||
      (hints === cur.hints && (moves < cur.moves || (moves === cur.moves && ms < cur.ms)));
    if (better) this.data.best[tier] = { ms, hints, moves, size, at: Date.now() };
    this.save();
    return better;
  },

  recordSolve(ms, hints) {
    const t = this.data.totals;
    t.solved++;
    t.hints += hints;
    t.ms += ms;
    this.save();
  },

  saveResume(puzzle, state, elapsedMs, run) {
    this.data.resume = {
      // The generator derives an internal seed from what it is handed, so a resume has to store
      // the *origin* seed or the rebuilt board would not be the same one.
      seed: puzzle.originSeed || puzzle.seed,
      tier: puzzle.tier,
      elapsedMs,
      cells: puzzle.w * puzzle.h,
      ink: rleEncode(state),
      // The cost of the run travels with the board. Without it a player could take six hints,
      // close the tab, come back, and finish with a clean 提示 0 record — the number that
      // decides the best time is counted from actions, and actions are not saved.
      moves: run.moves,
      hints: run.hints,
      at: Date.now(),
    };
    this.save();
  },

  resume() {
    const r = this.data.resume;
    if (!r) return null;
    return { ...r, board: rleDecode(r.ink, r.cells) };
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  reset() {
    this.data = defaults();
    this.dropped = [];
    this.save();
  },

  // 重读一遍盘上的存档（同一套两段式解码）。验证脚本灌垃圾档之后用它把结果取回来。
  reload() {
    const { data, dropped } = load();
    this.data = data;
    this.dropped = dropped;
    return dropped;
  },
};
