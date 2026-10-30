// Wiring: DOM, pointer gestures, the clock, storage, and the `window.tents` surface the
// verification harness drives. No rule about the board lives here — every judgement comes from
// js/engine/tents.js through js/ui/game.js.

import { Palette, applyThemeVars, prefersReducedMotion, setReduceMotion, systemPrefersReducedMotion } from './theme.js';
import { Sound } from './audio/synth.js';
import { Store } from './store.js';
import { TIERS, tierFor, makePuzzle, generate, plant, pruneClues } from './engine/generate.js';
import { Cell } from './theme.js';
import * as Engine from './engine/tents.js';
import { countSolutions } from './engine/count.js';
import { BoardView } from './render/board.js';
import { Game, name, OPEN, TENT, GRASS } from './ui/game.js';

const VERSION = '1.0.0';

const $ = (sel) => document.querySelector(sel);
const el = {
  app: $('#app'),
  viewMenu: $('#view-menu'),
  viewGame: $('#view-game'),
  tiers: $('#tier-list'),
  records: $('#record-list'),
  resumeCard: $('#resume-card'),
  resumeName: $('#resume-name'),
  resumeMeta: $('#resume-meta'),
  name: $('#stat-name'),
  tier: $('#stat-tier'),
  time: $('#stat-time'),
  moves: $('#stat-moves'),
  hints: $('#stat-hints'),
  filled: $('#stat-filled'),
  remaining: $('#stat-remaining'),
  satisfied: $('#stat-satisfied'),
  conflicts: $('#stat-conflicts'),
  score: $('#stat-score'),
  hintRule: $('#hint-rule'),
  hintLine: $('#hint-line'),
  hintCount: $('#hint-count'),
  stateLine: $('#state-line'),
  winVeil: $('#win-veil'),
  winMeta: $('#win-meta'),
  winRecord: $('#win-record'),
  pauseVeil: $('#pause-veil'),
  howtoVeil: $('#howto-veil'),
  btnPause: $('#btn-pause'),
  btnFull: $('#btn-fullscreen'),
  wrap: $('#board-wrap'),
  canvas: $('#board'),
};

const view = new BoardView(el.canvas);
let game = null;
let stroke = null;
let startedAt = 0;
let baseElapsed = 0;
let ticker = 0;
let selectedTier = TIERS[0].key;

// The one animation clock. Everything that moves on the canvas is a pulse with an age, and the
// age advances by the frame's own dt — so a 30Hz machine and a 120Hz machine watch the same
// 1.6-second ring, not a ring that dies after a fixed number of frames.
const fx = { clock: 0, frames: 0, pulses: [], lastTime: 0, raf: 0 };

const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
const running = () => !!startedAt;

function addPulse(p) {
  fx.pulses.push({ age: 0, life: 1.6, ...p });
  draw();
}

// 重开/换一局要把动画时钟一起放下：fx.clock 与 fx.frames 都是"这一局跑了多久"的观测量，
// 只摘涟漪而留着时钟，下一局的年龄就从上一局的末值起步（帧率对拍读的正是它）。
// fx.lastTime 故意保留：归零会让恢复后的第一帧拿到跨局的巨大 dt。
function resetFx() {
  fx.clock = 0;
  fx.frames = 0;
  fx.pulses = [];
}

function fxTick(now) {
  fx.raf = requestAnimationFrame(fxTick);
  const last = fx.lastTime || now;
  fx.lastTime = now;
  // 暂停期间仿真一步都不推进：dt 被丢弃，累加器不涨，画布停在按下暂停那一帧的图上。
  if (paused) return;
  let dt = (now - last) / 1000;
  // 标签页回来之后的第一帧可以隔了几分钟，动画不许被它快进（也不许倒着走）。
  if (!(dt > 0)) return;
  if (dt > 0.25) dt = 0.25;
  fx.frames++;
  fx.clock += dt;
  if (!fx.pulses.length) return;
  for (const p of fx.pulses) p.age += dt;
  fx.pulses = fx.pulses.filter((p) => p.age < p.life);
  draw();
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function availBox() {
  const narrow = window.innerWidth <= 900;
  const w = narrow ? window.innerWidth - 60 : el.viewGame.clientWidth - 340;
  return { w: Math.max(240, w), h: Math.max(240, window.innerHeight - 250) };
}

function draw() {
  if (!game) return;
  const { w, h } = availBox();
  view.resize(game, w, h);
  view.draw(game, {
    pulses: fx.pulses,
    reduce: prefersReducedMotion(),
    preview: stroke && stroke.items.length ? { cells: stroke.items.map((i) => i.cell) } : null,
  });
}

// One place writes the readouts, so a stat can never be updated by half the file.
function syncStats() {
  if (!game) return;
  const st = game.state();
  el.name.textContent = `${st.name} · ${game.w}×${game.h}`;
  el.tier.textContent = tierFor(st.tier).name;
  el.tier.dataset.tier = st.tier;
  el.time.textContent = fmtMs(clock());
  el.moves.textContent = st.moves;
  el.hints.textContent = st.hints;
  el.hintCount.textContent = st.hints;
  el.filled.textContent = `${st.filled}/${st.total}`;
  el.remaining.textContent = st.remaining;
  el.satisfied.textContent = `${st.satisfied}/${st.clues}`;
  el.conflicts.textContent = st.conflicts;
  el.score.textContent = st.score.toFixed(1);
  el.conflicts.closest('.stat').classList.toggle('bad', st.conflicts > 0);
  el.remaining.closest('.stat').classList.toggle('bad', st.status !== 'won' && st.remaining > 0);
  el.satisfied.closest('.stat').classList.toggle('bad', st.status !== 'won' && st.conflicts > 0);
  el.stateLine.textContent = st.stuck
    ? '这些帐篷和数字已经矛盾了：不管剩下的格怎么放，都不可能让每棵树有帐、每个数字对上。撤销一步再想。'
    : st.conflicts
      ? `${st.conflicts} 处对不上：有的行凑不齐那个数，有的树旁已经没有地方扎营了。`
      : '';
}

function syncAll() {
  syncStats();
  draw();
}

function flushResume() {
  // A stroke in flight is only a preview: those cells carry marks that have not been committed and
  // that pointercancel rolls back, so writing them would put ink on the record the player never
  // placed. The gesture flushes for real when it commits (afterStep).
  if (!game || game.status === 'won' || stroke) return;
  Store.saveResume(game.puzzle, game.st.cell, clock(), { moves: game.moves, hints: game.hints });
}

function startClock() {
  paused = false;   // 新一局从"没暂停"开始；setPaused(false) 走的就是这条路
  startedAt = Date.now();
  clearInterval(ticker);
  ticker = setInterval(() => {
    el.time.textContent = fmtMs(clock());
    // Time is the one part of a run's cost that keeps passing with no action, and js/store.js only
    // holds what was last written: without this the record carries the clock of the *previous*
    // mark, and coming back to the board shows less 用时 than the player had just been shown.
    flushResume();
    if (fx.pulses.length) draw();
  }, 1000);
}

function stopClock() {
  baseElapsed = clock();
  startedAt = 0;
  clearInterval(ticker);
  ticker = 0;
  // Park the run's cost with the clock stopped, so the stored 用时 is the number that was on
  // screen when the board was left — on 回选档, on a win (guarded inside), and on any other exit.
  flushResume();
}

// ---- pause ---------------------------------------------------------------------
// Pausing stops two separate things that both count as "the game running": the run clock and the
// simulation clock. The board itself is untouched — no state is rebuilt on resume, the player just
// gets the same position back with the same 用时 they were shown.
function clearPausedUi() {
  el.pauseVeil.hidden = true;
  el.btnPause.setAttribute('aria-pressed', 'false');
  el.btnPause.textContent = '暂停';
  el.time.closest('.chip')?.classList.remove('paused');
}


// ---- restart the same board ----------------------------------------------------
// 换一局 makes a new puzzle; 重开 puts *this* one back on the table empty. Everything a run can
// accumulate has to be put down: the clock, the undo history, the ink, the hint cursor, the
// in-flight stroke, every animation pulse and the pause flag.

// ---- fullscreen / how-to -------------------------------------------------------
function fullscreenHost() {
  return el.app || document.documentElement;
}

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function toggleFullscreen(force) {
  const want = force === undefined ? !isFullscreen() : !!force;
  try {
    if (want && !isFullscreen()) {
      const host = fullscreenHost();
      const req = host.requestFullscreen || host.webkitRequestFullscreen;
      if (!req) return false;
      const out = req.call(host);
      if (out && typeof out.catch === 'function') out.catch(() => {});
    } else if (!want && isFullscreen()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) {
        const out = exit.call(document);
        if (out && typeof out.catch === 'function') out.catch(() => {});
      }
    }
  } catch {
    // 被权限策略拒绝（非用户手势、Electron 的老 webkit 前缀）只是没进全屏，按钮不该把游戏带崩
  }
  return isFullscreen();
}

function syncFullButton() {
  const on = isFullscreen();
  el.btnFull.setAttribute('aria-pressed', String(on));
  el.btnFull.textContent = on ? '退出全屏' : '全屏';
}

function setHowto(v) {
  const want = v === undefined ? el.howtoVeil.hidden : !!v;
  el.howtoVeil.hidden = !want;
  $('#btn-howto')?.setAttribute('aria-pressed', String(want));
  return want;
}

function setMode(mode) {
  if (!game || paused) return;
  game.mode = mode;
  $('#btn-mode-tent').setAttribute('aria-pressed', String(mode === TENT));
  $('#btn-mode-grass').setAttribute('aria-pressed', String(mode === GRASS));
  el.canvas.dataset.mode = mode === TENT ? 'tent' : 'grass';
  draw();
}

function showHint(info) {
  if (!info) return;
  if (info.stalled) {
    el.hintRule.textContent = '推不动了';
    el.hintLine.textContent = info.text;
    return;
  }
  if (info.conflict) {
    el.hintRule.textContent = '这里和数字矛盾';
    el.hintLine.textContent = info.conflict;
    addPulse({ cell: info.cell, color: 'rgba(255,92,122,0.9)', kind: 'conflict' });
    Sound.conflict();
    return;
  }
  el.hintRule.textContent = `规则：${info.rule}`;
  el.hintLine.textContent = info.why;
  addPulse({ cell: info.cell, line: info.line, tree: info.tree, tent: info.tent, kind: 'hint' });
  Sound.hint();
}

// A win is worth seeing, not just being told: every tent gets its own ring, staggered by the
// order they were placed, so the eye reads "these are the ones you worked out". The stagger is in
// seconds, and the ring's age is integrated from dt, so the wave looks the same at 30 and 120Hz.
function winWave() {
  if (prefersReducedMotion()) return;
  const tents = [];
  for (let t = 0; t < game.board.n; t++) if (game.st.cell[t] === TENT) tents.push(t);
  tents.slice(0, 40).forEach((cell, i) => {
    addPulse({ cell, kind: 'win', color: 'rgba(61,220,145,0.95)', delay: i * 0.045, life: 1.1 });
  });
}

function onWin() {
  stopClock();
  const ms = clock();
  const better = Store.recordBest(game.puzzle.tier, {
    ms,
    hints: game.hints,
    moves: game.moves,
    size: `${game.w}×${game.h}`,
  });
  Store.recordSolve(ms, game.hints);
  Store.clearResume();
  el.winMeta.textContent = `${tierFor(game.puzzle.tier).name} · ${game.w}×${game.h} · ${fmtMs(ms)} · ${game.moves} 步 · 提示 ${game.hints} 次`;
  el.winRecord.textContent = better ? '新纪录：这一局比存档里的更不求人。' : '未破纪录：同档先比提示次数。';
  el.winVeil.hidden = false;
  setPaused(false);
  Sound.win();
  winWave();
  renderRecords();
}

function afterStep(soundKey) {
  syncAll();
  if (game.status === 'won') onWin();
  else {
    flushResume();
    if (soundKey) Sound[soundKey]();
    if (game.stuck || game.diag.violated.size) Sound.conflict();
  }
}

function useHint() {
  if (!game || game.status === 'won' || paused) return null;
  const before = game.hints;
  const info = game.hint();
  if (!info) return null;
  // An unproductive hint is not a purchase: nothing was written, nothing is charged.
  if (info.stalled || info.conflict) {
    showHint(info);
    return info;
  }
  showHint(info);
  if (game.hints !== before) afterStep('place');
  return info;
}

function undo() {
  if (!game || paused) return null;
  const step = game.undo();
  if (!step) return null;
  fx.pulses = [];
  Sound.undo();
  syncAll();
  flushResume();
  return step;
}

function begin({ tier = 'trainee', seed = null, resume = null } = {}) {
  const origin = seed || `s${Math.floor(Math.random() * 1e9)}`;
  const puzzle = makePuzzle(origin, tier);
  if (!puzzle) return null;
  game = new Game(puzzle);
  paused = false;
  clearPausedUi();
  resetFx();
  stroke = null;
  el.winVeil.hidden = true;
  baseElapsed = 0;
  if (resume) {
    game.moves = resume.moves || 0;
    game.hints = resume.hints || 0;
    baseElapsed = resume.elapsedMs || 0;
    game.cursor = 0;
    game.load(resume.board);
  }
  setMode(TENT);
  show('game');
  startClock();
  el.hintRule.textContent = '提示理由';
  el.hintLine.textContent = '按 提示 会说出当前能推的一格，以及它依据哪条规则。';
  syncAll();
  flushResume();
  renderResumeCard();
  return game;
}

// 重开：**同一道题**从头再来 —— 落笔、撤销栈、步数、提示次数、提示游标、计时、结算遮罩
// 全部归零，但不换题。跟「换一局」的分工：换一局是重抽一道新题（那是"再来一局"），
// 这里是"这题我走错了，原地重来"——玩家要的是同一个题。
//
// 为什么不能只调一次 resetInk() 就完事：那一步只碰得到引擎的 st.cell 与 st.history，
// UI 层的撤销栈、步数、提示次数、提示游标都是各自独立存着的缓存（详见 Game.resetAll）。
function restart() {
  if (!game) return null;
  game.resetAll();               // 盘面 + steps + moves + hints + cursor + status + mode + lastHint
  pulse = null;                  // 上一条提示留下的高亮，属于上一局
  stroke = null;                 // 上一次没画完的拖拽手势
  el.winVeil.hidden = true;      // 结算遮罩收起：上一局赢了的遮罩不能压在重开后的盘上
  baseElapsed = 0;               // 耗时归零
  // 暂停中重开就保持停表，否则 startClock() 会把暂停期间憋下的墙钟一次性灌进计时。
  if (paused) {
    startedAt = 0;
    clearInterval(ticker);
    ticker = 0;
  } else {
    startClock();                // 没暂停就重新起跑，重开后的计时是这一局自己的
  }
  setMode(TENT);                 // 临时态：落笔模式回默认，HUD 的 aria-pressed 一起回写
  el.hintRule.textContent = '提示理由';
  el.hintLine.textContent = '按 提示 会说出当前能推的一格，以及它依据哪条规则。';
  show('game');
  syncAll();
  // 存档覆盖成本局的空盘：刷新页面不会又冒出走错那半局的线。
  // 特意**不**碰 Store 的偏好（静音 / 减动效 / 最好成绩）——那是玩家的东西，不是这一局的东西。
  flushResume();
  renderResumeCard();
  return game;
}

function show(which) {
  el.viewMenu.hidden = which !== 'menu';
  el.viewGame.hidden = which !== 'game';
  if (which === 'menu') {
    // 回选档就是离开这一局：暂停态跟着一起放下，否则再进关时按钮还写着"继续"。
    paused = false;
    clearPausedUi();
    stopClock();
    renderMenu();
  }
  if (which === 'game') draw();
  return which;
}

function renderMenu() {
  renderTiers();
  renderRecords();
  renderResumeCard();
}

const TIER_NOTE = {
  trainee: '树少数字全，一格一数就推得完',
  apprentice: '要开始数"还差几顶"和"这行满了"',
  regular: '数字稀了，得连着看几行几列',
  expert: '多出来的树只为让落点变少，全靠推',
  master: '盘大数少，一步看错整片对不上',
};

function renderTiers() {
  el.tiers.innerHTML = '';
  for (const t of TIERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier';
    b.dataset.tier = t.key;
    b.innerHTML =
      `<span class="tier-name">${t.name}</span>` +
      `<span class="tier-note">${TIER_NOTE[t.key] || ''}</span>` +
      `<span class="tier-size mono">${t.w}×${t.h} · 实测 ${t.band[0]}–${t.band[1]}</span>`;
    b.addEventListener('click', () => begin({ tier: t.key }));
    // 键盘选档：focus 记住这一档，Enter/Space 才开得出局（原生按钮被 focus 时自己会响应，
    // 所以 keydown 那条只在没有按钮持有焦点时才兜底开局）。
    b.addEventListener('focus', () => { selectedTier = t.key; });
    el.tiers.appendChild(b);
  }
}

function renderRecords() {
  el.records.innerHTML = '';
  for (const t of TIERS) {
    const li = document.createElement('li');
    const best = Store.best(t.key);
    li.dataset.tier = t.key;
    li.innerHTML =
      `<b>${t.name}</b>` +
      (best
        ? `<span class="mono">${fmtMs(best.ms)}</span> · 提示 ${best.hints} · ${best.moves} 步<br><span>${best.size}</span>`
        : '<span>还没有纪录</span>');
    el.records.appendChild(li);
  }
}

function renderResumeCard() {
  const r = Store.resume();
  // Do not offer "继续" for the board already on screen.
  const live = game && game.status !== 'won' && running();
  if (!r || (live && r.seed === game.puzzle.originSeed && r.tier === game.puzzle.tier)) {
    el.resumeCard.hidden = true;
    return;
  }
  el.resumeCard.hidden = false;
  el.resumeName.textContent = `继续 ${tierFor(r.tier).name} 的一局`;
  el.resumeMeta.textContent = `${fmtMs(r.elapsedMs || 0)} · ${r.moves || 0} 步 · 提示 ${r.hints || 0} 次`;
}

function applySettings() {
  Sound.setEnabled(Store.setting('sound'));
  const reduce = !!Store.setting('reduceMotion') || systemPrefersReducedMotion();
  setReduceMotion(!!Store.setting('reduceMotion'));
  document.body.classList.toggle('reduce-motion', reduce);
  $('#btn-sound').setAttribute('aria-pressed', String(!!Store.setting('sound')));
  $('#btn-sound').textContent = Store.setting('sound') ? '音效 开' : '音效 关';
  $('#btn-motion').setAttribute('aria-pressed', String(!!Store.setting('reduceMotion')));
  $('#btn-motion').textContent = reduce ? '动效 省' : '动效 全';
  if (fx.pulses.length && reduce) fx.pulses = [];  // 省动效就把已经亮着的涟漪摘掉，盘面退回静图
}

function toggleMute() {
  Store.setSetting('sound', !Store.setting('sound'));
  applySettings();
  if (Store.setting('sound')) Sound.place();
  return Store.setting('sound');
}

// ---- pointer gestures: down decides the value for the whole stroke, up commits one step ------

// During a drag the cells are painted ahead of the commit so the picture follows the finger.
// Each preview remembers the state the cell had *before* the gesture, because the committed step
// has to record that as its undo target — restoring to OPEN instead would quietly eat the mark an
// erase gesture was about to remove.
function preview(t, value) {
  if (game.board.tree[t]) return;
  stroke.items.push({ cell: t, from: game.st.cell[t] });
  game.st.cell[t] = value;
  game.recompute();
}

function unpreview() {
  for (const it of stroke.items) game.st.cell[it.cell] = it.from;
  game.recompute();
}

function strokeStart(ev) {
  if (!game || game.status === 'won' || paused) return;
  const t = view.hitCell(ev.clientX, ev.clientY);
  if (t < 0 || game.board.tree[t]) return;
  ev.preventDefault();
  el.canvas.setPointerCapture?.(ev.pointerId);
  stroke = { items: [] };
  // Starting on a mark that is already this one makes the whole gesture an eraser.
  const value = game.st.cell[t] === game.mode ? OPEN : game.mode;
  stroke.value = value;
  preview(t, value);
  draw();
}

function strokeMove(ev) {
  if (!stroke || !game) return;
  const t = view.hitCell(ev.clientX, ev.clientY);
  if (t < 0 || game.board.tree[t]) return;
  if (stroke.items.some((it) => it.cell === t) || game.st.cell[t] === stroke.value) return;
  preview(t, stroke.value);
  draw();
}

function strokeEnd() {
  if (!stroke || !game) return null;
  const s = stroke;
  const cells = s.items.map((it) => it.cell);
  unpreview();
  stroke = null;
  if (!cells.length) return null;
  const step = game.stroke(cells, s.value);
  if (!step) {
    syncAll();
    return null;
  }
  afterStep(s.value === OPEN ? 'rub' : 'place');
  return step;
}

function cancelStroke() {
  if (!stroke) return;
  unpreview();
  stroke = null;
  syncAll();
}

// pointerdown 是主路（一支笔同时管手指、鼠标和触控笔）。老 Safari 与没有 PointerEvent 的
// 环境回落到 touchstart/mousedown，坐标一律走 clientX/clientY —— hitCell 用
// getBoundingClientRect 换算，所以 CSS 缩放过的画布上"点 A 打 B"不会发生。
const hasPointer = typeof window !== 'undefined' && 'PointerEvent' in window;

function touchPoint(ev) {
  const p = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || ev;
  return { clientX: p.clientX, clientY: p.clientY, pointerId: 0, preventDefault: () => ev.preventDefault() };
}

if (hasPointer) {
  el.canvas.addEventListener('pointerdown', strokeStart);
  el.canvas.addEventListener('pointermove', strokeMove);
  el.canvas.addEventListener('pointerup', strokeEnd);
  el.canvas.addEventListener('pointercancel', cancelStroke);
} else {
  el.canvas.addEventListener('touchstart', (ev) => strokeStart(touchPoint(ev)), { passive: false });
  el.canvas.addEventListener('touchmove', (ev) => strokeMove(touchPoint(ev)), { passive: false });
  el.canvas.addEventListener('touchend', strokeEnd);
  el.canvas.addEventListener('touchcancel', cancelStroke);
  el.canvas.addEventListener('mousedown', (ev) => {
    if (ev.button) return;
    strokeStart(ev);
    window.addEventListener('mouseup', strokeEnd, { once: true });
  });
}
el.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

$('#btn-mode-tent').addEventListener('click', () => setMode(TENT));
$('#btn-mode-grass').addEventListener('click', () => setMode(GRASS));
$('#btn-hint').addEventListener('click', useHint);
$('#btn-undo').addEventListener('click', undo);
$('#btn-restart').addEventListener('click', restart);
$('#btn-new').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'trainee' }));
$('#btn-restart').addEventListener('click', restart);
$('#btn-pause').addEventListener('click', () => setPaused(!paused));
$('#btn-resume-run').addEventListener('click', () => setPaused(false));
$('#btn-howto')?.addEventListener('click', () => setHowto());
$('#btn-howto-close').addEventListener('click', () => setHowto(false));
$('#btn-menu').addEventListener('click', () => {
  flushResume();
  show('menu');
});
$('#btn-menu-2').addEventListener('click', () => show('menu'));
$('#btn-again').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'trainee' }));
$('#btn-resume').addEventListener('click', () => {
  const r = Store.resume();
  if (!r) return;
  begin({ tier: r.tier, seed: r.seed, resume: r });
});
$('#btn-sound').addEventListener('click', () => {
  toggleMute();
  $('#btn-sound').blur();
});
$('#btn-motion').addEventListener('click', () => {
  Store.setSetting('reduceMotion', !Store.setting('reduceMotion'));
  applySettings();
});
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  applySettings();
  game = null;
  show('menu');
});

// 键盘全覆盖。M 在这盘游戏里是"换笔"，而且 516 项浏览器断言押着它（tools/scenarios.js
// `play` 场景），所以静音让给 Shift+M —— 全屏 F、暂停 P、重开 R、玩法 ?、开始 Enter/Space
// 都是新增键位，不与任何既有键冲突。
function startFromMenu() {
  if (el.viewMenu.hidden) return false;
  begin({ tier: selectedTier });
  return true;
}

window.addEventListener('keydown', (ev) => {
  if (ev.target && /input|textarea/i.test(ev.target.tagName)) return;
  const k = ev.key.toLowerCase();
  if (k === '?') {
    ev.preventDefault();
    setHowto();
    return;
  }
  if (k === 'escape' && !el.howtoVeil.hidden) {
    setHowto(false);
    return;
  }
  if (k === 'h') useHint();
  else if (k === 'z') undo();
  else if (k === 't') setMode(TENT);
  else if (k === 'g') setMode(GRASS);
  else if (k === 'm' && game) setMode(game.mode === TENT ? GRASS : TENT);
  // R 重开同一题，**局中就能按**（不只结算后）：玩家涂到一半发现支错了，当场 R 一下重来。
  // 本仓原先没有任何键占着 R（h/z 是玩法，t/g/m 切模式，P 暂停），所以不需要换键。
  else if (k === 'r' && game) restart();
});

window.addEventListener('resize', draw);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushResume();
});
window.addEventListener('pagehide', flushResume);
document.addEventListener('fullscreenchange', syncFullButton);
document.addEventListener('webkitfullscreenchange', syncFullButton);

// PWA 快捷方式带参数进来（?tier=regular / ?action=resume）就照参数开局，不让人白点一下图标。
function applyLaunchParams() {
  let q;
  try {
    q = new URLSearchParams((typeof location !== 'undefined' && location.search) || '');
  } catch {
    return null;
  }
  const tier = q.get('tier');
  if (tier && TIERS.some((t) => t.key === tier)) return begin({ tier });
  if (q.get('action') === 'resume') {
    const r = Store.resume();
    if (r) return begin({ tier: r.tier, seed: r.seed, resume: r });
  }
  return null;
}

applyThemeVars();
applySettings();
renderMenu();
syncFullButton();
fx.raf = requestAnimationFrame(fxTick);
applyLaunchParams();

window.tents = {
  version: VERSION,
  view,
  get game() {
    return game;
  },
  show,
  begin,
  restart,
  useHint,
  undo,
  setMode,
  restart,
  pause: () => setPaused(true),
  resume: () => setPaused(false),
  togglePause: () => setPaused(!paused),
  paused: () => paused,
  toggleMute,
  fullscreen: toggleFullscreen,
  howto: setHowto,
  sound: () => Sound.inspect(),
  // 动画态：harness 用它按 30/60/120Hz 对拍同一虚拟时长（clock 只由 dt 积分而来）。
  fx: () => ({
    clock: fx.clock,
    frames: fx.frames,
    pulses: fx.pulses.length,
    ages: fx.pulses.map((p) => Math.round(p.age * 1e6) / 1e6),
    // 画师拿到的三个量：探针据此重建 alpha（(age-delay)/life 的同一条曲线），比裸 age 更贴近"玩家看见什么"。
    pulsesDetail: fx.pulses.map((p) => ({ age: p.age, life: p.life, delay: p.delay || 0, kind: p.kind })),
    paused,
    reduce: prefersReducedMotion(),
    elapsedMs: clock(),
  }),
  store: () => ({ dropped: Store.dropped.slice(), best: Object.keys(Store.data.best).sort(), resume: !!Store.data.resume, totals: { ...Store.data.totals }, settings: { ...Store.data.settings } }),
  reloadStore: () => Store.reload(),
  // The harness commits through the same path a pointer release does, so a scenario that passes
  // here has driven the real state machine rather than a copy of it.
  stroke(cells, value) {
    if (!game || paused) return null;
    const step = game.stroke(cells, value === undefined ? game.mode : value);
    if (step) afterStep(step.value === OPEN ? 'rub' : 'place');
    return step;
  },
  tap(t, mode) {
    if (!game || paused) return null;
    const step = mode === undefined ? game.tap(t) : game.tap(t, mode);
    if (step) afterStep(step.writes[0].to === OPEN ? 'rub' : 'place');
    return step;
  },
  solveWithLogic() {
    if (!game) return null;
    const r = game.solveWithLogic();
    syncAll();
    if (game.status === 'won') onWin();
    return r;
  },
  elapsed: clock,
  state: () => (game ? { ...game.state(), elapsedMs: clock(), paused } : null),
  cellAt: (x, y) => (game ? game.cellAt(x, y) : -1),
  valueOf: (t) => (game ? game.valueOf(t) : OPEN),
  markName: name,
  fxTick,
  engine: {
    ...Engine,
    makePuzzle,
    generate,
    plant,
    pruneClues,
    countSolutions,
    TIERS,
    tierFor,
    Game,
    Store,
    theme: { ...Palette, Cell },
    OPEN,
    TENT,
    GRASS,
  },
};

// ---- 全屏开关（#btn-fullscreen）----
// 绑的是本页 HUD 上真实存在的那个按钮。全屏最常见的假实现就是引用一个并不存在的
// id：点下去什么也不会发生，量具却算它"已实现"。所以这里找不到按钮就直接不装。
(function bindFullscreen() {
  const btn = document.getElementById('btn-fullscreen');
  if (!btn) return;
  const root = document.documentElement;
  // 只做特性检测，不嗅探 UA：iOS Safari 是 webkitRequestFullscreen，老 Edge 是 ms 前缀，
  // 而 UA 字符串随时会改。"有没有这个能力"是查出来的，不是猜出来的。
  const req = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement
    || document.msFullscreenElement || null;

  // 不支持也要给个说法：只把按钮灰掉而不解释，玩家会以为这功能没做完。
  // supported 这枚标记不能省：下面 sync() 每次都会重写 title，不挡住的话，装的时候刚写
  // 进去的人话原因会被随后的 sync() 立刻抹成"全屏 (F)"——禁用就变成一句没有理由的禁用。
  let supported = !!req;
  const unsupported = () => {
    supported = false;
    btn.disabled = true;
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」独立打开）';
  };
  if (!req) unsupported();

  // fullscreen 返回 Promise，被拒时必须吃掉：iOS Safari 对多数非 video 元素直接拒绝，
  // 让这个 rejection 冒泡出去会变成一条未捕获错误，整局游戏跟着挂。
  const settle = (p) => { if (p && p.catch) p.catch(unsupported); };

  // 进出都能走：已经全屏时这次调用是退出，不是"再进一次"。
  function toggle() {
    try {
      if (current()) {
        if (exit) settle(exit.call(document));
      } else if (req) {
        settle(req.call(root));
      } else {
        unsupported();
      }
    } catch (e) {
      unsupported();
    }
  }

  // Esc 和系统手势退出都不经过我们的代码，按钮状态只能靠 fullscreenchange 回写，
  // 否则用户已经退出、HUD 还停在"退出全屏"，下一次点击反而会重新进全屏。
  function sync() {
    const on = !!current();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    if (supported) btn.title = "全屏" + '（F）';
    const body = document.body;
    if (body && body.classList) body.classList.toggle('fullscreen', on);
  }

  btn.addEventListener('click', toggle);
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'f' && ev.key !== 'F') return;
    const t = ev.target;
    // 盘号 / 种子这类输入框里打字不能触发全屏，否则玩家输 seed 输到一半屏幕没了。
    if (t && /input|textarea|select/i.test(t.tagName || '')) return;
    if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    ev.preventDefault();
    toggle();
  });
  window.addEventListener('fullscreenchange', sync);
  window.addEventListener('webkitfullscreenchange', sync);
  window.addEventListener('MSFullscreenChange', sync);
  sync();
})();

// ---- 暂停：真的把仿真冻住 ----
//
// 本仓唯一持续推进的仿真是耗时时钟（startedAt 跟 Date.now 走，ticker 是它唯一心跳）。
// setPaused(true) 调 stopClock()：baseElapsed 落账、startedAt 归 0、ticker 停，
// 此后 clock() 恒等于 baseElapsed，墙钟再走多久都加不上去。
// setPaused(false) 调 startClock()：startedAt 复位成"从现在起"，
// 所以恢复后的第一帧不会把暂停期间憋下的墙钟一次性灌进来（没有 dt 尖峰）。
//
// 用 var 而不是 let：本块在文件末尾，而 startClock() 可能在它之前就被 begin() 调过；
// let 声明提升不到初始化，TDZ 会直接抛 ReferenceError。
var paused = false;
function setPaused(v) {
  v = !!v;
  if (v === paused) return paused;
  if (v) stopClock(); else startClock();
  paused = v;
  var b = document.getElementById('btn-pause');
  if (b) {
    b.setAttribute('aria-pressed', String(paused));
    b.textContent = paused ? '继续' : '暂停';
    b.title = paused ? '继续 (P)' : '暂停 (P)';
  }
  return paused;
}
function togglePause() { return setPaused(!paused); }
function isPaused() { return paused; }

document.getElementById('btn-pause').addEventListener('click', togglePause);
window.addEventListener('keydown', function (ev) {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target && /input|textarea|select/i.test(ev.target.tagName)) return;
  var k = ev.key;
  if (k === 'p' || k === 'P' || k === ' ') { ev.preventDefault(); togglePause(); }
});
