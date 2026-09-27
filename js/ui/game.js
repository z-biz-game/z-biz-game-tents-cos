// The playable state machine: what a tap does, what an undo takes back, when a board counts as
// solved, and what a hint is allowed to say.
//
// Two deliberate bindings to js/engine/tents.js:
//   * the ink lives in the engine's own `st.cell` array, and the win check is the engine's
//     independent `verify()` — written from the rules of the game rather than from this file's
//     bookkeeping — so "the UI said I won" cannot disagree with "every line adds up and every
//     trunk has a tent".
//   * hints are read out of a script the *numbers* produced (`solve()`), never out of the player's
//     own marks. A tent in the wrong place therefore cannot make the hints agree with the mistake:
//     the engine keeps saying what the clues actually force.

import {
  createState,
  setCell,
  snapshot,
  undo as undoState,
  solve,
  verify,
  complete,
  reachable,
  diagnose,
  Rules,
  OPEN,
  TENT,
  GRASS,
} from '../engine/tents.js';

export { OPEN, TENT, GRASS };

export class Game {
  constructor(puzzle) {
    this.puzzle = puzzle;
    this.board = puzzle.board;
    this.w = puzzle.board.w;
    this.h = puzzle.board.h;
    this.st = createState(puzzle.board);
    this.steps = [];
    // The whole hint script is computed once, from the clues alone. `solve()` is the same
    // function the generator used to accept this board, so a hint can never be a fact the
    // clues do not force.
    this.script = solve(puzzle.board).rows;
    this.cursor = 0;
    this.moves = 0;
    this.hints = 0;
    this.status = 'playing';
    this.mode = TENT;
    this.lastHint = null;
    this.recompute();
  }

  recompute() {
    this.diag = diagnose(this.board, this.st.cell);
    this.violated = verify(this.board, this.st.cell);
    this.stuck = !reachable(this.board, this.st.cell);
    return this.diag;
  }

  cellAt(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return y * this.w + x;
  }

  valueOf(t) {
    return t >= 0 && t < this.board.n ? this.st.cell[t] : OPEN;
  }

  // Every gesture consumes exactly one engine snapshot and records the cells it changed with
  // their prior values, so 撤销 is an exact reverse rather than a re-derivation.
  commit(kind, info) {
    this.steps.push({ kind, ...info });
    if (kind === 'hint') this.hints++;
    else if (kind !== 'prune') this.moves++;
    this.recompute();
    this.checkWin();
    return this.steps[this.steps.length - 1];
  }

  // One predictable rule for both modes: tapping the mark that is already there erases it,
  // tapping anything else puts this mode's mark there. A trunk takes no ink at all — the engine
  // refuses it, so here it refuses the gesture instead of silently eating a move.
  tap(t, mode = this.mode) {
    if (this.status === 'won' || t < 0 || this.board.tree[t]) return null;
    const from = this.st.cell[t];
    const want = from === mode ? OPEN : mode;
    if (!setCell(this.st, t, want)) return null;
    return this.commit('tap', { writes: [{ cell: t, from, to: want }], value: want });
  }

  // A drag paints one value, never toggling — sweeping back over your own mark must not eat it.
  // The whole gesture is one step, so 撤销 undoes a stroke rather than a cell of it.
  stroke(cells, value) {
    if (this.status === 'won') return null;
    const writes = [];
    const seen = new Set();
    for (const t of cells) {
      if (t < 0 || t >= this.board.n || seen.has(t) || this.board.tree[t]) continue;
      seen.add(t);
      if (this.st.cell[t] === value) continue;
      writes.push({ cell: t, from: this.st.cell[t], to: value });
    }
    if (!writes.length) return null;
    snapshot(this.st);
    for (const w of writes) this.st.cell[w.cell] = w.to;
    return this.commit('stroke', { writes, value });
  }

  load(cells) {
    for (let t = 0; t < this.board.n; t++) {
      const v = cells[t];
      this.st.cell[t] = v === TENT || v === GRASS ? v : OPEN;
    }
    this.recompute();
    this.checkWin();
    return this;
  }

  undo() {
    const step = this.steps.pop();
    if (!step) return null;
    undoState(this.st);
    for (const w of step.writes || []) this.st.cell[w.cell] = w.from;
    // A hint taken back is still a hint that was taken: records rank runs by help used, so
    // refunding the counter would let a player undo their way to a clean 提示 0.
    if (step.kind !== 'hint') this.moves = Math.max(0, this.moves - 1);
    this.recompute();
    return step;
  }

  // The next fact the clues force that the player has not drawn yet. Everything before it in the
  // script is already on the board, so a hint is always one step of real progress — and when the
  // script is exhausted the board is solved, so "nothing to say" cannot be charged for.
  hint() {
    if (this.status === 'won') return null;
    while (this.cursor < this.script.length) {
      const row = this.script[this.cursor];
      if (this.st.cell[row.cell] === row.value) {
        this.cursor++;
        continue;
      }
      if (this.st.cell[row.cell] !== OPEN && this.st.cell[row.cell] !== row.value) {
        // the player's own mark contradicts what the clues force: say so, and charge nothing
        return {
          conflict: `${this.board.cellName(row.cell)} 上不能这么放：按数字这里必须是${name(row.value)}。`,
          cell: row.cell,
        };
      }
      const from = this.st.cell[row.cell];
      setCell(this.st, row.cell, row.value);
      this.cursor++;
      this.commit('hint', { writes: [{ cell: row.cell, from, to: row.value }], value: row.value, rule: row.rule.name });
      const info = {
        rule: row.rule.name,
        cell: row.cell,
        value: row.value,
        line: row.line,
        // Which cell gave the rule its right to speak, so the canvas can ring it too: `board.js`
        // draws a pulse round `pulse.tent` for 一帐八周空, and without this field that ring — and
        // any reader of the hint — has nothing to point at.
        tent: row.tent,
        tree: row.tree,
        why: row.rule.text(this.board, row),
        charged: true,
      };
      this.lastHint = info;
      return info;
    }
    return { stalled: true, text: '数字能推的都已经推完了：剩下的格只能自己收尾。' };
  }

  checkWin() {
    this.status = complete(this.board, this.st.cell) ? 'won' : 'playing';
    return this.status === 'won';
  }

  // Only used by the verification harness and the "solve it for me" path: play the clue-derived
  // script to the end. Every cell it writes is one the pencil rules justify.
  solveWithLogic({ cap = 4000 } = {}) {
    let k = 0;
    while (this.status !== 'won' && k++ < cap) {
      const before = this.steps.length;
      const h = this.hint();
      if (!h || h.stalled || h.conflict) break;
      if (this.steps.length === before) break;
    }
    return { status: this.status, steps: k };
  }

  state() {
    const g = this.diag;
    return {
      tier: this.puzzle.tier,
      name: this.puzzle.tierName,
      seed: this.puzzle.seed,
      originSeed: this.puzzle.originSeed,
      moves: this.moves,
      hints: this.hints,
      status: this.status,
      filled: g.filled,
      total: g.total,
      remaining: g.remaining,
      clues: g.clues,
      // `diag.satisfied` mixes two kinds of id in one space (numbered lines below `board.nl`, then
      // every trunk at `nl + cell`), because the renderer asks it whether a tree has a tent. The
      // panel reads this as "凑齐的数 / 数字总数", so the numerator has to be the numbered lines
      // only — otherwise a solved 8×8 with nine clues reports "28/9".
      satisfied: [...g.satisfied].filter((id) => id < this.board.nl).length,
      conflicts: g.violated.size,
      stuck: this.stuck,
      problems: this.violated.length,
      script: this.script.length,
      cursor: this.cursor,
      score: this.puzzle.score,
      steps: this.steps.length,
      mode: this.mode,
    };
  }
}

export function name(value) {
  return value === TENT ? '帐篷' : value === GRASS ? '草地' : '待定';
}

export { Rules };
