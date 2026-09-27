// An exhaustive counter. It shares no helper, no rule and no state with tents.js: the tree/spot
// tables, the ring offsets and the line membership are rebuilt here straight from the rules of the
// game, because the point of the second opinion is that a mistake in the first one cannot show up
// in both.
//
// It answers one question — how many completions does this clue set have? — and stops at `cap`,
// spending its node budget rather than lying about a board it could not finish counting.
//
// `all: true` hands back every completion it found instead of just the first. That is what lets
// the test ask the question the pencil has to survive: is each of its writes true in *every*
// solution, not merely true in one of them?

import { OPEN, NO_CLUE, TENT, GRASS } from './tents.js';

// Rebuilt by hand from the prose: a tent stands on a free cell beside a trunk, and touching means
// the eight surrounding cells, corner included. Deliberately not imported from tents.js.
const ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const BACK = [[0, -1], [-1, -1], [-1, 0], [-1, 1]];

export const UNIQUE = 'UNIQUE';
export const MANY = 'MANY';
export const NONE = 'NONE';
export const OVERBUDGET = 'OVERBUDGET';

// Cells are decided in scan order, so a line's count is checked the moment its last cell lands and
// a tree's need is checked the moment its last spot does: that is what keeps the search off the
// 2^(w*h) floor.
export function countSolutions(board, { cap = 2, budget = 300000, all = false } = {}) {
  const { w, h, tree, rowClue, colClue } = plainClues(board);
  const n = w * h;
  const spot = new Uint8Array(n);
  const ringBack = [];
  const treeSpots = [];
  for (let t = 0; t < n; t++) {
    const r = (t / w) | 0;
    const c = t % w;
    const back = [];
    for (const [dr, dc] of BACK) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= h || nc >= w) continue;
      back.push(nr * w + nc);
    }
    ringBack.push(back);
    if (tree[t]) continue;
    let beside = false;
    for (const [dr, dc] of ORTH) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= h || nc >= w) continue;
      if (tree[nr * w + nc]) beside = true;
    }
    spot[t] = beside ? 1 : 0;
  }
  // Which cells finish a tree, and which cells finish a line, indexed by the scan position that
  // closes them.
  const treeOf = new Map();
  for (let t = 0; t < n; t++) {
    if (!tree[t]) continue;
    const r = (t / w) | 0;
    const c = t % w;
    const spots = [];
    for (const [dr, dc] of ORTH) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= h || nc >= w) continue;
      const s = nr * w + nc;
      if (spot[s]) spots.push(s);
    }
    if (!spots.length) return { status: NONE, solutions: 0, nodes: 1, first: null };
    treeOf.set(t, { spots, have: 0, left: spots.length });
  }
  // Every spot feeds back into its tree's counter, not just the last one: a tree is only known to
  // be starved once its *final* open option has been assigned, and counting the options down from
  // len to len-1 at one cell would never reach zero.
  const atSpot = [];
  for (let t = 0; t < n; t++) atSpot.push([]);
  for (const info of treeOf.values()) for (const s of info.spots) atSpot[s].push(info);
  const lineOf = [];
  const left = [];
  const have = [];
  const wantLine = new Int8Array(h + w);
  for (let r = 0; r < h; r++) wantLine[r] = rowClue[r];
  for (let c = 0; c < w; c++) wantLine[h + c] = colClue[c];
  for (let t = 0; t < n; t++) lineOf.push([]);
  for (let r = 0; r < h; r++) {
    let count = 0;
    for (let c = 0; c < w; c++) if (!tree[r * w + c]) count++;
    left.push(count);
    have.push(0);
    for (let c = 0; c < w; c++) if (!tree[r * w + c]) lineOf[r * w + c].push(r);
  }
  for (let c = 0; c < w; c++) {
    let count = 0;
    for (let r = 0; r < h; r++) if (!tree[r * w + c]) count++;
    left.push(count);
    have.push(0);
    for (let r = 0; r < h; r++) if (!tree[r * w + c]) lineOf[r * w + c].push(h + c);
  }
  const assign = new Int8Array(n);
  let nodesVisited = 0;
  let solutions = 0;
  let first = null;
  const every = all ? [] : null;
  let over = false;

  // Declared ahead of go() and handed its per-branch state: a hoisted `function` inside go()
  // would live in that call's scope, which the `const`s above it cannot see.
  const undoState = (touched, touchedTrees, isTent, t) => {
    for (const i of touched) {
      if (isTent) have[i]--;
      left[i]++;
    }
    for (const info of touchedTrees) {
      if (isTent) info.have--;
      info.left++;
    }
    assign[t] = OPEN;
  };

  function go(t) {
    if (nodesVisited++ > budget) {
      over = true;
      return true;
    }
    if (t === n) {
      solutions++;
      if (!first) first = Int8Array.from(assign);
      if (every) every.push(Int8Array.from(assign));
      return solutions >= cap;
    }
    if (tree[t]) return go(t + 1);
    for (const v of [TENT, GRASS]) {
      if (v === TENT && !spot[t]) continue;
      let bad = false;
      assign[t] = v;
      const isTent = v === TENT;
      for (const b of ringBack[t]) if (isTent && assign[b] === TENT) bad = true;
      const touched = lineOf[t];
      for (const i of touched) {
        left[i]--;
        if (isTent) have[i]++;
        if (wantLine[i] !== NO_CLUE) {
          if (have[i] > wantLine[i]) bad = true;
          if (left[i] === 0 && have[i] !== wantLine[i]) bad = true;
          if (have[i] + left[i] < wantLine[i]) bad = true;
        }
      }
      const touchedTrees = atSpot[t];
      for (const info of touchedTrees) {
        info.left--;
        if (isTent) info.have++;
        if (info.left === 0 && info.have === 0) bad = true;
      }
      if (!bad && go(t + 1)) {
        undoState(touched, touchedTrees, isTent, t);
        return true;
      }
      undoState(touched, touchedTrees, isTent, t);
    }
    assign[t] = OPEN;
    return false;
  }
  go(0);
  if (over) return { status: OVERBUDGET, solutions, nodes: nodesVisited, first: null, every: null };
  // Read off the count, not off `cap`: with `all` the caller asks for hundreds of completions, and
  // "two of them" is still MANY even though the cap was never reached.
  return {
    status: solutions === 0 ? NONE : solutions === 1 ? UNIQUE : MANY,
    solutions,
    nodes: nodesVisited,
    first,
    every,
  };
}

// The counter reads the board through its own plain arrays, never through the line/id tables
// tents.js builds, so a bug in those tables cannot hide a second solution.
function plainClues(board) {
  const { w, h } = board;
  const rowClue = new Int8Array(h);
  const colClue = new Int8Array(w);
  for (let r = 0; r < h; r++) rowClue[r] = board.want[board.rowId(r)];
  for (let c = 0; c < w; c++) colClue[c] = board.want[board.colId(c)];
  return { w, h, tree: board.tree, rowClue, colClue };
}
