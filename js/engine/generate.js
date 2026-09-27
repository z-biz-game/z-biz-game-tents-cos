// Generator. Solution first: pick an independent set of tent cells, give every tent a trunk
// beside it and every trunk a tent beside it, and the row/column counts *are* the clues — so a
// board cannot be born unsolvable, which is the opposite of guessing a clue set and hoping.
// Difficulty then comes from the one knob the game actually has: how many of those numbers get
// removed. A removal is kept only if the pencil path still finishes the board, so "unique" and
// "no guessing" are the same test here, and the exhaustive counter in count.js exists to check
// that the two have not drifted apart.

import { OPEN, TENT, NO_CLUE, createBoard, cluesFrom, solve } from './tents.js';

function mix(seed) {
  let x = typeof seed === 'string' ? 2166136261 : seed >>> 0;
  if (typeof seed === 'string') {
    for (let i = 0; i < seed.length; i++) {
      x ^= seed.charCodeAt(i);
      x = Math.imul(x, 16777619) >>> 0;
    }
  }
  x = x || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

const ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function neighbours(w, h, t) {
  const r = (t / w) | 0;
  const c = t % w;
  const out = [];
  for (const [dr, dc] of ORTH) {
    const nr = r + dr;
    const nc = c + dc;
    if (nr < 0 || nc < 0 || nr >= h || nc >= w) continue;
    out.push(nr * w + nc);
  }
  return out;
}

function touching(w, h, a, b) {
  const ra = (a / w) | 0;
  const ca = a % w;
  const rb = (b / w) | 0;
  const cb = b % w;
  return Math.abs(ra - rb) <= 1 && Math.abs(ca - cb) <= 1;
}

// Tents first, then the trunks that justify them. Both sides of the convention get checked where
// they are created rather than repaired afterwards: a tent with nowhere to put its tree is simply
// dropped, because a planted layout that already breaks a rule cannot be pruned into honesty.
export function plant(w, h, rand, tentP = 0.24, extraTreeP = 0.3) {
  const n = w * h;
  const tent = new Uint8Array(n);
  const tents = [];
  const order = [];
  for (let t = 0; t < n; t++) order.push(t);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const t of order) {
    if (rand() > tentP) continue;
    let clash = false;
    for (const s of tents) if (touching(w, h, t, s)) clash = true;
    if (clash) continue;
    tent[t] = 1;
    tents.push(t);
  }
  const tree = new Uint8Array(n);
  const keep = [];
  for (const t of tents) {
    const free = neighbours(w, h, t).filter((s) => !tent[s] && !tree[s]);
    if (!free.length) continue; // a tent the board cannot feed is not worth planting
    tree[free[Math.floor(rand() * free.length)]] = 1;
    keep.push(t);
  }
  for (let t = 0; t < n; t++) {
    if (tent[t] || tree[t] || rand() > extraTreeP) continue;
    if (!neighbours(w, h, t).some((s) => tent[s])) continue;
    tree[t] = 1;
  }
  const solution = new Int8Array(n);
  for (let t = 0; t < n; t++) solution[t] = tent[t] && !tree[t] ? TENT : OPEN;
  return { tree, solution, tents: keep.filter((t) => !tree[t]) };
}

// Greedy removal down to `target` numbers. Order is shuffled, so which numbers survive is a
// property of the seed, not of the scan direction.
export function pruneClues(board, rand, target) {
  const want = Int8Array.from(board.want);
  const order = [];
  for (let i = 0; i < want.length; i++) if (want[i] !== NO_CLUE) order.push(i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  let kept = board.clues;
  for (const i of order) {
    if (kept <= target) break;
    const before = want[i];
    want[i] = NO_CLUE;
    kept--;
    const probe = rebuild(board, want);
    if (!solve(probe).ok) {
      want[i] = before;
      kept++;
    }
  }
  return { rowClue: want.slice(0, board.h), colClue: want.slice(board.h, board.h + board.w) };
}

function rebuild(board, want) {
  return createBoard({
    w: board.w,
    h: board.h,
    tree: board.tree,
    rowClue: want.slice(0, board.h),
    colClue: want.slice(board.h, board.h + board.w),
  });
}

export function generate(opts = {}) {
  const {
    w = 6,
    h = 6,
    seed = 'plain',
    tentP = 0.24,
    extraTreeP = 0.3,
    keepRatio = 0.55,
    band = null,
    tries = 40,
    report = () => {},
  } = opts;
  let best = null;
  for (let k = 0; k < tries; k++) {
    const trial = `${seed}#${k}`;
    const rand = mix(trial);
    const { tree, solution } = plant(w, h, rand, tentP, extraTreeP);
    const { rowClue, colClue } = cluesFrom(w, h, tree, solution);
    let board;
    let clue;
    try {
      board = createBoard({ w, h, tree, rowClue, colClue });
      const target = Math.max(1, Math.round((w + h) * keepRatio));
      clue = pruneClues(board, rand, target);
      board = createBoard({ w, h, tree, ...clue });
    } catch {
      continue;
    }
    const p = solve(board);
    if (!p.ok) continue;
    const offBand = band ? Math.abs(p.score - clamp(p.score, band[0], band[1])) : 0;
    const cand = {
      board,
      solution,
      tree: board.tree,
      seed: trial,
      score: p.score,
      steps: p.steps,
      breakdown: p.breakdown,
      clues: board.clues,
      tents: solution.reduce((a, v) => a + (v === TENT ? 1 : 0), 0),
      offBand,
      gen: k + 1,
    };
    if (!best || cand.offBand < best.offBand) best = cand;
    report({ k, score: p.score, clues: board.clues, offBand });
    if (band && cand.offBand === 0) break;
  }
  if (!best) return { ok: false, board: null, reason: '没找到既唯一又能纯逻辑推到底的盘面' };
  return { ok: true, ...best };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// The bands below are selection targets, and every number in them is measured — see
// tools/balance.mjs, which prints the spread per tier and fails the build when the ladder stops
// ordering. keepRatio is how many of the 2·size numbers survive: it is tightened as the board
// grows, because the score is dominated by the number of cells and the clue pressure is the one
// knob that makes 大师 a different kind of puzzle rather than only a bigger one.
export const TIERS = [
  { key: 'trainee', name: '初学', w: 5, h: 5, tentP: 0.26, extraTreeP: 0.2, keepRatio: 1, band: [15, 21] },
  { key: 'apprentice', name: '上手', w: 6, h: 6, tentP: 0.25, extraTreeP: 0.25, keepRatio: 0.84, band: [23, 29] },
  { key: 'regular', name: '熟练', w: 7, h: 7, tentP: 0.24, extraTreeP: 0.3, keepRatio: 0.72, band: [32, 38] },
  { key: 'expert', name: '高阶', w: 8, h: 8, tentP: 0.23, extraTreeP: 0.35, keepRatio: 0.56, band: [41, 48] },
  { key: 'master', name: '大师', w: 9, h: 9, tentP: 0.22, extraTreeP: 0.4, keepRatio: 0.44, band: [52, 61] },
];

export function tierFor(key) {
  return TIERS.find((t) => t.key === key) || TIERS[1];
}

export function makePuzzle(seed, tierKey) {
  const tier = tierFor(tierKey);
  const r = generate({ ...tier, seed });
  if (!r.ok) return null;
  return {
    ...r,
    tier: tier.key,
    tierName: tier.name,
    originSeed: seed,
    size: `${tier.w}×${tier.h}`,
    w: tier.w,
    h: tier.h,
  };
}

export { NO_CLUE };
