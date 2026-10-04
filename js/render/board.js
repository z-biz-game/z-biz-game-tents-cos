// Canvas renderer. It reads the Game's engine state and paints; it decides nothing — no line is
// "satisfied" here, no tent is judged wrong here — so the picture cannot disagree with the solver
// that the hints and the win check both use. Everything coloured comes out of `game.diag`, and the
// only geometry it needs (which trunks a cell could serve, which numbers a cell falls under) is
// read off tables the engine already built.
//
// Layout lives here too (cell size from the container, board origin, DPR) because hitTest has to
// answer with the *same* numbers draw() used. Those two drifting apart is how a board renders
// correctly but takes clicks one cell off.


/* ---------- 帧率无关（dt）---------- */
/* 本仓**没有逐帧运动**，所以「帧率无关」这一项在本仓是空命题而不是缺陷：js/render/board.js 的重绘由 pointerdown / click / keydown 触发，全仓 requestAnimationFrame 出现 0 次；唯一的周期性调用是 js/main.js:119 那个 1 秒 ticker（刷新用时读数 + 落盘续玩卡）
   没有自续期的 requestAnimationFrame 循环，屏上就没有「每帧推进」的量，帧率也就无从影响它。
   写这段备案是为了让账上分得开"查过、确实不需要"与"没人查过"——不是为了让判据变绿。

   规矩：**哪天在本仓加了逐帧动画循环，必须先删掉这段备案**，并让循环体消费 rAF 自带的
   时间戳（或自己取 performance.now()），把动画进度写成绝对截止；只按帧累加位置的一律不算。 */
import { Palette, Cell, Radius, Font } from '../theme.js';
// The renderer compares the engine's cell constants to decide what to paint — `NO_CLUE` alone
// leaves `OPEN`/`TENT`/`GRASS` unbound, and the first draw() then dies with a ReferenceError
// before a single cell reaches the canvas.
import { NO_CLUE, OPEN, TENT, GRASS } from '../engine/tents.js';

export function layoutFor(w, h, availW, availH) {
  // One-sided gutters: the row numbers sit to the left of the grid and the column numbers above
  // it. A symmetric pad would centre the board in a box it does not fill and waste the room the
  // largest tier needs.
  const gutter = 30;
  const size = Math.max(0, Math.min((availW - gutter) / w, (availH - gutter) / h));
  const cell = Math.max(Cell.min, Math.min(Cell.max, Math.floor(size)));
  return { cell, boardW: cell * w, boardH: cell * h, gutter };
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.geo = { cell: 0, x: 0, y: 0, w: 0, h: 0, dpr: 1 };
  }

  // The backing buffer is sized in device pixels while every draw call stays in CSS pixels: one
  // ctx.scale at the top keeps the digits crisp on a Retina display without doubling every
  // constant in this file.
  resize(game, availW, availH) {
    const l = layoutFor(game.w, game.h, availW, availH);
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const size = { w: l.boardW + l.gutter, h: l.boardH + l.gutter };
    this.canvas.style.width = `${size.w}px`;
    this.canvas.style.height = `${size.h}px`;
    this.canvas.width = Math.round(size.w * dpr);
    this.canvas.height = Math.round(size.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { cell: l.cell, x: l.gutter, y: l.gutter, w: size.w, h: size.h, dpr };
    this.game = game;
    return this.geo;
  }

  cellRect(t) {
    const { cell, x, y } = this.geo;
    return { x: (t % this.game.w) * cell + x, y: (((t / this.game.w) | 0) * cell) + y, size: cell };
  }

  rowPoint(r) {
    const { cell, x, y } = this.geo;
    return { x: x * 0.5, y: y + r * cell + cell / 2 };
  }

  colPoint(c) {
    const { cell, x, y } = this.geo;
    return { x: x + c * cell + cell / 2, y: y * 0.5 };
  }

  hitCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { cell, x, y } = this.geo;
    const game = this.game;
    if (!cell || !game) return -1;
    const px = clientX - rect.left - x;
    const py = clientY - rect.top - y;
    if (px < 0 || py < 0) return -1;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    if (gx < 0 || gy < 0 || gx >= game.w || gy >= game.h) return -1;
    return gy * game.w + gx;
  }

  draw(game, { pulse = null, preview = null } = {}) {
    this.game = game;
    const { ctx, geo } = this;
    const { cell } = geo;
    const b = game.board;
    const st = game.st;
    const diag = game.diag;
    const won = game.status === 'won';
    ctx.clearRect(0, 0, geo.w, geo.h);

    roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
    ctx.fillStyle = Palette.surface;
    ctx.fill();

    // Cells: the paper. A settled cell is lifted so the grid you are filling reads as filled, and
    // a trunk gets its own ground because nothing can ever be placed on it.
    for (let t = 0; t < b.n; t++) {
      const r = this.cellRect(t);
      ctx.fillStyle = b.tree[t] ? Palette.bgTop : st.cell[t] === OPEN ? Palette.bgBottom : Palette.surfaceLift;
      ctx.fillRect(r.x, r.y, cell, cell);
    }

    // Which cells the engine says are wrong, straight off its verdict: a number its line cannot
    // reach, or a trunk with no tent left to serve it, or a tent standing where no trunk is.
    const badCells = new Set();
    for (const id of diag.violated) {
      if (id < b.nl) for (const t of b.lines[id]) badCells.add(t);
      else badCells.add(id - b.nl);
    }

    // The marks. Colour is the live feedback this game lives on: a tent whose trunks and whose
    // line are all content is cool blue, one caught by a number or by a neighbour is red, and a
    // finished board is all green.
    for (let t = 0; t < b.n; t++) {
      if (b.tree[t]) {
        drawTree(ctx, this.cellRect(t), cell, won ? Palette.success : Palette.pencilStrong);
        continue;
      }
      const v = st.cell[t];
      if (v === OPEN) continue;
      const r = this.cellRect(t);
      const bad = badCells.has(t);
      const colour = won ? Palette.success : bad ? Palette.error : v === GRASS ? Palette.inkFaint : tentColour(b, t, diag);
      if (v === TENT) drawTent(ctx, r, cell, colour);
      else drawGrass(ctx, r, cell, colour);
    }

    // Grid.
    ctx.strokeStyle = Palette.line;
    ctx.lineWidth = 1;
    for (let i = 0; i <= game.w; i++) line(ctx, geo.x + i * cell, geo.y, geo.x + i * cell, geo.y + game.h * cell);
    for (let j = 0; j <= game.h; j++) line(ctx, geo.x, geo.y + j * cell, geo.x + game.w * cell, geo.y + j * cell);

    // The run of cells under the finger. Their marks are drawn by the loop above, not here: a
    // preview writes into `st.cell` straight away (see `preview()` in js/main.js) so the drag looks
    // exactly like the ink it is about to become — what is deferred is the *step*, which is why an
    // aborted gesture can be restored cell by cell. The dashed outline is the only paint-only part.
    if (preview && preview.cells) {
      ctx.strokeStyle = Palette.accent;
      ctx.lineWidth = Math.max(2, cell * 0.06);
      ctx.setLineDash([Math.max(4, cell * 0.2), Math.max(3, cell * 0.14)]);
      for (const t of preview.cells) {
        const r = this.cellRect(t);
        ctx.strokeRect(r.x + 1.5, r.y + 1.5, cell - 3, cell - 3);
      }
      ctx.setLineDash([]);
    }

    // The numbers last, so a count always sits on top of the cells it counts.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const rad = Math.min(14, cell * Cell.nodeScale);
    for (let r = 0; r < b.h; r++) drawClue(ctx, this.rowPoint(r), b.want[b.rowId(r)], rad, diag, b.rowId(r));
    for (let c = 0; c < b.w; c++) drawClue(ctx, this.colPoint(c), b.want[b.colId(c)], rad, diag, b.colId(c));

    // What a hint just named — the only place the UI is allowed to say "look here". The ring goes
    // on the cell and on whatever gave the rule its right to speak: the line, or the trunk.
    if (pulse && pulse.cell != null) {
      const r = this.cellRect(pulse.cell);
      ctx.strokeStyle = pulse.color || Palette.hint;
      ctx.lineWidth = Math.max(2, cell * 0.09);
      roundRect(ctx, r.x + 2, r.y + 2, cell - 4, cell - 4, Radius.cell);
      ctx.stroke();
      if (pulse.line != null) {
        const p = pulse.line < b.h ? this.rowPoint(pulse.line) : this.colPoint(pulse.line - b.h);
        ring(ctx, p, rad + Math.max(2, cell * 0.06), cell, Palette.hint);
      }
      for (const t of [pulse.tree, pulse.tent]) {
        // A hint that is not about a trunk carries the engine's "no such object" sentinel, and
        // cellRect(-1) wraps to a point in the left gutter — which is a ring drawn through the
        // row numbers on every 无树不扎营 hint. Only a real cell may be ringed.
        if (t == null || t < 0) continue;
        ring(ctx, centreOf(this.cellRect(t), cell), cell * 0.42, cell, Palette.hint);
      }
    }
  }
}

// A tent is blue only when every trunk it could serve and every numbered line it falls under are
// already content — all of it read off the engine's `satisfied`, never re-judged here.
function tentColour(b, t, diag) {
  const lines = [b.rowId((t / b.w) | 0), b.colId(t % b.w)];
  const trees = b.cellTrees[t];
  const lineOk = lines.every((i) => b.want[i] === NO_CLUE || diag.satisfied.has(i));
  const treeOk = trees.length > 0 && trees.every((id) => diag.satisfied.has(id));
  return lineOk && treeOk ? Palette.info : Palette.pencilStrong;
}

function drawClue(ctx, p, want, rad, diag, id) {
  if (want === NO_CLUE) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(1.5, rad * 0.3), 0, Math.PI * 2);
    ctx.fillStyle = Palette.inkFaint;
    ctx.fill();
    return;
  }
  const bad = diag.violated.has(id);
  const good = diag.satisfied.has(id);
  ctx.beginPath();
  ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
  ctx.fillStyle = Palette.bgTop;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, rad * 0.18);
  ctx.strokeStyle = bad ? Palette.error : good ? Palette.success : Palette.lineHeavy;
  ctx.stroke();
  ctx.font = `700 ${Math.round(rad * 1.3)}px ${Font.sans}`;
  ctx.fillStyle = bad ? Palette.error : good ? Palette.success : Palette.ink;
  ctx.fillText(String(want), p.x, p.y + 1);
}

// A trunk: a short stem and a canopy, drawn in the cell's own box. Trees are not ink, so this is
// the only mark on the board the player cannot place or remove.
function drawTree(ctx, r, cell, colour) {
  const cx = r.x + cell / 2;
  const base = r.y + cell * 0.78;
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1.8, cell * 0.07);
  ctx.lineCap = 'round';
  line(ctx, cx, base, cx, r.y + cell * 0.52);
  ctx.beginPath();
  ctx.arc(cx, r.y + cell * 0.38, cell * 0.21, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

// A tent: the two poles meeting at the apex with the ground line between them, plus the flap.
function drawTent(ctx, r, cell, colour) {
  const inset = cell * 0.18;
  const apex = { x: r.x + cell / 2, y: r.y + inset };
  const l = { x: r.x + inset, y: r.y + cell - inset };
  const rt = { x: r.x + cell - inset, y: r.y + cell - inset };
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(2.2, cell * Cell.lineScale);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(l.x, l.y);
  ctx.lineTo(apex.x, apex.y);
  ctx.lineTo(rt.x, rt.y);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = colour;
  ctx.globalAlpha = 0.16;
  ctx.fill();
  ctx.globalAlpha = 1;
  line(ctx, l.x, l.y, rt.x, rt.y);
  // The door: without it a small tent reads as a triangle of noise at 9×9.
  ctx.beginPath();
  ctx.moveTo(apex.x, apex.y + cell * 0.16);
  ctx.lineTo(apex.x - cell * 0.1, r.y + cell - inset);
  ctx.lineTo(apex.x + cell * 0.1, r.y + cell - inset);
  ctx.closePath();
  ctx.stroke();
  ctx.lineCap = 'butt';
}

function drawGrass(ctx, r, cell, colour) {
  ctx.beginPath();
  ctx.arc(r.x + cell / 2, r.y + cell / 2, Math.max(2, cell * 0.09), 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.fill();
}

function centreOf(r, cell) {
  return { x: r.x + cell / 2, y: r.y + cell / 2 };
}

function ring(ctx, p, rad, cell, colour) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1.5, cell * 0.05);
  ctx.stroke();
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
