// Tents / 帐篷 engine. Trees grow on the grid; a tent goes on a free cell next to a tree,
// no two tents touch — not even corner to corner — and every row and column says how many tents
// it holds. That is the whole game, so the only facts worth reasoning about are "this line has
// room for exactly k more" and "this tree's last option is this cell".
//
// `solve()` below is the pencil path: it is the player's route, the generator's acceptance test
// and the source of every hint, so it never backtracks. Search lives only in count.js, and the
// generator trusts neither.
//
// The pairing convention matters: a tree needs *at least* one tent beside it and a tent needs *at
// least* one tree beside it — not a one-to-one matching. A matching constraint would make the
// pencil rules incomplete in practice (you need Hall's theorem to see that a tree is starved),
// and this project only ships boards a player can finish by counting. See DESIGN §3.

// A cell's own states, and a *separate* sentinel for "this line carries no number". They cannot
// share one constant: 0 is a real clue here — it says "no tent in this line" — so treating it as
// "absent" would silently delete every zero from a board.
export const OPEN = 0;
export const TENT = 1; // 帐篷 — occupies a free cell, forbids tents on all eight neighbours
export const GRASS = 2; // 草地 — confirmed "no tent here"
export const NO_CLUE = -1;

const ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];
// Only the four forward neighbours: checking each tent once, in scan order, still finds every
// touching pair, so verify() cannot report the same clash twice.
const FORWARD = [[0, 1], [-1, 1], [1, 1], [1, 0]];

export const isTree = (board, t) => board.tree[t] === 1;

// The cells a tent may physically stand on: free, and with at least one tree orthogonally beside
// it. Everything else is grass before the player draws a line — that is rule 无树不扎营.
function spotTable(w, h, tree) {
  const spot = new Uint8Array(w * h);
  for (let t = 0; t < w * h; t++) {
    if (tree[t]) continue;
    const r = (t / w) | 0;
    const c = t % w;
    for (const [dr, dc] of ORTH) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= h || nc >= w) continue;
      if (tree[nr * w + nc]) spot[t] = 1;
    }
  }
  return spot;
}

export function createBoard({ w, h, tree, rowClue, colClue }) {
  if (!(w > 0 && h > 0)) throw new Error('board too small');
  const n = w * h;
  if (tree.length !== n) throw new Error('tree length mismatch');
  if (rowClue.length !== h) throw new Error('rowClue length mismatch');
  if (colClue.length !== w) throw new Error('colClue length mismatch');
  const spot = spotTable(w, h, tree);
  const rows = [];
  const cols = [];
  for (let r = 0; r < h; r++) rows.push([]);
  for (let c = 0; c < w; c++) cols.push([]);
  for (let t = 0; t < n; t++) {
    if (tree[t]) continue;
    rows[(t / w) | 0].push(t);
    cols[t % w].push(t);
  }
  // One id space for everything that carries a number, so diagnose()/the renderer and the hint
  // text all point at the same object: rows first, then columns, then the trees that are short.
  const lines = [];
  const want = [];
  for (let r = 0; r < h; r++) {
    lines.push(rows[r]);
    want.push(rowClue[r]);
  }
  for (let c = 0; c < w; c++) {
    lines.push(cols[c]);
    want.push(colClue[c]);
  }
  for (let i = 0; i < lines.length; i++) {
    const v = want[i];
    if (v === NO_CLUE) continue;
    // A clue above the number of cells the line could ever hold is not a hard board, it is a
    // typo — and it would otherwise be reported as "unsolvable" after a long search.
    let cap = 0;
    for (const t of lines[i]) if (spot[t]) cap++;
    if (v < 0 || v > cap) {
      throw new Error(`${lineName(i, h, w)} 写着 ${v}，可它最多只能放 ${cap} 顶帐篷`);
    }
  }
  const trees = [];
  for (let t = 0; t < n; t++) if (tree[t]) trees.push(t);
  if (!trees.length) throw new Error('盘上没有树');
  const treeSpots = trees.map((t) => {
    const r = (t / w) | 0;
    const c = t % w;
    const out = [];
    for (const [dr, dc] of ORTH) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= h || nc >= w) continue;
      const s = nr * w + nc;
      if (spot[s]) out.push(s);
    }
    return out;
  });
  // Which trunks a given cell could serve, in the same id space diagnose() uses. The renderer
  // needs it to colour a tent by the engine's verdict, and reading this table is the alternative
  // to it re-deriving adjacency — which is how a picture starts disagreeing with a solver.
  const cellTrees = Array.from({ length: n }, () => []);
  for (let k = 0; k < trees.length; k++) {
    for (const s of treeSpots[k]) cellTrees[s].push(lines.length + trees[k]);
  }
  let clues = 0;
  for (let i = 0; i < want.length; i++) if (want[i] !== NO_CLUE) clues++;
  if (!clues) throw new Error('盘上没有数字');
  return {
    w,
    h,
    n,
    nl: lines.length,
    tree: Uint8Array.from(tree),
    spot,
    rows,
    cols,
    lines,
    want: Int8Array.from(want),
    trees,
    treeSpots,
    cellTrees,
    clues,
    total: n - trees.length,
    cells: Array.from({ length: n }, (_, i) => i),
    rowId: (r) => r,
    colId: (c) => h + c,
    treeId: (t) => lines.length + t,
    lineName: (i) => lineName(i, h, w),
    cellName: (t) => `第${((t / w) | 0) + 1}行${(t % w) + 1}列`,
  };
}

function lineName(i, h, w) {
  return i < h ? `第${i + 1}行` : `第${i - h + 1}列`;
}

// The numbers a solution implies. Used by the generator, and by nothing that judges a board —
// verify() reads the clues, never this.
export function cluesFrom(w, h, tree, solution) {
  const rowClue = new Int8Array(h);
  const colClue = new Int8Array(w);
  for (let t = 0; t < w * h; t++) {
    if (tree[t] || solution[t] !== TENT) continue;
    rowClue[(t / w) | 0]++;
    colClue[t % w]++;
  }
  return { rowClue, colClue };
}

export const Rules = {
  bare: {
    name: '无树不扎营',
    weight: 1,
    text: (b, d) => `${b.cellName(d.cell)} 四边没有树，帐篷不能配给它旁边的树——这里只能是草地`,
  },
  ring: {
    name: '一帐八周空',
    weight: 1,
    text: (b, d) => `${b.cellName(d.tent)} 已经有一顶帐篷，八格之内（斜角也算）都不能再有`,
  },
  full: {
    name: '行列封顶',
    weight: 1,
    text: (b, d) => `${b.lineName(d.line)} 写着 ${d.want}，帐篷已经凑满，其余格子都得留成草地`,
  },
  need: {
    name: '只差这些',
    weight: 1.5,
    text: (b, d) => `${b.lineName(d.line)} 写着 ${d.want}，还差 ${d.need} 顶，而它只剩 ${d.open} 格可放——那 ${d.open} 格都必须扎营`,
  },
  only: {
    name: '树唯一落点',
    weight: 1,
    text: (b, d) => `${b.cellName(d.tree)} 旁只剩 ${b.cellName(d.cell)} 一格能扎营，帐篷只能在这里`,
  },
};

function lineState(board, i, derived) {
  let have = 0;
  const open = [];
  for (const t of board.lines[i]) {
    if (derived[t] === TENT) have++;
    else if (derived[t] === OPEN) open.push(t);
  }
  return { have, open };
}

// One sweep: everything the numbers and the trees already decide. Each write below is a
// consequence of a rule of the game, so it holds in every solution of the board.
export function propagate(board, derived) {
  const found = [];
  let changed = false;
  const push = (t, value, rule, d) => {
    if (derived[t] === value) return;
    derived[t] = value;
    found.push({ cell: t, value, rule, ...d });
    changed = true;
  };

  for (let t = 0; t < board.n; t++) {
    if (board.tree[t] || derived[t] !== OPEN) continue;
    if (!board.spot[t]) push(t, GRASS, Rules.bare, { tree: -1 });
  }
  for (let t = 0; t < board.n; t++) {
    if (derived[t] !== TENT) continue;
    const r = (t / board.w) | 0;
    const c = t % board.w;
    for (const [dr, dc] of ringOffsets(board.w, board.h, r, c)) {
      const s = dr * board.w + dc;
      if (board.tree[s] || derived[s] !== OPEN) continue;
      push(s, GRASS, Rules.ring, { tent: t });
    }
  }
  for (let i = 0; i < board.nl; i++) {
    const want = board.want[i];
    if (want === NO_CLUE) continue;
    const { have, open } = lineState(board, i, derived);
    const need = want - have;
    if (need < 0 || need > open.length) {
      return { found: [], changed: false, conflict: conflictOf(board, i, have, open, need), line: i };
    }
    if (!open.length) continue;
    if (need === 0) {
      for (const t of open) push(t, GRASS, Rules.full, { line: i, want });
    } else if (need === open.length) {
      for (const t of open) push(t, TENT, Rules.need, { line: i, want, need, open: open.length });
    }
  }
  for (let k = 0; k < board.trees.length; k++) {
    const tree = board.trees[k];
    const spots = board.treeSpots[k];
    let have = 0;
    const open = [];
    for (const s of spots) {
      if (derived[s] === TENT) have++;
      else if (derived[s] === OPEN) open.push(s);
    }
    if (have) continue;
    if (!open.length) {
      return {
        found: [],
        changed: false,
        conflict: `${board.cellName(tree)} 这棵树旁边已经没有可扎营的格子了`,
        tree,
      };
    }
    if (open.length === 1) push(open[0], TENT, Rules.only, { tree, cell: open[0] });
  }
  return { found, changed };
}

function conflictOf(board, i, have, open, need) {
  if (need < 0) {
    return `${board.lineName(i)} 写着 ${board.want[i]}，可这里已经有 ${have} 顶帐篷了`;
  }
  return `${board.lineName(i)} 写着 ${board.want[i]}，已有 ${have} 顶、只剩 ${open.length} 格可放，凑不齐`;
}

// The eight neighbours, clipped to the board. Its own function because both the pencil rule and
// the acceptance test need it, and they must agree on what "touching" means.
function ringOffsets(w, h, r, c) {
  const out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const nr = r + dr;
    const nc = c + dc;
    if (nr < 0 || nc < 0 || nr >= h || nc >= w) continue;
    out.push([nr, nc]);
  }
  return out;
}

// The pencil path from an empty board to a finished one. Returns the deductions in the order the
// clues forced them — that list *is* the hint script, and it never reads the player's ink, so a
// wrong tent cannot make the hints agree with the mistake.
export function solve(board) {
  const derived = new Int8Array(board.n);
  const rows = [];
  const used = new Map();
  let guard = 0;
  for (;;) {
    const sweep = propagate(board, derived);
    if (sweep.conflict) return { ok: false, conflict: sweep.conflict, rows, steps: rows.length, score: 0, breakdown: {} };
    if (!sweep.changed) break;
    for (const f of sweep.found) {
      const key = f.rule.name;
      const cur = used.get(key) || { n: 0, weight: f.rule.weight };
      cur.n++;
      used.set(key, cur);
      rows.push(f);
    }
    if (++guard > 400) return { ok: false, conflict: '推导没有收敛（引擎缺陷）', rows, steps: rows.length, score: 0, breakdown: {} };
  }
  let filled = 0;
  for (let t = 0; t < board.n; t++) if (derived[t] !== OPEN) filled++;
  const done = filled === board.total;
  let score = 0;
  for (const x of used.values()) score += x.n * x.weight;
  return {
    ok: done,
    derived,
    rows,
    steps: rows.length,
    score: Math.round(score * 10) / 10,
    breakdown: Object.fromEntries([...used].map(([k, v]) => [k, v.n])),
  };
}

// The next thing the clues force that the player has not drawn yet.
export function nextDeduction(board, derived) {
  const sweep = propagate(board, derived);
  if (sweep.conflict) return { conflict: sweep.conflict };
  return sweep.found[0] || null;
}

// ---- is this ink still survivable? --------------------------------------------

// Every write the rules make is true in *every* solution, so if seeding the player's own tents
// and grass and then running those rules hits a contradiction, no completion of this board
// exists. That is the one thing a player cannot see coming — a single extra tent violates no
// number at all — and it is worth saying out loud.
export function reachable(board, cell) {
  const derived = Int8Array.from(cell);
  for (let round = 0; round < board.n + 4; round++) {
    const sweep = propagate(board, derived);
    if (sweep.conflict) return false;
    if (!sweep.changed) break;
  }
  return true;
}

// ---- readouts for the UI -----------------------------------------------------

// Judged straight from the rules of the game: a clued line must hold exactly that many tents,
// touching tents are illegal, a tree needs a tent beside it and a tent needs a tree beside it.
// Nothing here reads `derived` or the hint script, so a bug in the propagation cannot fake a win.
export function verify(board, cell) {
  const bad = [];
  for (let t = 0; t < board.n; t++) {
    if (board.tree[t]) continue;
    if (cell[t] === OPEN) bad.push({ why: '空格', cell: t });
  }
  for (let t = 0; t < board.n; t++) {
    if (cell[t] !== TENT) continue;
    if (!board.spot[t]) bad.push({ why: '这里没有树可配', cell: t });
    const r = (t / board.w) | 0;
    const c = t % board.w;
    for (const [dr, dc] of FORWARD) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= board.h || nc >= board.w) continue;
      if (cell[nr * board.w + nc] === TENT) bad.push({ why: '帐篷相邻', cell: t });
    }
  }
  for (let i = 0; i < board.nl; i++) {
    const want = board.want[i];
    if (want === NO_CLUE) continue;
    const { have, open } = lineState(board, i, cell);
    if (have > want) bad.push({ why: '帐篷多了', line: i, want, have });
    else if (have + open.length < want) bad.push({ why: '帐篷不够', line: i, want, have, open: open.length });
  }
  for (let k = 0; k < board.trees.length; k++) {
    let have = 0;
    for (const s of board.treeSpots[k]) if (cell[s] === TENT) have++;
    if (!have) bad.push({ why: '树旁没帐', cell: board.trees[k] });
  }
  return bad;
}

export function complete(board, cell) {
  return verify(board, cell).length === 0 && cell.every((v, t) => board.tree[t] === 1 || v !== OPEN);
}

export function diagnose(board, cell) {
  let filled = 0;
  for (let t = 0; t < board.n; t++) if (!board.tree[t] && cell[t] !== OPEN) filled++;
  const violated = new Set();
  const satisfied = new Set();
  for (let i = 0; i < board.nl; i++) {
    const want = board.want[i];
    if (want === NO_CLUE) continue;
    const { have, open } = lineState(board, i, cell);
    if (have > want || have + open.length < want) violated.add(i);
    else if (have === want && open.length === 0) satisfied.add(i);
  }
  for (let k = 0; k < board.trees.length; k++) {
    let have = 0;
    let open = 0;
    for (const s of board.treeSpots[k]) {
      if (cell[s] === TENT) have++;
      else if (cell[s] === OPEN) open++;
    }
    const id = board.treeId(board.trees[k]);
    if (!have && !open) violated.add(id);
    else if (have) satisfied.add(id);
  }
  for (let t = 0; t < board.n; t++) {
    if (cell[t] === TENT && !board.spot[t]) violated.add(board.treeId(t));
  }
  return {
    filled,
    total: board.total,
    remaining: board.total - filled,
    clues: board.clues,
    violated,
    satisfied,
    conflicts: violated.size,
  };
}

// ---- the player's own ink ----------------------------------------------------

export function createState(board) {
  return { board, cell: new Int8Array(board.n), history: [] };
}

export function snapshot(st) {
  st.history.push(Int8Array.from(st.cell));
  if (st.history.length > 500) st.history.shift();
  return st;
}

export function undo(st) {
  const last = st.history.pop();
  if (!last) return false;
  st.cell.set(last);
  return true;
}

export function setCell(st, t, value) {
  if (t < 0 || t >= st.board.n) return false;
  if (st.board.tree[t]) return false; // a trunk holds no ink
  if (st.cell[t] === value) return false;
  snapshot(st);
  st.cell[t] = value;
  return true;
}

export function eraseCell(st, t) {
  return setCell(st, t, OPEN);
}

export function resetInk(st) {
  st.cell.fill(OPEN);
  st.history.length = 0;
  return st;
}
