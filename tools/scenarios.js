// Browser-side scenario suite, injected by tools/playtest.cjs and run against the real page.
//
// The rule for anything asserted here: read the DOM, the geometry and the canvas pixels, not a
// flag. A `.hidden` boolean says what the code intended; a client rect and a pixel say what the
// player got. The interesting failures in this game are exactly the ones where the state is right
// and the picture or the click is wrong — a tent the engine is happy with but the canvas paints in
// the wrong colour, a row whose number reads satisfied while its disc is still grey, a cell you
// can see but cannot hit.
//
// window.tents.engine is the shipped module graph, so a scenario that passes here has passed on
// the same solver the player's hints come from — not a second copy kept for testing.
//
// ck(name, condition, detail) is truthiness; eq(name, got, want) is equality. Mixing them up is
// how `ck('count', 0)` reads as a failure to a human and a pass to a boolean — every "must equal"
// below therefore goes through eq.
//
// Every gesture that a finger could make is dispatched as a real PointerEvent. `pointerId: 1` is
// not decoration: strokeStart() hands the id to setPointerCapture(), and Chrome only knows the
// virtual mouse by that id — with any other id the capture call throws NotFoundError inside the
// listener and the gesture dies before it records anything. That failure mode is worth naming out
// loud, because it means the drag assertions below really do go through the pointer handler.

((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
  const report = (extra) => {
    // rows is copied, not aliased: the array is cleared below, and a live reference would hand
    // back an empty report that still reads as "0 failed".
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const throws = (fn) => {
    try {
      fn();
      return '';
    } catch (e) {
      return e.message;
    }
  };

  const A = () => w.tents;
  const E = () => w.tents.engine;
  const $ = (sel) => document.querySelector(sel);
  const text = (sel) => (($.call(document, sel) || {}).textContent || '').trim();
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const shown = (sel) => {
    const e = $(sel);
    if (!e) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };

  // ---- the real gestures ------------------------------------------------------

  const box = () => A().view.canvas.getBoundingClientRect();
  const clientOf = (t, fx = 0.5, fy = 0.5) => {
    const r = A().view.cellRect(t);
    const b = box();
    return { x: b.left + r.x + r.size * fx, y: b.top + r.y + r.size * fy };
  };
  function pointer(type, x, y) {
    const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: x, clientY: y });
    A().view.canvas.dispatchEvent(ev);
    return ev;
  }
  async function tap(t, fx = 0.5, fy = 0.5) {
    const p = clientOf(t, fx, fy);
    pointer('pointerdown', p.x, p.y);
    pointer('pointerup', p.x, p.y);
    return wait(30);
  }
  // A drag that actually travels: every cell the segment passes over is a cell the finger saw.
  async function drag(from, to) {
    const a = clientOf(from);
    const b = clientOf(to);
    const size = A().view.geo.cell;
    const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (size / 4)));
    pointer('pointerdown', a.x, a.y);
    for (let i = 1; i <= steps; i++) {
      pointer('pointermove', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
    }
    return { steps, move: (x, y) => pointer('pointermove', x, y), up: () => pointer('pointerup', b.x, b.y), end: { x: b.x, y: b.y } };
  }

  // ---- colours, read off the canvas ------------------------------------------
  //
  // The literals below are hand-copied from js/theme.js, and `cssVar` ties them back to what the
  // page is actually wearing: change one token without the other and both halves of the pair
  // complain. `pixel()` takes canvas-local CSS pixels (getImageData works in the backing buffer,
  // which is why every call multiplies by dpr itself).

  const PAPER = [19, 26, 46]; // --bg-bottom: an undecided cell
  const LIFT = [24, 32, 54]; // --surface-lift: a cell that has settled
  const TRUNK_GROUND = [8, 11, 22]; // --bg-top: the ground a tree stands on
  const BLUE = [123, 184, 255]; // --info: a tent with every number beside it content
  const GREY = [143, 166, 204]; // --pencil-strong: a tent with work still outstanding
  const RED = [255, 92, 122]; // --error
  const GREEN = [61, 220, 145]; // --success
  const RING = [58, 74, 114]; // --line-heavy: a number nothing has been decided about yet

  const hex = (h) => {
    const m = String(h).replace('#', '');
    return m.length < 6 ? [-1, -1, -1] : [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  };
  const near = (p, c, tol = 8) => p.length === 3 && p.every((v, i) => Math.abs(v - c[i]) <= tol);
  const dist = (p, c) => Math.max(...p.map((v, i) => Math.abs(v - c[i])));
  function pixel(x, y) {
    const v = A().view;
    const d = v.geo.dpr;
    const p = v.ctx.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data;
    return [p[0], p[1], p[2]];
  }
  // A point inside one cell, in fractions of its side.
  const cellPixel = (t, fx = 0.5, fy = 0.5) => {
    const r = A().view.cellRect(t);
    return pixel(r.x + r.size * fx, r.y + r.size * fy);
  };
  // The tent glyph is a triangle standing on a ground line at 0.82 of the cell: sampling on that
  // line reads the stroke's colour whatever the cell size, which the apex (a join) does not.
  const tentPixel = (t) => cellPixel(t, 0.5, 0.82);
  // A grass mark is a dot at the cell's centre; the paper beside it is the cell's own background.
  const grassPixel = (t) => cellPixel(t, 0.5, 0.5);
  const grassCorner = (t) => cellPixel(t, 0.5, 0.3);
  // A number's disc: the glyph at its centre, the ring at exactly its radius.
  function cluePixel(id, which = 'glyph') {
    const g = A().view;
    const b = g.game.board;
    const p = id < b.h ? g.rowPoint(id) : g.colPoint(id - b.h);
    const rad = Math.min(14, g.geo.cell * E().theme.Cell.nodeScale);
    return which === 'glyph' ? pixel(p.x, p.y) : pixel(p.x + rad, p.y);
  }
  // Red anywhere on the board is a fact about the picture, so it has to be counted, not assumed.
  function redInkCells() {
    const g = A().game;
    const out = [];
    for (let t = 0; t < g.board.n; t++) {
      if (g.board.tree[t] || g.valueOf(t) === E().OPEN) continue;
      const p = g.valueOf(t) === E().TENT ? tentPixel(t) : grassPixel(t);
      if (near(p, RED, 14)) out.push(t);
    }
    return out;
  }

  // ---- the board's own vocabulary, re-derived from the rules ------------------
  // These readers deliberately do not call the engine: they exist so a hint's sentence can be
  // checked against the board instead of against the code that wrote the sentence.

  const W = () => A().game.board.w;
  const at = (t) => [(t / W()) | 0, t % W()];
  const orthoOf = (t) => {
    const b = A().game.board;
    const [r, c] = at(t);
    const out = [];
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= b.h || nc >= b.w) continue;
      out.push(nr * b.w + nc);
    }
    return out;
  };
  const ringOf = (t) => {
    const b = A().game.board;
    const [r, c] = at(t);
    const out = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= b.h || nc >= b.w) continue;
      out.push(nr * b.w + nc);
    }
    return out;
  };
  const treeBeside = (t) => orthoOf(t).some((s) => A().game.board.tree[s] === 1);
  // tents / open cells of one numbered line, read off `board.lines` but counted by hand.
  const lineCount = (ink, id) => {
    const b = A().game.board;
    let tents = 0;
    let open = 0;
    for (const t of b.lines[id]) {
      if (ink[t] === 1) tents++;
      else if (ink[t] === 0) open++;
    }
    return { tents, open, want: b.want[id] };
  };
  const copyInk = () => Int8Array.from(A().game.st.cell);
  const tentsOf = (arr) => Array.from(arr).map((v, i) => (v === 1 ? i : -1)).filter((i) => i >= 0);

  // The save format, re-implemented from the comment in js/store.js: a run is written as a
  // [value, length] pair. Comparing this against what the Store actually wrote is what keeps that
  // comment honest.
  const rle = (arr) => {
    const out = [];
    let run = arr[0] || 0;
    let n = 1;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] === run && n < 255) n++;
      else {
        out.push(run, n);
        run = arr[i];
        n = 1;
      }
    }
    out.push(run, n);
    return out;
  };
  const bytes = (x) => JSON.stringify(x).length;

  // A page boot re-reads one key and takes it as its whole state (that is all js/store.js does).
  // Doing it here is how the resume scenarios cross a real storage boundary without the in-memory
  // Store, the live game or the clock left over from the run that wrote the record.
  const reopen = () => {
    E().Store.data = JSON.parse(localStorage.getItem('tents.save.v1'));
    return E().Store.data;
  };

  // ---------- engine ----------

  const engine = async () => {
    const en = E();
    ck('页面挂出了可测的引擎', !!(en && en.createBoard && en.solve && en.countSolutions));
    eq('记号的三个状态', `${en.OPEN},${en.TENT},${en.GRASS}`, '0,1,2');
    eq('没有数字的哨兵是 -1', en.NO_CLUE, -1);
    // The smallest board the shape check will accept: one column, two rows, the upper cell a
    // trunk. rowClue is per row (h of them) and colClue per column (w of them) — feeding them the
    // other way round is the first way a hand-written board dies.
    eq('树格不吃墨，setCell 拒绝它', (() => {
      const b = en.createBoard({ w: 1, h: 2, tree: Uint8Array.from([1, 0]), rowClue: Int8Array.from([0, 0]), colClue: Int8Array.from([1]) });
      const st = en.createState(b);
      return `${en.setCell(st, 0, en.TENT)}/${st.cell[0]}`;
    })(), 'false/0');
    eq('规则表里有五条', Object.keys(en.Rules).length, 5);
    eq('五条规则的名字（手抄）', Object.values(en.Rules).map((r) => r.name).join(','), '无树不扎营,一帐八周空,行列封顶,只差这些,树唯一落点');
    eq('档位有五级', en.TIERS.length, 5);
    let ordered = true;
    for (let i = 1; i < en.TIERS.length; i++) {
      if (!(en.TIERS[i].band[0] > en.TIERS[i - 1].band[0])) ordered = false;
      if (!(en.TIERS[i].w > en.TIERS[i - 1].w)) ordered = false;
    }
    ck('档位按难度与尺寸同时递增', ordered, JSON.stringify(en.TIERS.map((t) => [t.w, t.band])));
    eq('档位不认识时退回上手', en.tierFor('nope').key, 'apprentice');

    // The 5×5 every Node assertion is derived from, rebuilt here from the same hand-drawn rows so
    // the browser proves it computes the same paper answer as `node tools/engine-test.mjs` does.
    const HAND = ['.T...', '...T.', '..T..', 'T....', '...T.'];
    const treeOf = (rws) => {
      const w = rws[0].length;
      const t = new Uint8Array(w * rws.length);
      rws.forEach((line, r) => [...line].forEach((ch, c) => {
        if (ch === 'T') t[r * w + c] = 1;
      }));
      return t;
    };
    const hand = en.createBoard({ w: 5, h: 5, tree: treeOf(HAND), rowClue: Int8Array.from([1, 1, 1, 0, 2]), colClue: Int8Array.from([2, 1, 0, 0, 2]) });
    eq('手推盘树占 5 格，可下墨 20 格', `${hand.trees.length}/${hand.total}`, '5/20');
    eq('能扎营的格子（手推）', [...Array(25).keys()].filter((t) => hand.spot[t]).join(','), '0,2,3,6,7,9,10,11,13,16,17,18,20,22,24');
    eq('格名用人话', hand.cellName(12), '第3行3列');
    eq('线名用人话', [hand.lineName(3), hand.lineName(8)].join(' '), '第4行 第4列');
    eq('写着 0 的行仍然是 0，不是没有数字', `${hand.want[hand.rowId(3)]}/${en.NO_CLUE}`, '0/-1');
    const hs = en.solve(hand);
    eq('手推盘能用铅笔推完', hs.ok, true);
    eq('手推盘的推理步数', hs.steps, 20);
    eq('手推盘的分数', hs.score, 22);
    eq('每条规则用了几次（手推）', JSON.stringify(hs.breakdown), JSON.stringify({ 无树不扎营: 5, 行列封顶: 8, 只差这些: 4, 树唯一落点: 1, 一帐八周空: 2 }));
    eq('手推盘穷举唯一', en.countSolutions(hand, { cap: 2, budget: 60000 }).status, 'UNIQUE');
    // Two typos the board must refuse out loud rather than solve into nonsense.
    ck('行数字超过能放的帐篷时拒绝开局', /第1行 写着 9，可它最多只能放 3 顶帐篷/.test(throws(() => en.createBoard({ w: 5, h: 5, tree: treeOf(HAND), rowClue: Int8Array.from([9, 1, 1, 0, 2]), colClue: Int8Array.from([2, 1, 0, 0, 2])}))), throws(() => en.createBoard({ w: 5, h: 5, tree: treeOf(HAND), rowClue: Int8Array.from([9, 1, 1, 0, 2]), colClue: Int8Array.from([2, 1, 0, 0, 2])})));
    eq('盘上没有数字就拒绝开局', /盘上没有数字/.test(throws(() => en.createBoard({ w: 2, h: 2, tree: Uint8Array.from([1, 0, 0, 0]), rowClue: Int8Array.from([-1, -1]), colClue: Int8Array.from([-1, -1]) }))), true);
    eq('0 是题面不是「没有题」：全 0 的盘无解', en.countSolutions(en.createBoard({ w: 2, h: 2, tree: Uint8Array.from([1, 0, 0, 0]), rowClue: Int8Array.from([0, 0]), colClue: Int8Array.from([0, 0]) })).status, 'NONE');

    // The live board: what the player is actually being handed.
    A().begin({ tier: 'regular', seed: 'scen|engine' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    eq('出货盘面尺寸就是档位', `${b.w}×${b.h}`, '7×7');
    eq('格数', b.n, 49);
    eq('出货盘的数字少于行列总条数', b.clues < b.h + b.w, true);
    ck('每个数字都在它数得出的范围里', Array.from(b.want).every((v) => v === -1 || (v >= 0 && v <= b.lines[b.rowId(0)].length)), JSON.stringify(Array.from(b.want)));
    ck('每棵树都还有格子可扎营', b.treeSpots.every((s) => s.length > 0), JSON.stringify(b.treeSpots));
    ck('树格自己不算营位', b.tree.every((v, t) => !v || !b.spot[t]), true);
    const s = en.solve(b);
    ck('铅笔推到底', s.ok === true, s.conflict || '');
    eq('推出来的盘通过独立验收', en.verify(b, s.derived).length, 0);
    eq('推出来即完整', en.complete(b, s.derived), true);
    eq('铅笔放的帐篷就是出题时种下的那些', tentsOf(s.derived).join(','), tentsOf(g.puzzle.solution).join(','));
    const c = en.countSolutions(b, { cap: 2, budget: 600000 });
    eq('穷举计数判定唯一', c.status, 'UNIQUE');
    eq('穷举与铅笔逐格同解', Array.from(c.first).join(','), Array.from(s.derived).join(','));
    eq('空盘不判胜', en.complete(b, new Int8Array(b.n)), false);
    eq('空盘没有冲突', en.diagnose(b, new Int8Array(b.n)).conflicts, 0);
    const grassAll = new Int8Array(b.n).fill(en.GRASS);
    eq('铺满草地也不判胜', en.complete(b, grassAll), false);
    ck('铺满草地时树在挨饿', en.verify(b, grassAll).some((x) => x.why === '树旁没帐'), JSON.stringify(en.verify(b, grassAll).slice(0, 2)));
    const pulled = Int8Array.from(s.derived);
    const aTent = tentsOf(pulled)[0];
    pulled[aTent] = en.GRASS;
    ck('撤掉一顶帐篷必有数字对不上', en.verify(b, pulled).some((x) => x.why === '帐篷不够'), JSON.stringify(en.verify(b, pulled).slice(0, 2)));
    const misplaced = Int8Array.from(s.derived);
    const nonSpot = [...Array(b.n).keys()].find((t) => !b.tree[t] && !b.spot[t]);
    misplaced[aTent] = en.GRASS;
    misplaced[nonSpot] = en.TENT;
    ck('把帐篷挪到没有树的格上，验收器当场看出', en.verify(b, misplaced).some((x) => x.why === '这里没有树可配'), JSON.stringify(en.verify(b, misplaced).slice(0, 2)));
    eq('没有树的格在提示脚本里被写成草地', s.rows.find((r) => r.cell === nonSpot).rule.name, '无树不扎营');
    const d0 = s.rows[0];
    ck('推导脚本的每条都带规则与格', !!(d0.rule && d0.cell >= 0 && d0.value), JSON.stringify({ rule: d0.rule && d0.rule.name, cell: d0.cell }));
    ck('规则文本带坐标', /第\d+行\d+列|第\d+行|第\d+列/.test(d0.rule.text(b, d0)), d0.rule.text(b, d0));

    // A rule that never fires would make the menu's 「五条规则」 a lie, so count them over a
    // whole day of shipped boards rather than trusting the table.
    const fired = {};
    for (const tier of en.TIERS) {
      for (let k = 0; k < 3; k++) {
        const p = en.makePuzzle(`scen|engine|${tier.key}|${k}`, tier.key);
        if (!p) continue;
        for (const r of en.solve(p.board).rows) fired[r.rule.name] = (fired[r.rule.name] || 0) + 1;
      }
    }
    eq('五条规则在出货盘上都真的会用到', Object.keys(fired).length, 5);
    return report({ score: g.puzzle.score, clues: b.clues, steps: s.steps, fired });
  };

  // ---------- gen ----------

  const gen = async () => {
    const en = E();
    A().show('menu');
    await wait(40);
    const btns = [...document.querySelectorAll('#tier-list .tier')];
    eq('选档页列出五档', btns.length, 5);
    eq('五档的名字（手抄）', btns.map((x) => x.textContent.replace(/\s+/g, '')).map((x) => x.slice(0, 2)).join(','), '初学,上手,熟练,高阶,大师');
    ck('每档都写着自己的尺寸', btns.every((x) => /\d+×\d+/.test(x.textContent)), btns.map((x) => x.textContent.replace(/\s+/g, ' ')).join(' | '));
    ck('每档都写着实测分数带', btns.every((x) => /实测 \d+–\d+/.test(x.textContent)), btns[0].textContent);
    eq('五档尺寸一档比一档大', btns.map((x) => /(\d+)×(\d+)/.exec(x.querySelector('.tier-size').textContent)[1]).join(','), '5,6,7,8,9');

    // begin({tier}) is the path a finger takes from the menu: the button hands the key over and
    // nothing else.
    const medians = [];
    for (const tier of en.TIERS) {
      const opened = A().begin({ tier: tier.key });
      await wait(30);
      const g = A().game;
      ck(`${tier.key} 开局出得了货`, !!opened && !!g);
      eq(`${tier.key} 盘面就是档位尺寸`, `${g.board.w}×${g.board.h}`, `${tier.w}×${tier.h}`);
      eq(`${tier.key} 棋头写着档位与尺寸`, text('#stat-name'), `${tier.name} · ${tier.w}×${tier.h}`);
      eq(`${tier.key} 开局未胜`, g.status, 'playing');
      eq(`${tier.key} 开局不写胜利遮罩`, shown('#win-veil'), false);
      eq(`${tier.key} 待定格读数等于可下墨格数`, text('#stat-remaining'), String(g.board.total));
      ck(`${tier.key} 每棵树都有候选营位`, g.board.treeSpots.every((sp) => sp.length > 0));
      ck(`${tier.key} 数字不超过所在行能放的帐篷`, Array.from(g.board.want).every((v, i) => v === -1 || v <= g.board.lines[i].length));
      const scores = [];
      const clueCount = [];
      let inBand = 0;
      let unique = 0;
      let finishable = 0;
      let ms = 0;
      for (let k = 0; k < 5; k++) {
        const t0 = performance.now();
        const p = en.makePuzzle(`gen|${tier.key}|${k}`, tier.key);
        ms += performance.now() - t0;
        if (!p) continue;
        scores.push(p.score);
        clueCount.push(p.clues);
        if (p.score >= tier.band[0] && p.score <= tier.band[1]) inBand++;
        if (en.solve(p.board).ok) finishable++;
        if (en.countSolutions(p.board, { cap: 2, budget: 600000 }).status === 'UNIQUE') unique++;
        eq(`${tier.key} 出货第 ${k} 局的尺寸也对`, `${p.board.w}×${p.board.h}`, `${tier.w}×${tier.h}`);
      }
      const lines = tier.w + tier.h;
      eq(`${tier.key} 出货 5/5`, scores.length, 5);
      ck(`${tier.key} 命中难度区间`, inBand >= 4, `${inBand}/5 在 ${tier.band}`);
      eq(`${tier.key} 每局唯一解`, unique, scores.length);
      eq(`${tier.key} 每局推得完`, finishable, scores.length);
      ck(`${tier.key} 出题够快`, ms / 5 < 400, `${(ms / 5).toFixed(1)} ms/局`);
      if (tier.key === 'trainee') eq('初学保留全部数字（keepRatio 1）', clueCount.sort((a, b) => a - b)[2], lines);
      else ck(`${tier.key} 数字确实被删过`, clueCount.sort((a, b) => a - b)[2] < lines, `${clueCount.sort((a, b) => a - b)[2]}/${lines}`);
      medians.push({ key: tier.key, m: scores.sort((a, b) => a - b)[2], size: `${tier.w}×${tier.h}` });
    }
    let mono = true;
    for (let i = 1; i < medians.length; i++) if (!(medians[i].m > medians[i - 1].m)) mono = false;
    ck('档位中位分数单调递增', mono, medians.map((o) => `${o.key}:${o.m}`).join(' '));
    eq('每档盘面都比上一档大', new Set(medians.map((o) => o.size)).size, 5);

    // The same seed must give the same board — a save stores only the seed.
    const a = en.makePuzzle('gen|same', 'expert');
    eq('同种子同盘', Array.from(en.makePuzzle('gen|same', 'expert').board.want).join(','), Array.from(a.board.want).join(','));
    ck('不同种子不同盘', Array.from(en.makePuzzle('gen|other', 'expert').board.want).join(',') !== Array.from(a.board.want).join(','));
    eq('出货记下原始种子', a.originSeed, 'gen|same');
    ck('派生种子带抽盘次数', /^gen\|same#\d+$/.test(a.seed), a.seed);
    ck('抽盘次数记在货上（1..40）', a.gen >= 1 && a.gen <= 40, String(a.gen));

    // Ungated random deletion: the counter, not the generator, decides — and where it says many,
    // the pencil rules must refuse to finish. Without this control the uniqueness claims above
    // would only prove that pruning keeps going until it agrees with itself.
    let many = 0;
    let fooled = 0;
    let tried = 0;
    for (let s = 0; s < 14; s++) {
      const r = (() => {
        let x = (4242 + s * 7919) >>> 0 || 11;
        return () => {
          x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296;
        };
      })();
      const { tree, solution } = en.plant(6, 6, r, 0.25, 0.25);
      const { rowClue, colClue } = en.cluesFrom(6, 6, tree, solution);
      let full;
      try {
        full = en.createBoard({ w: 6, h: 6, tree, rowClue, colClue });
      } catch {
        continue;
      }
      const want = Int8Array.from(full.want);
      for (let i = 0; i < want.length; i++) if (r() < 0.45) want[i] = en.NO_CLUE;
      let b;
      try {
        b = en.createBoard({ w: 6, h: 6, tree, rowClue: want.slice(0, 6), colClue: want.slice(6, 12) });
      } catch {
        continue;
      }
      tried++;
      const c = en.countSolutions(b, { cap: 2, budget: 200000 });
      if (c.status !== 'UNIQUE') {
        many++;
        if (en.solve(b).ok) fooled++;
      }
    }
    ck('随机乱删会造出多解盘（对照组不是空的）', many >= 4, `只造出 ${many} 块多解盘 / ${tried} 块样本`);
    eq('多解盘不会被规则误判推完', fooled, 0);
    eq('满数字盘永远是唯一的', en.countSolutions(full_of('regular'), { cap: 2, budget: 600000 }).status, 'UNIQUE');
    return report({ medians: medians.map((o) => o.m) });

    function full_of(key) {
      const tier = en.tierFor(key);
      const p = en.makePuzzle('gen|full', key);
      const { rowClue, colClue } = en.cluesFrom(tier.w, tier.h, p.tree, p.solution);
      return en.createBoard({ w: tier.w, h: tier.h, tree: p.tree, rowClue, colClue });
    }
  };

  // ---------- play ----------

  const play = async () => {
    const en = E();
    en.Store.reset();
    A().show('menu');
    await wait(40);
    ck('选档页可见', shown('#view-menu'));
    eq('棋局页此刻是藏着的', shown('#view-game'), false);
    eq('标题是帐篷', text('#app h1'), '帐篷');
    ck('副标题点出玩法', /Tents/.test(text('.brand .sub')) && /树与帐篷/.test(text('.brand .sub')), text('.brand .sub'));
    ck('主标语说帐篷不许互碰（含斜角）', /斜角/.test(text('.menu-hero h2')), text('.menu-hero h2'));
    eq('玩法说明写了五条规则', document.querySelectorAll('.rules li').length, 5);
    eq('纪录表按档位排', document.querySelectorAll('#record-list li').length, 5);
    eq('清档前没有纪录', document.querySelector('#record-list li').textContent.includes('还没有纪录'), true);
    ck('页脚提到验证脚本', /tools\/verify\.sh/.test(text('footer')), text('footer'));
    eq('没开过局就没有可继续的一局', shown('#resume-card'), false);

    document.querySelectorAll('#tier-list .tier')[1].click();
    await wait(80);
    ck('点档位进入棋局', shown('#view-game'));
    const g = A().game;
    eq('进入的是上手档', g.puzzle.tier, 'apprentice');
    eq('棋头写了档位名与尺寸', text('#stat-name'), '上手 · 6×6');
    eq('档位徽章写着初学/上手', [text('#stat-tier'), $('#stat-tier').dataset.tier].join('/'), '上手/apprentice');
    eq('计时从 00:00 起', text('#stat-time'), '00:00');
    eq('步数为 0', text('#stat-moves'), '0');
    eq('提示为 0', text('#stat-hints'), '0');
    eq('已定格读数 0/可下墨格数', text('#stat-filled'), `0/${g.board.total}`);
    eq('待定格等于可下墨格数', text('#stat-remaining'), String(g.board.total));
    eq('凑齐的数从 0 起', text('#stat-satisfied'), `0/${g.board.clues}`);
    eq('冲突 0', text('#stat-conflicts'), '0');
    eq('难度实测显示分数', text('#stat-score'), g.puzzle.score.toFixed(1));
    eq('胜利遮罩藏起', shown('#win-veil'), false);
    eq('状态行开局为空', text('#state-line'), '');
    const geo = A().view.geo;
    const rect = A().view.canvas.getBoundingClientRect();
    // One-sided gutters (js/render/board.js `layoutFor`): the row numbers own the left strip and
    // the column numbers the top one, so the canvas is grid + one gutter, not grid + two.
    ck('画布按棋盘铺开', Math.abs(rect.width - (geo.cell * g.w + geo.x)) <= 1, `${rect.width} vs ${geo.cell * g.w + geo.x}`);
    ck('画布高度同理', Math.abs(rect.height - (geo.cell * g.h + geo.y)) <= 1, `${rect.height} vs ${geo.cell * g.h + geo.y}`);
    eq('格子边长是整数', Number.isInteger(geo.cell), true);
    ck('画布不出视口', rect.left >= 0 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1, JSON.stringify({ r: rect.right, b: rect.bottom, iw: window.innerWidth }));
    eq('默认笔是帐篷', $('#board').dataset.mode, 'tent');
    eq('帐篷键按下态', $('#btn-mode-tent').getAttribute('aria-pressed'), 'true');
    eq('草地键未按下', $('#btn-mode-grass').getAttribute('aria-pressed'), 'false');

    $('#btn-mode-grass').click();
    await wait(30);
    eq('切笔写进 data-mode', $('#board').dataset.mode, 'grass');
    eq('草地键亮起', $('#btn-mode-grass').getAttribute('aria-pressed'), 'true');
    const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('t');
    await wait(30);
    eq('T 键切回帐篷', [$('#board').dataset.mode, g.mode].join('/'), `tent/${en.TENT}`);
    key('g');
    await wait(30);
    eq('G 键切到草地', $('#board').dataset.mode, 'grass');
    key('m');
    await wait(30);
    eq('M 键在两支笔之间来回', $('#board').dataset.mode, 'tent');

    // The cycle a finger gets: 待定 → 帐篷 → 草地 → 待定, one tap per step, one move per step.
    let free = -1;
    for (let t = 0; t < g.board.n; t++) if (!g.board.tree[t]) { free = t; break; }
    const cycle = [];
    A().setMode(en.TENT);
    await tap(free);
    cycle.push(`${A().valueOf(free)}/${text('#stat-moves')}`);
    A().setMode(en.GRASS);
    await tap(free);
    cycle.push(`${A().valueOf(free)}/${text('#stat-moves')}`);
    A().setMode(en.GRASS);
    await tap(free);
    cycle.push(`${A().valueOf(free)}/${text('#stat-moves')}`);
    eq('点三下走完 待定→帐篷→草地→待定', cycle.join(' '), `1/1 2/2 0/3`);
    eq('走完一轮之后读数回到开局', [text('#stat-filled'), text('#stat-remaining')].join(' '), `0/${g.board.total} ${g.board.total}`);
    A().setMode(en.TENT);

    // A trunk takes no ink, through the finger path rather than through the API.
    const trunk = g.board.trees[0];
    const trunkBefore = [text('#stat-moves'), text('#stat-filled')];
    // Sample a corner, not the middle: the tree glyph (canopy + stem) covers the centre of its own
    // cell, so the ground is only visible where no mark reaches — and the same corner on a free
    // cell is exactly the paper the two grounds have to differ from.
    const trunkGround = cellPixel(trunk, 0.12, 0.12);
    const freeGround = cellPixel(free, 0.12, 0.12);
    eq('树干格上的帐篷笔不放东西', A().tap(trunk), null);
    await tap(trunk);
    eq('点树干也不算一步', text('#stat-moves'), trunkBefore[0]);
    eq('树干格的记号仍是待定', A().valueOf(trunk), en.OPEN);
    eq('一笔拖过树干也不落墨', A().stroke([free, trunk], en.TENT).writes.length, 1);
    eq('拖过的树格没被写', A().valueOf(trunk), en.OPEN);
    ck('树格的地板是最暗的那层', near(trunkGround, TRUNK_GROUND, 8), JSON.stringify(trunkGround));
    ck('待定自由格是纸色', near(freeGround, PAPER, 8), JSON.stringify(freeGround));
    ck('树格的地板与自由格不同', dist(trunkGround, freeGround) > 8, JSON.stringify({ trunk: trunkGround, free: freeGround }));
    A().undo();

    // Counters move the way the rules say they should.
    const before = A().state();
    for (let k = 0; k < 4; k++) {
      let t = -1;
      for (let i = 0; i < g.board.n; i++) if (!g.board.tree[i] && A().valueOf(i) === en.OPEN) { t = i; break; }
      A().stroke([t], k % 2 ? en.GRASS : en.TENT);
    }
    await wait(30);
    const after = A().state();
    eq('四笔之后已定格 +4', after.filled - before.filled, 4);
    eq('四笔之后待定格 -4', before.remaining - after.remaining, 4);
    eq('四笔之后步数 +4', after.moves - before.moves, 4);
    eq('面板读数与 state() 同一份', [text('#stat-filled'), text('#stat-remaining'), text('#stat-moves')].join(' '), `${after.filled}/${after.total} ${after.remaining} ${after.moves}`);
    eq('半盘棋还不算赢', g.status, 'playing');
    eq('半盘棋不开胜利遮罩', shown('#win-veil'), false);
    ck('待定格的纸面是纸色', near(cellPixel([...Array(g.board.n).keys()].find((t) => !g.board.tree[t] && A().valueOf(t) === en.OPEN)), PAPER, 10));

    A().undo();
    await wait(30);
    eq('撤销退一格', A().state().filled, after.filled - 1);
    eq('撤销退一步', text('#stat-moves'), String(after.moves - 1));
    // The scribbles above are marks no set of clues endorses, and the hint path correctly refuses
    // to spend a hint on a board that already contradicts itself. Empty it first: only from a clean
    // sheet is "the next fact the clues force" guaranteed to be there.
    while (A().undo()) { /* back to a clean sheet */ }
    await wait(30);
    eq('一路撤销能退到空盘', A().state().filled, 0);
    key('h');
    await wait(60);
    eq('一次提示落一格', A().state().filled, 1);
    eq('H 键给一次提示', text('#stat-hints'), '1');
    eq('提示按钮角标同步', text('#hint-count'), '1');
    ck('提示理由挂着规则名', /^规则：(无树不扎营|一帐八周空|行列封顶|只差这些|树唯一落点)$/.test(text('#hint-rule')), text('#hint-rule'));
    ck('提示说的是推得出的一步', text('#hint-line').length > 10, text('#hint-line'));
    eq('提示不落胜利遮罩', shown('#win-veil'), false);
    key('z');
    await wait(60);
    eq('Z 键退掉提示写的格子', A().state().filled, 0);
    eq('撤销不退提示次数', text('#stat-hints'), '1');

    const wasOn = $('#btn-sound').getAttribute('aria-pressed') === 'true';
    $('#btn-sound').click();
    await wait(30);
    eq('音效按钮改文案', text('#btn-sound'), wasOn ? '音效 关' : '音效 开');
    eq('音效按钮的 aria 状态跟着改', $('#btn-sound').getAttribute('aria-pressed'), String(!wasOn));
    eq('音效选择进存档', JSON.parse(localStorage.getItem('tents.save.v1')).settings.sound, !wasOn);
    $('#btn-sound').click();
    await wait(30);
    eq('音效能开回来', en.Store.setting('sound'), true);
    $('#btn-motion').click();
    await wait(30);
    eq('动效按钮改文案', text('#btn-motion'), '动效 省');
    ck('减少动效写进 body', document.body.classList.contains('reduce-motion'));
    $('#btn-motion').click();
    await wait(30);
    ck('再点一次退回去', !document.body.classList.contains('reduce-motion') && en.Store.setting('reduceMotion') === false, `${document.body.classList.contains('reduce-motion')} ${en.Store.setting('reduceMotion')}`);

    $('#btn-new').click();
    await wait(80);
    eq('换一局留在同档', A().game.puzzle.tier, 'apprentice');
    eq('换一局清零步数', text('#stat-moves'), '0');
    eq('换一局清零提示', text('#stat-hints'), '0');
    ck('换一局关掉遮罩', !shown('#win-veil'));
    ck('换一局清空上一局的墨', A().state().filled === 0, A().state().filled);
    $('#btn-menu').click();
    await wait(40);
    ck('回选档留下可继续的一局', shown('#resume-card'));
    ck('继续卡写了花费', /步 · 提示/.test(text('#resume-meta')), text('#resume-meta'));
    $('#btn-resume').click();
    await wait(60);
    ck('继续回到棋局', shown('#view-game'));
    eq('继续之后棋盘是空的（上一局没落子）', A().state().filled, 0);
    return report({ tier: g.puzzle.tier, total: g.board.total });
  };

  // ---------- hint ----------

  const hint = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'expert', seed: 'scen|hint' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    eq('提示局开局干净', g.state().filled, 0);
    const names = new Set(Object.values(en.Rules).map((r) => r.name));
    const seen = new Set();
    let charged = 0;
    let badRule = 0;
    let outOfRange = 0;
    let notWritten = 0;
    let lied = [];
    let domMiss = 0;
    for (let k = 0; k < 600 && g.status !== 'won'; k++) {
      const ink = copyInk();
      const info = A().useHint();
      if (!info) break;
      if (info.stalled) {
        ck('推完之前不喊停', false, info.text);
        break;
      }
      if (info.conflict) {
        ck('一路提示不该撞到自己的记号', false, info.conflict);
        break;
      }
      charged++;
      seen.add(info.rule);
      if (!names.has(info.rule)) badRule++;
      if (!(info.cell >= 0 && info.cell < b.n)) outOfRange++;
      if (g.valueOf(info.cell) !== info.value) notWritten++;
      // The DOM half: the panel must be showing this sentence, not a stale one.
      if (text('#hint-rule') !== `规则：${info.rule}` || text('#hint-line') !== info.why) domMiss++;
      // And the sentence itself must be true of the board as it stood before the write.
      const why = info.why;
      if (info.rule === '无树不扎营') {
        if (!(info.value === en.GRASS && !treeBeside(info.cell) && !b.tree[info.cell] && why.includes(b.cellName(info.cell)))) lied.push(['无树不扎营', info.cell, why]);
      } else if (info.rule === '一帐八周空') {
        const ok = info.value === en.GRASS && ink[info.tent] === en.TENT && ringOf(info.tent).includes(info.cell) && why.includes(b.cellName(info.tent));
        if (!ok) lied.push(['一帐八周空', info.cell, why]);
      } else if (info.rule === '行列封顶') {
        const L = lineCount(ink, info.line);
        const ok = info.value === en.GRASS && L.tents === L.want && b.lines[L.id === undefined ? info.line : info.line].includes(info.cell) && why.includes(b.lineName(info.line));
        if (!ok) lied.push(['行列封顶', info.cell, why]);
      } else if (info.rule === '只差这些') {
        const L = lineCount(ink, info.line);
        const ok = info.value === en.TENT && L.open === L.want - L.tents && L.want - L.tents > 0 && b.lines[info.line].includes(info.cell) && why.includes(b.lineName(info.line));
        if (!ok) lied.push(['只差这些', info.cell, why]);
      } else if (info.rule === '树唯一落点') {
        const k2 = b.trees.indexOf(info.tree);
        const open = b.treeSpots[k2].filter((s) => ink[s] === en.OPEN);
        const hasTent = b.treeSpots[k2].some((s) => ink[s] === en.TENT);
        const ok = info.value === en.TENT && b.tree[info.tree] && orthoOf(info.tree).includes(info.cell) && open.length === 1 && open[0] === info.cell && !hasTent && why.includes(b.cellName(info.tree));
        if (!ok) lied.push(['树唯一落点', info.cell, why]);
      } else {
        lied.push(['未知规则', info.cell, info.rule]);
      }
    }
    eq('一路提示能走完这局', g.status, 'won');
    eq('提示次数等于可下墨的格数', charged, b.total);
    eq('提示次数被记上', g.hints, charged);
    eq('面板显示同样的次数', text('#stat-hints'), String(charged));
    eq('提示说的规则都在表里', badRule, 0);
    eq('提示不越界', outOfRange, 0);
    eq('提示说完就真落子', notWritten, 0);
    eq('面板永远挂着刚说的那句', domMiss, 0);
    eq('提示没有一句与盘面不符', lied.length, 0);
    ck('用到的规则不止三种', seen.size >= 3, [...seen].join(','));
    eq('终盘通过独立验收', en.verify(b, g.st.cell).length, 0);
    eq('终盘凑齐了每一个数字', g.state().satisfied, g.state().clues);
    ck('胜利遮罩出现', shown('#win-veil'));
    ck('胜利文案带花费', /步 · 提示/.test(text('#win-meta')), text('#win-meta'));
    const after = g.hints;
    A().useHint();
    eq('胜利后再按提示不充电', g.hints, after);
    eq('胜利后续局被清掉', en.Store.resume(), null);

    // An unproductive hint is not a purchase. Mark the cell the next deduction is about, wrongly.
    const g2 = A().begin({ tier: 'regular', seed: 'scen|hint2' });
    await wait(60);
    eq('换局后脚本重来', g2.cursor, 0);
    eq('换局后提示清零', g2.hints, 0);
    const row = g2.script[g2.cursor];
    const wrong = row.value === en.TENT ? en.GRASS : en.TENT;
    A().stroke([row.cell], wrong);
    const hintsBefore = g2.hints;
    const info = A().useHint();
    ck('提示拒绝在矛盾上落子', !!info.conflict, JSON.stringify(info));
    eq('矛盾时不收钱', g2.hints, hintsBefore);
    eq('面板也不加钱', text('#stat-hints'), String(hintsBefore));
    eq('状态行挂着矛盾徽章', text('#hint-rule'), '这里和数字矛盾');
    ck('矛盾说明写清该放什么', /必须是(帐篷|草地)/.test(info.conflict), info.conflict);
    ck('矛盾说明点名那一格', info.conflict.includes(g2.board.cellName(row.cell)), info.conflict);
    eq('提示没落子，格子上还是玩家自己的记号', g2.valueOf(row.cell), wrong);
    A().undo();
    await wait(30);
    const ok2 = A().useHint();
    eq('擦掉自己的错记号之后提示才肯落子', ok2.value, row.value);
    eq('这次才计一次提示', g2.hints, 1);
    eq('这次的规则名挂上了面板', text('#hint-rule'), `规则：${ok2.rule}`);
    eq('这次的话就是它给出的理由', text('#hint-line'), ok2.why);
    return report({ hints: charged, rules: [...seen] });
  };

  // ---------- stroke ----------

  const stroke = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'trainee', seed: 'scen|stroke' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    eq('开局没有墨', g.state().filled, 0);
    eq('开局没有步', text('#stat-moves'), '0');

    // A drag paints ahead of the commit: the cells follow the finger and the renderer draws them at
    // once — what is deferred is the *step*. No move is counted and nothing reaches the undo stack
    // until the release. That gap is where a "commit once per cell" bug would live.
    const rowCells = [...Array(b.w).keys()];
    const inkedRow = rowCells.filter((t) => !b.tree[t]);
    const down = clientOf(rowCells[0]);
    const up = clientOf(rowCells[b.w - 1]);
    pointer('pointerdown', down.x, down.y);
    await wait(20);
    const mid1 = { moves: Number(text('#stat-moves')), steps: g.steps.length, filled: g.state().filled };
    for (let i = 1; i < b.w; i++) {
      const p = clientOf(rowCells[i]);
      pointer('pointermove', p.x, p.y);
    }
    await wait(20);
    const mid = { moves: Number(text('#stat-moves')), steps: g.steps.length, filled: g.state().filled, ink: rowCells.map((t) => A().valueOf(t)) };
    eq('按下的一瞬间只画了一格', mid1.filled, b.tree[rowCells[0]] ? 0 : 1);
    ck('拖过的格全都画出来了', mid.filled === inkedRow.length && rowCells.every((t) => b.tree[t] || A().valueOf(t) === en.TENT), JSON.stringify(mid));
    eq('拖到一半还不算步', mid.moves, 0);
    eq('拖到一半不入撤销栈', mid.steps, 0);
    // The preview's five tents in one row break that row's number, so the picture calls them red:
    // colours during a drag are the engine's verdict on *unfinished* ink, not a promise.
    const midPx = tentPixel(inkedRow[1] === undefined ? inkedRow[0] : inkedRow[1]);
    ck('预览的墨已经到了画布上', !near(midPx, PAPER, 12) && !near(midPx, LIFT, 12), JSON.stringify(midPx));
    ck('没落定的那一排被画成红', near(midPx, RED, 14), JSON.stringify(midPx));
    pointer('pointerup', up.x, up.y);
    await wait(30);
    const covered = rowCells.filter((t) => A().valueOf(t) === en.TENT).length;
    eq('一笔横拖覆盖的格全落定', g.state().filled, covered);
    eq('一笔只算一步', text('#stat-moves'), '1');
    eq('一笔只进一格撤销栈', g.steps.length, 1);
    eq('这一笔写的都是帐篷', rowCells.every((t) => b.tree[t] || A().valueOf(t) === en.TENT), true);
    A().undo();
    await wait(30);
    eq('一次撤销退掉整笔', g.state().filled, 0);
    eq('撤销也退步数', text('#stat-moves'), '0');
    eq('撤销之后一格不剩', rowCells.map((t) => A().valueOf(t)).join(','), rowCells.map(() => 0).join(','));

    // A diagonal drag covers the diagonal, not the board — the pointer has to travel over a cell
    // for that cell to take ink.
    A().setMode(en.GRASS);
    const diag = await drag(g.cellAt(0, 0), g.cellAt(b.w - 1, b.h - 1));
    diag.up();
    await wait(30);
    const diagonal = rowCells.map((c) => g.cellAt(c, c));
    eq('对角拖过的格数等于边长（树格除外）', g.state().filled, diagonal.filter((t) => !b.tree[t]).length);
    ck('落的都是拖过的那条对角线', diagonal.every((t) => b.tree[t] || A().valueOf(t) === en.GRASS), rowCells.map((t) => g.cellAt(t, t)).map((t) => A().valueOf(t)).join(','));
    ck('没拖到的格仍是待定', A().valueOf(g.cellAt(b.w - 1, 0)) === en.OPEN || diagonal.includes(g.cellAt(b.w - 1, 0)), A().valueOf(g.cellAt(b.w - 1, 0)));
    // dragging back over your own mark must not eat it mid-gesture
    A().setMode(en.GRASS);
    const back = await drag(g.cellAt(0, 1), g.cellAt(b.w - 1, 1));
    const rev = clientOf(g.cellAt(0, 1));
    pointer('pointermove', rev.x, rev.y);
    pointer('pointerup', rev.x, rev.y);
    await wait(30);
    const row1 = [...Array(b.w).keys()].map((c) => g.cellAt(c, 1)).filter((t) => t >= 0);
    ck('来回拖仍然写下整行', row1.filter((t) => A().valueOf(t) === en.GRASS).length >= 3, row1.map((t) => A().valueOf(t)).join(','));
    eq('来回拖仍然只算一步（加上对角那一笔共 2）', Number(text('#stat-moves')), 2);

    // Starting a drag on a mark that is already this one turns the whole gesture into an eraser —
    // the same predictable rule for both pens.
    const moves2 = Number(text('#stat-moves'));
    const erase = await drag(g.cellAt(0, 1), g.cellAt(b.w - 1, 1));
    erase.up();
    await wait(30);
    ck('从自己的记号上起笔就是擦', row1.every((t) => b.tree[t] || A().valueOf(t) === en.OPEN), row1.map((t) => A().valueOf(t)).join(','));
    ck('擦掉的确实是有记号的那些格', row1.filter((t) => !b.tree[t]).length > 0 && g.steps.length === 3, String(g.steps.length));
    eq('擦掉这一笔也算一步', Number(text('#stat-moves')), moves2 + 1);

    // Off-canvas press does nothing.
    const canvasBox = box();
    const moves3 = Number(text('#stat-moves'));
    pointer('pointerdown', canvasBox.left - 8, canvasBox.top + 8);
    pointer('pointerup', canvasBox.left - 8, canvasBox.top + 8);
    await wait(30);
    eq('画布外的按下不落子', Number(text('#stat-moves')), moves3);
    // hitCell refuses the gutter the numbers live in
    eq('左边留白点不出格子', A().view.hitCell(canvasBox.left + 4, canvasBox.top + canvasBox.height / 2), -1);
    eq('上边留白点不出格子', A().view.hitCell(canvasBox.left + canvasBox.width / 2, canvasBox.top + 4), -1);

    while (A().undo()) { /* drain */ }
    eq('一路撤销能退到空盘', g.state().filled, 0);
    eq('退无可退时撤销给 null', A().undo(), null);

    // Win by playing the engine's own answer through the same commit a pointer release uses.
    const der = en.solve(b).derived;
    A().begin({ tier: 'trainee', seed: 'scen|stroke-win' });
    await wait(60);
    const g2 = A().game;
    const ink2 = en.solve(g2.board).derived;
    const tents = tentsOf(ink2);
    const grasses = [...Array(g2.board.n).keys()].filter((t) => !g2.board.tree[t] && ink2[t] === en.GRASS);
    A().stroke(tents, en.TENT);
    await wait(20);
    eq('先画完帐篷时不该有冲突', g2.state().conflicts, 0);
    eq('帐篷画完还没赢（草地没定）', g2.status, 'playing');
    eq('胜利遮罩还藏着', shown('#win-veil'), false);
    A().stroke(grasses, en.GRASS);
    await wait(40);
    eq('照解画完就胜利', g2.status, 'won');
    eq('手工通关一共两步', g2.moves, 2);
    eq('纯手工通关不用提示', g2.hints, 0);
    ck('胜利文案写 0 次提示', /提示 0 次/.test(text('#win-meta')), text('#win-meta'));
    ck('胜利遮罩盖住棋盘', shown('#win-veil'));
    ck('手工通关写下纪录', !!en.Store.best('trainee'), JSON.stringify(en.Store.best('trainee')));
    eq('纪录里的提示次数是 0', en.Store.best('trainee').hints, 0);
    eq('胜利之后点不动的笔不再改盘', (A().stroke([g2.board.trees[0]], en.TENT), g2.st.cell[g2.board.trees[0]]), en.OPEN);
    void der;
    return report({ cells: covered, moves: g2.moves });
  };

  // ---------- conflict ----------

  const conflict = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'trainee', seed: 'scen|conflict' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    const theme = en.theme;
    eq('开局没有冲突', g.state().conflicts, 0);
    eq('面板冲突读数 0', text('#stat-conflicts'), '0');
    eq('开局没有红字', $('#stat-conflicts').closest('.stat').classList.contains('bad'), false);
    eq('开局状态行是空的', text('#state-line'), '');
    // theme.js is one source of truth: the pixels below must be the colours the page wears.
    eq('错误红就是主题里的 error', [cssVar('--error'), RED.join(',')].join('/'), `${theme.error}/255,92,122`);
    eq('成功绿就是主题里的 success', cssVar('--success'), theme.success);

    // Break a number: one tent more than the row says it holds. Nothing else about the board is
    // wrong yet, which is exactly why the picture has to say it.
    const rowId = b.rowId(0);
    const want = b.want[rowId];
    const spots = [...b.lines[rowId]].filter((t) => b.spot[t]);
    const tooMany = spots.slice(0, want + 1);
    ck('这块盘给得出「多一顶」的样本', tooMany.length === want + 1, JSON.stringify({ want, spots }));
    A().stroke(tooMany, en.TENT);
    await wait(40);
    eq('数字被冲破时冲突计数在涨', g.state().conflicts > 0, true);
    eq('面板读数与 state() 一致', text('#stat-conflicts'), String(g.state().conflicts));
    eq('冲突那一项挂上红标', $('#stat-conflicts').closest('.stat').classList.contains('bad'), true);
    ck('验收器说的是同一件事', en.verify(b, g.st.cell).some((x) => x.why === '帐篷多了'), JSON.stringify(en.verify(b, g.st.cell).slice(0, 3)));
    ck('状态行把矛盾说出来', /矛盾|对不上/.test(text('#state-line')), text('#state-line'));
    eq('状态行说的是 reachable 那句（还没破完全部数字）', text('#state-line').startsWith('这些帐篷和数字已经矛盾了'), String(g.state().stuck));
    // The pixel half: the tents that broke the number must be red, and they must be the only ones.
    const red = redInkCells();
    ck('破数字的帐篷被画成红色', tooMany.every((t) => red.includes(t)), JSON.stringify({ tooMany, red, px: tooMany.map((t) => tentPixel(t)) }));
    eq('红就是主题的 error 色', near(tentPixel(tooMany[0]), hex(cssVar('--error')), 6), true);
    eq('这一行的数字也画成红圈', near(cluePixel(rowId, 'ring'), RED, 6), true);
    eq('这一行的数字字面也是红的', near(cluePixel(rowId, 'glyph'), RED, 40), true);
    // A blank cell in the same row must not be painted red — the highlight is for ink, not for the
    // whole line.
    const blank = [...b.lines[b.rowId(2)]].find((t) => A().valueOf(t) === en.OPEN);
    ck('没落子的行还是纸色', near(cellPixel(blank), PAPER, 12), JSON.stringify({ blank, px: cellPixel(blank) }));
    ck('其它行的数字没被冤枉', near(cluePixel(b.rowId(2), 'ring'), RING, 6), JSON.stringify(cluePixel(b.rowId(2), 'ring')));

    // Repair it and the picture has to cool down.
    A().undo();
    await wait(40);
    eq('撤掉那一笔之后冲突归零', g.state().conflicts, 0);
    eq('面板读数也归零', text('#stat-conflicts'), '0');
    eq('红标退掉', $('#stat-conflicts').closest('.stat').classList.contains('bad'), false);
    eq('状态行清空', text('#state-line'), '');
    eq('画布上不再有红的帐篷', redInkCells().length, 0);
    eq('数字圈退回未定色', near(cluePixel(rowId, 'ring'), RING, 6), true);

    // A satisfied number wears green: fill one row correctly and only that row's disc changes.
    const der = en.solve(b).derived;
    const row0 = [...b.lines[rowId]];
    A().stroke(row0.filter((t) => der[t] === en.TENT), en.TENT);
    A().stroke(row0.filter((t) => der[t] === en.GRASS), en.GRASS);
    await wait(40);
    eq('这一行了结之后没有冲突', g.state().conflicts, 0);
    ck('凑齐的数字画绿圈', near(cluePixel(rowId, 'ring'), GREEN, 6), JSON.stringify(cluePixel(rowId, 'ring')));
    ck('没凑齐的数字还是灰圈', near(cluePixel(b.rowId(2), 'ring'), RING, 6), JSON.stringify(cluePixel(b.rowId(2), 'ring')));
    ck('没落墨的行是纸', near(cellPixel(b.rowId(2) === 0 ? row0[0] : [...b.lines[b.rowId(2)]][0]), PAPER, 12));
    eq('面板「凑齐的数」只数带数字的线', text('#stat-satisfied'), `1/${b.clues}`);

    // 铺满 ≠ 赢：a full board of grass settles every cell and wins nothing. Every cell list below is
    // re-derived from the game that is actually on screen — these are different seeds, so the
    // trunks sit in different places.
    A().begin({ tier: 'trainee', seed: 'scen|conflict-grass' });
    await wait(60);
    const g2 = A().game;
    const b2 = g2.board;
    const free2 = [...Array(b2.n).keys()].filter((t) => !b2.tree[t]);
    A().stroke(free2, en.GRASS);
    await wait(40);
    eq('全草地的盘是满的', g2.state().filled, g2.state().total);
    eq('全草地的待定格为 0', g2.state().remaining, 0);
    eq('全草地不算赢', g2.status, 'playing');
    eq('全草地不开遮罩', shown('#win-veil'), false);
    ck('全草地有一堆冲突（树在挨饿）', g2.state().conflicts > 0, String(g2.state().conflicts));
    // A starving trunk is not ink: board.js paints trunks with the canopy glyph in pencil-strong, and
    // a tree is skipped by redInkCells() exactly as the renderer skips it. So the red this board is
    // entitled to show is on the *lines* that cannot reach their number — every mark inside a
    // violated line takes the error colour, whichever pen wrote it. (The old check settled for
    // `violated.size > 0`, a state reading that stayed green even if the canvas painted nothing.)
    const red2 = redInkCells();
    const badLines = [...g2.diag.violated].filter((id) => id < b2.nl);
    ck('挨饿的数字把所在行的记号全染红', badLines.length > 0 && badLines.every((id) => [...b2.lines[id]].every((t) => b2.tree[t] || g2.valueOf(t) === en.OPEN || red2.includes(t))), JSON.stringify({ badLines, red: red2.length }));
    // and a board with one cell left undecided must not win either
    while (A().undo()) { /* back to empty */ }
    await wait(20);
    A().stroke(free2.slice(0, free2.length - 1), en.GRASS);
    await wait(20);
    eq('留一格待定不算赢', g2.status, 'playing');
    eq('待定格读数 1', text('#stat-remaining'), '1');
    eq('留一格待定不开遮罩', shown('#win-veil'), false);
    A().stroke([free2[free2.length - 1]], en.GRASS);
    await wait(40);
    eq('补上最后一格仍是全草地，不算赢', g2.status, 'playing');
    // the same board, finished the way the clues say, is what wins
    A().begin({ tier: 'trainee', seed: 'scen|conflict-win' });
    await wait(60);
    const g3 = A().game;
    const b3 = g3.board;
    const der3 = en.solve(b3).derived;
    const free3 = [...Array(b3.n).keys()].filter((t) => !b3.tree[t]);
    A().stroke(free3.filter((t) => der3[t] === en.GRASS), en.GRASS);
    await wait(20);
    eq('草地铺满、帐篷没画，仍然不算赢', g3.status, 'playing');
    eq('这时候还有待定格', g3.state().remaining, tentsOf(der3).length);
    A().stroke(tentsOf(der3), en.TENT);
    await wait(40);
    eq('照解补上帐篷就赢了', g3.status, 'won');
    eq('赢的时候冲突为 0', g3.state().conflicts, 0);
    eq('赢的时候每个数字都凑齐', g3.state().satisfied, g3.state().clues);
    ck('胜利遮罩只在合法的满盘上出现', shown('#win-veil'));
    ck('满盘绿：帐篷画成成功绿', near(tentPixel(tentsOf(der3)[0]), GREEN, 8), JSON.stringify(tentPixel(tentsOf(der3)[0])));
    // A line without a number is drawn as a faint dot, not a ring — so the green check has to pick
    // a row that actually carries one.
    const clueRow3 = [...Array(b3.h).keys()].map((r) => b3.rowId(r)).find((i) => b3.want[i] !== en.NO_CLUE);
    ck('赢的时候每棵树的数字都绿了', near(cluePixel(clueRow3, 'ring'), GREEN, 8), JSON.stringify({ clueRow3, px: cluePixel(clueRow3, 'ring') }));
    return report({ conflicts: g.state().conflicts, red });
  };

  // ---------- save ----------

  const save = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'regular', seed: 'scen|save' });
    await wait(60);
    await wait(1100); // let the clock run, so 用时 is a real number rather than a fresh 0
    const g = A().game;
    const b = g.board;
    const der = en.solve(b).derived;
    for (let i = 0; i < 6; i++) A().stroke([tentsOf(der)[i]], en.TENT);
    A().useHint();
    await wait(40);
    const raw = JSON.parse(localStorage.getItem('tents.save.v1'));
    ck('存档键名是本作的', !!raw && !!raw.resume, Object.keys(raw || {}).join(','));
    eq('存档写原始种子（不是派生种子）', raw.resume.seed, g.puzzle.originSeed);
    ck('派生种子长这样：originSeed#抽盘次数', /#/.test(g.puzzle.seed) && raw.resume.seed === g.puzzle.originSeed, g.puzzle.seed);
    eq('存档写档位', raw.resume.tier, 'regular');
    eq('存档写格数', raw.resume.cells, b.n);
    eq('存档写步数', raw.resume.moves, g.moves);
    eq('存档写提示数', raw.resume.hints, g.hints);
    ck('存档写用时（已跑过一秒）', raw.resume.elapsedMs >= 1000, raw.resume.elapsedMs);
    eq('续局记录的键就是文档里那七个', Object.keys(raw.resume).sort().join(','), 'at,cells,elapsedMs,hints,ink,moves,seed,tier'.split(',').sort().join(','));
    ck('存档不过一千字节', JSON.stringify(raw.resume).length < 1000, JSON.stringify(raw.resume).length);
    // The ink crossed the boundary as [value,length] pairs — re-derived here, not trusted.
    const mine = rle(Array.from(g.st.cell));
    eq('存档里的 ink 就是游程对', JSON.stringify(mine), JSON.stringify(raw.resume.ink));
    ck('游程对的长度和等于格数', (() => { let n = 0; for (let i = 1; i < mine.length; i += 2) n += mine[i]; return n === b.n; })(), true);
    ck('值只有 0/1/2 三种', (() => mine.every((v, i) => (i % 2 ? v >= 1 : v === 0 || v === 1 || v === 2)))(), JSON.stringify(mine.slice(0, 8)));
    const back = en.Store.resume();
    eq('记号一格不差地回来', Array.from(back.board).join(','), Array.from(g.st.cell).join(','));
    ck('空格在存档里还是空格', back.board.some((v) => v === en.OPEN) && back.board.every((v) => v >= 0 && v <= en.GRASS), Array.from(back.board).slice(0, 12).join(','));
    ck('树格在存档里不占墨（由种子重绘）', b.tree.every((v, t) => !v || back.board[t] === en.OPEN), JSON.stringify(Array.from(back.board).filter((v, t) => b.tree[t])));
    // What the format costs and buys, measured on this board in both directions: an early save is
    // mostly one long run of 0s, so the pairs win big; a board that changes mark on every cell pays
    // two numbers per cell and the pairs lose.
    const perCell = Array.from(g.st.cell);
    ck('早期存档上游程编码省得多', bytes(mine) < bytes(perCell), `ink ${bytes(mine)} B vs 一格一数 ${bytes(perCell)} B`);
    const worst = [];
    for (let i = 0; i < b.n; i++) worst.push(i % 2 ? en.TENT : en.GRASS);
    ck('一格一换的盘上它反而更长（文档承认的那一半）', bytes(rle(worst)) > bytes(worst), `${bytes(rle(worst))} vs ${bytes(worst)}`);
    // Not a synthetic worst case, though: this very board, played out, is the losing case — a
    // settled 7×7 alternates tents and grass often enough that the pairs cost more than one number
    // per cell. The doc used to assert only the winning half; both halves are asserted now.
    const settled = Array.from(der);
    ck('照解满盘上游程编码更长（输了的那一半）', bytes(rle(settled)) > bytes(settled), `满盘 ${bytes(rle(settled))} B vs 一格一数 ${bytes(settled)} B`);
    ck('整条续局记录仍然只有几百字节', bytes(JSON.parse(localStorage.getItem('tents.save.v1')).resume) < 400, bytes(JSON.parse(localStorage.getItem('tents.save.v1')).resume));
    eq('默认设置音效开', en.Store.setting('sound'), true);
    ck('本作没有上一作的设置项', !('showNotes' in raw.settings) && !('hintOnStart' in raw.settings), JSON.stringify(raw.settings));
    localStorage.setItem('slant.save.v1', JSON.stringify({ settings: { showNotes: false }, resume: { seed: 'x' } }));
    reopen();
    eq('不读上一作的存档键', en.Store.setting('sound'), true);
    localStorage.removeItem('slant.save.v1');
    reopen();

    // Records are ranked by least help first — that is the whole meaning of a 纪录.
    en.Store.data.best = {};
    eq('首个纪录直接成立', en.Store.recordBest('regular', { ms: 50000, hints: 1, moves: 20, size: '7×7' }), true);
    eq('更快但更靠提示的不算破纪录', en.Store.recordBest('regular', { ms: 1000, hints: 2, moves: 5, size: '7×7' }), false);
    eq('少一次提示就算慢三倍也破纪录', en.Store.recordBest('regular', { ms: 400000, hints: 0, moves: 99, size: '7×7' }), true);
    eq('提示次数相同时省步算破纪录', en.Store.recordBest('regular', { ms: 60000, hints: 0, moves: 12, size: '7×7' }), true);
    eq('步数也相同时才比时间', en.Store.recordBest('regular', { ms: 90000, hints: 0, moves: 12, size: '7×7' }), false);
    eq('纪录留的是最好的那次', en.Store.best('regular').moves, 12);
    eq('纪录里的提示次数是最好那次的', en.Store.best('regular').hints, 0);
    en.Store.data.best = {};

    // Finish the board for real and the record that lands must be this run's cost.
    const solvedBefore = en.Store.data.totals.solved;
    const hintsTaken = g.hints;
    A().stroke(tentsOf(der).filter((t) => g.valueOf(t) !== en.TENT), en.TENT);
    A().stroke([...Array(b.n).keys()].filter((t) => !b.tree[t] && g.valueOf(t) === en.OPEN), en.GRASS);
    await wait(50);
    eq('照解补完就赢了', g.status, 'won');
    ck('胜利写下纪录', !!en.Store.best('regular'), JSON.stringify(en.Store.best('regular')));
    eq('纪录里的提示次数等于这一局花掉的', en.Store.best('regular').hints, hintsTaken);
    eq('总局数按局累加', en.Store.data.totals.solved, solvedBefore + 1);
    ck('累计提示在涨', en.Store.data.totals.hints >= hintsTaken, en.Store.data.totals.hints);
    eq('胜利之后续局记录被清掉', en.Store.resume(), null);
    ck('胜利文案写着同一笔花费', text('#win-meta').includes(`提示 ${hintsTaken} 次`), text('#win-meta'));
    ck('首个纪录自称新纪录', /新纪录/.test(text('#win-record')), text('#win-record'));

    // No wall-clock goes into the keys that decide which board you get: two rebuilds with a
    // different clock must land on the same board. This is what "reload redraws the same one"
    // means for a save that only carries a seed.
    const realNow = Date.now;
    const clockA = (() => {
      Date.now = () => 1700000000000;
      const p = en.makePuzzle('scen|save', 'regular');
      Date.now = realNow;
      return p;
    })();
    const clockB = (() => {
      Date.now = () => 1234567;
      const p = en.makePuzzle('scen|save', 'regular');
      Date.now = realNow;
      return p;
    })();
    eq('选盘不看墙钟（同一块盘）', Array.from(clockA.board.want).join(','), Array.from(clockB.board.want).join(','));
    eq('选盘也不看墙钟（树也一样）', Array.from(clockA.board.tree).join(','), Array.from(clockB.board.tree).join(','));
    eq('重绘出来的盘就是屏幕上这块', Array.from(clockA.board.want).join(','), Array.from(b.want).join(','));
    eq('重绘出来的树就是屏幕上这些', Array.from(clockA.board.tree).join(','), Array.from(b.tree).join(','));
    ck('墙钟已经换回来了（后面几步用的都是真时间）', Math.abs(Date.now() - realNow()) < 5000, Date.now());

    // 用时 is the one part of a run's cost that keeps growing while the player does nothing, and
    // closing a tab is not an action: if writes only rode on marks and button presses, the stored
    // record would carry the clock of the *previous* mark and coming back would rewind 用时. The
    // 2.2 s below are spent waiting — no stroke, no hint, no click between the two flushes.
    A().begin({ tier: 'regular', seed: 'scen|idle' });
    await wait(2200);
    const idle = JSON.parse(localStorage.getItem('tents.save.v1')).resume;
    ck('不落子的时候存档里的用时也在跟着走', idle.elapsedMs >= 1000 && Math.abs(idle.elapsedMs - A().elapsed()) <= 1500, `存档 ${idle.elapsedMs} ms / 屏上 ${A().elapsed()} ms`);
    eq('空等的这两秒没有多出步数', idle.moves, 0);
    eq('空等的这两秒没有多出提示', idle.hints, 0);
    eq('空等的这两秒盘上没落墨', Array.from(en.Store.resume().board).some((v) => v !== en.OPEN), false);

    // The reload path, for real. Everything a fresh document needs has to be in the one key: play a
    // second, half-finished board, leave through the button that flushes it, then throw the
    // in-memory Store away and read the bytes the way a page boot does. Behind that boundary the
    // live game, the Store object and the clock are all replaced — the board has to come back from
    // the seed and the ink from the run-length pairs, nothing else.
    A().begin({ tier: 'regular', seed: 'scen|reload' });
    await wait(60);
    await wait(1100); // a 用时 worth resuming
    const g2 = A().game;
    const b2 = g2.board;
    const der2 = en.solve(b2).derived;
    A().stroke(tentsOf(der2).slice(0, 5), en.TENT);
    A().useHint();
    $('#btn-menu').click();
    await wait(40);
    const saved = {
      clue: Array.from(b2.want).join(','),
      tree: Array.from(b2.tree).join(','),
      cell: Array.from(g2.st.cell).join(','),
      elapsed: A().elapsed(),
      moves: g2.moves,
      hints: g2.hints,
    };
    eq('面板的用时读数就是存档里那个（同一分钟）', text('#stat-time').slice(0, 2), String(Math.floor(saved.elapsed / 60000)).padStart(2, '0'));
    ck('存档里的用时是跑出来的（不止一秒）', JSON.parse(localStorage.getItem('tents.save.v1')).resume.elapsedMs >= 1000, JSON.parse(localStorage.getItem('tents.save.v1')).resume.elapsedMs);
    reopen();
    A().show('menu');
    await wait(40);
    const r = en.Store.resume();
    ck('重开之后存档里还剩着一局', !!r && r.seed === 'scen|reload', JSON.stringify(r && { seed: r.seed, tier: r.tier }));
    eq('重开之后记号也还在', Array.from(r.board).join(','), saved.cell);
    ck('重开之后继续卡还挂着', shown('#resume-card'));
    $('#btn-resume').click();
    await wait(60);
    const g3 = A().game;
    eq('继续重绘出同一块盘的数字', Array.from(g3.board.want).join(','), saved.clue);
    eq('继续重绘出同一块盘的树', Array.from(g3.board.tree).join(','), saved.tree);
    eq('继续还原全部记号', Array.from(g3.st.cell).join(','), saved.cell);
    eq('继续还原花费', [g3.moves, g3.hints].join('/'), `${saved.moves}/${saved.hints}`);
    ck('继续接着计时', A().elapsed() >= saved.elapsed, `${A().elapsed()} vs ${saved.elapsed}`);
    ck('继续之后面板的用时不是 00:00', text('#stat-time') !== '00:00' && Math.abs(Number(text('#stat-time').slice(3)) - Math.floor(saved.elapsed / 1000) % 60) <= 1, `${text('#stat-time')} vs ${saved.elapsed} ms`);
    // And the other half of the contract: the key holds one run at a time. A new game must evict
    // the old board rather than leave a stale 继续 hanging around next to it.
    A().begin({ tier: 'master', seed: 'scen|overwritten' });
    await wait(60);
    reopen();
    eq('换一局把续局挤掉了：存档里只剩新的那颗种子', (en.Store.resume() || {}).seed, 'scen|overwritten');
    eq('换一局留下的格数是新一局的格数', (en.Store.resume() || {}).cells, 81);
    return report({ bytes: JSON.stringify(raw.resume).length, ink: bytes(mine), hints: hintsTaken, reload: saved.elapsed });
  };

  // ---------- resume ----------

  const resume = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'expert', seed: 'scen|resume' });
    await wait(60);
    const g = A().game;
    const der = en.solve(g.board).derived;
    const clueBefore = Array.from(g.board.want).join(',');
    const treeBefore = Array.from(g.board.tree).join(',');
    for (let i = 0; i < 8; i++) A().stroke([tentsOf(der)[i]], en.TENT);
    A().useHint();
    A().useHint();
    await wait(1100);
    // 回选档走的是真按钮：#btn-menu 先 flush 一次续局，存档里的用时才是这一刻的用时
    $('#btn-menu').click();
    await wait(40);
    const saved = { cell: Array.from(g.st.cell).join(','), moves: g.moves, hints: g.hints, elapsed: A().elapsed() };
    ck('回选档留下继续卡', shown('#resume-card'));
    eq('继续卡写了档位', text('#resume-name'), '继续 高阶 的一局');
    ck('继续卡写着花费', /\d+ 步 · 提示 \d+ 次/.test(text('#resume-meta')), text('#resume-meta'));
    ck('继续卡写着用时（已经跑过一秒）', /^\d\d:\d\d/.test(text('#resume-meta')), text('#resume-meta'));
    eq('用时读数与内部时钟同一份', text('#stat-time'), '00:01');
    const r = en.Store.resume();
    ck('存档里的用时是跑出来的（不止一秒）', r.elapsedMs >= 1000, `${r.elapsedMs} vs ${saved.elapsed}`);
    eq('续局取回了记号', Array.from(r.board).join(','), saved.cell);
    eq('续局取回了提示数', r.hints, saved.hints);
    eq('续局取回了步数', r.moves, saved.moves);

    // Cross the storage boundary for real: drop the in-memory Store, re-render the menu from what
    // the key holds, and take the button a returning player presses.
    reopen();
    A().show('menu');
    await wait(40);
    ck('重开之后继续卡还在', shown('#resume-card'));
    $('#btn-resume').click();
    await wait(60);
    const g2 = A().game;
    eq('续局重绘出同一块盘的数字', Array.from(g2.board.want).join(','), clueBefore);
    eq('续局重绘出同一块盘的树', Array.from(g2.board.tree).join(','), treeBefore);
    eq('续局还原全部记号', Array.from(g2.st.cell).join(','), saved.cell);
    eq('续局还原步数', g2.moves, saved.moves);
    eq('续局还原提示数', g2.hints, saved.hints);
    eq('面板显示还原后的提示', text('#stat-hints'), String(saved.hints));
    eq('面板显示还原后的步数', text('#stat-moves'), String(saved.moves));
    ck('续局接着计时', A().elapsed() >= saved.elapsed, `${A().elapsed()} vs ${saved.elapsed}`);
    eq('面板已定格与引擎一致', text('#stat-filled').split('/')[0], String(g2.diag.filled));
    eq('续局不能撤销到重开之前', A().undo(), null);
    eq('撤销失败也不吃掉盘', Array.from(g2.st.cell).join(','), saved.cell);
    const hintsAtResume = g2.hints;
    eq('提示为 2 时不可能被读成 0', text('#stat-hints'), '2');

    // Finish it. The cost taken before the reload is what the record must carry.
    en.Store.data.best = {};
    const res = A().solveWithLogic();
    await wait(60);
    eq('续局可以推到胜利', g2.status, 'won', JSON.stringify(res));
    ck('推到底用了逻辑', res.steps > 1, res.steps);
    ck('提示次数没被续局清零', g2.hints >= hintsAtResume, `${g2.hints} vs ${hintsAtResume}`);
    eq('胜利文案写的是真实花费', text('#win-meta').includes(`提示 ${g2.hints} 次`), true);
    eq('纪录按求助最少记（不是 0）', en.Store.best('expert').hints, g2.hints);
    ck('纪录没被洗成提示 0', en.Store.best('expert').hints > 0, JSON.stringify(en.Store.best('expert')));
    eq('胜利后续局被清掉', en.Store.resume(), null);
    ck('胜利遮罩可见', shown('#win-veil'));
    $('#btn-menu-2').click();
    await wait(40);
    // Three layers, checked separately, because "the card is showing" can come from any of them:
    // the bytes in storage, the flag on the element, the stylesheet that turns the flag into ink.
    ck('胜利之后磁盘上也没有续局了', JSON.parse(localStorage.getItem('tents.save.v1')).resume === null, JSON.stringify(JSON.parse(localStorage.getItem('tents.save.v1')).resume));
    eq('继续卡带着 hidden 标记', $('#resume-card').hidden, true);
    eq('继续卡的样式真的收起来了', getComputedStyle($('#resume-card')).display, 'none');
    ck('胜利后回选档不再给继续', !shown('#resume-card'), text('#resume-name'));
    ck('总局数累加了', en.Store.data.totals.solved >= 1, en.Store.data.totals.solved);
    ck('纪录表里写着这一局', !document.querySelector('#record-list li[data-tier="expert"]').textContent.includes('还没有纪录'), document.querySelector('#record-list li[data-tier="expert"]').textContent);
    $('#btn-reset').click();
    await wait(40);
    eq('清空存档清掉纪录', en.Store.best('expert'), null);
    ck('清空存档回到选档', shown('#view-menu'));
    eq('清空后续局也没了', en.Store.resume(), null);
    eq('清空后棋局还留在内存里但不显示', shown('#view-game'), false);
    return report({ hints: g2.hints, resumedMoves: saved.moves });
  };

  // ---------- layout ----------

  const layout = async () => {
    const en = E();
    const realIw = window.innerWidth;
    const realIh = window.innerHeight;
    const setW = (iw, ih) => {
      Object.defineProperty(window, 'innerWidth', { get: () => iw, configurable: true });
      Object.defineProperty(window, 'innerHeight', { get: () => ih, configurable: true });
      window.dispatchEvent(new Event('resize'));
    };
    A().begin({ tier: 'master', seed: 'scen|layout' });
    await wait(80);
    const g = A().game;
    const b = g.board;
    eq('大师档 9×9', `${g.w}×${g.h}`, '9×9');
    const Cell = en.theme.Cell;

    // Geometry is asserted against arithmetic done here from the same three numbers the renderer
    // is documented to use: a one-sided gutter, a box the panel leaves behind, and a clamp.
    const expectCell = (availW, availH) => {
      const gutter = 30;
      const size = Math.min((availW - gutter) / b.w, (availH - gutter) / b.h);
      return Math.max(Cell.min, Math.min(Cell.max, Math.floor(Math.max(0, size))));
    };
    const check = (label, iw, ih, narrow) => {
      setW(iw, ih);
      const geo = A().view.geo;
      const availW = Math.max(240, narrow ? iw - 60 : $('#view-game').clientWidth - 340);
      const availH = Math.max(240, ih - 250);
      eq(`${label} 格子边长就是盒子算出来的`, geo.cell, expectCell(availW, availH));
      eq(`${label} 画布 CSS 宽 = 格子×列 + 留白`, A().view.canvas.style.width, `${geo.cell * b.w + geo.x}px`);
      eq(`${label} 画布 CSS 高 = 格子×行 + 留白`, A().view.canvas.style.height, `${geo.cell * b.h + geo.y}px`);
      eq(`${label} 留白是单边 30`, geo.x, 30);
      ck(`${label} 格子不小于可点最小值`, geo.cell >= Cell.min, `${geo.cell} < ${Cell.min}`);
      const rect = A().view.canvas.getBoundingClientRect();
      ck(`${label} 画布不出视口`, rect.left >= 0 && rect.right <= realIw + 1 && rect.bottom <= realIh + 1, JSON.stringify({ l: rect.left, r: rect.right, b: rect.bottom, realIw }));
      let misses = 0;
      const bad = [];
      for (let t = 0; t < b.n; t++) {
        const p = clientOf(t);
        const got = A().view.hitCell(p.x, p.y);
        if (got !== t) {
          misses++;
          if (bad.length < 3) bad.push([t, got]);
        }
      }
      eq(`${label} 大棋盘每一格都点得中`, misses, 0);
      return geo;
    };
    const bootGeo = check('桌面', realIw, realIh, realIw <= 900);
    ck('页面没有横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, `${document.documentElement.scrollWidth} vs ${document.documentElement.clientWidth}`);
    const phoneGeo = check('手机宽', 400, 780, true);
    ck('窄屏时格子真的变小了', phoneGeo.cell < bootGeo.cell, `${phoneGeo.cell} vs ${bootGeo.cell}`);
    const tinyGeo = check('最小宽', 320, 480, true);
    ck('小到极限仍然停在可点下限上', tinyGeo.cell >= Cell.min, String(tinyGeo.cell));
    const wideGeo = check('宽屏读数', 1400, 1000, false);
    ck('跨过 900 分界之后用的是另一套盒子', wideGeo.cell !== phoneGeo.cell, `${wideGeo.cell} vs ${phoneGeo.cell}`);
    setW(realIw, realIh);
    eq('恢复窗口尺寸之后几何一模一样', JSON.stringify(A().view.geo), JSON.stringify(bootGeo));

    // A click must land on the cell you see, at the small size, and the picture must agree.
    let target = -1;
    for (let t = 0; t < b.n; t++) if (!b.tree[t] && b.spot[t]) { target = t; break; }
    const neighbour = [...Array(b.n).keys()].find((t) => !b.tree[t] && t !== target && A().valueOf(t) === en.OPEN);
    setW(400, 780);
    await wait(40);
    const paperBefore = cellPixel(target);
    ck('落子前那一格是纸', near(paperBefore, PAPER, 10), JSON.stringify(paperBefore));
    await tap(target);
    eq('按看到的格子就落在那一格', A().valueOf(target), en.TENT);
    ck('帐篷的笔画在那一格里', !near(tentPixel(target), PAPER, 20), JSON.stringify(tentPixel(target)));
    ck('旁边的格没有被一起画上', near(grassCorner(neighbour), PAPER, 10), JSON.stringify({ neighbour, px: grassCorner(neighbour) }));
    // the row number that got the tent wears the "still open" colour, not green
    ck('未定数字的圈不是绿的', !near(cluePixel(b.rowId((target / b.w) | 0), 'ring'), GREEN, 20), JSON.stringify(cluePixel(b.rowId((target / b.w) | 0), 'ring')));
    A().undo();
    setW(realIw, realIh);
    await wait(40);
    ck('撤掉之后那一格回到纸色', near(cellPixel(target), PAPER, 10), JSON.stringify(cellPixel(target)));
    eq('撤销之后点得中的还是它', A().view.hitCell(clientOf(target).x, clientOf(target).y), target);
    // the gutter is for numbers: a row clue sits whole inside the canvas
    const rp = A().view.rowPoint(0);
    const rad = Math.min(14, A().view.geo.cell * Cell.nodeScale);
    ck('行数字完整落在画布里', rp.x - rad >= 0 && rp.y - rad >= 0, JSON.stringify({ rp, rad }));
    ck('列数字完整落在画布里', (() => { const p = A().view.colPoint(0); return p.x - rad >= 0 && p.y - rad >= 0; })(), JSON.stringify(A().view.colPoint(0)));
    ck('数字画出来了（盘上有亮的字）', (() => {
      const p = A().view.rowPoint(0);
      const d = A().view.geo.dpr;
      const boxData = A().view.ctx.getImageData(Math.round((p.x - 7) * d), Math.round((p.y - 7) * d), Math.round(14 * d), Math.round(14 * d)).data;
      let bright = 0;
      for (let k = 0; k < boxData.length; k += 4) if (boxData[k] + boxData[k + 1] + boxData[k + 2] > 300) bright++;
      return bright >= 4;
    })(), true);

    eq('图例五项', document.querySelectorAll('.legend span').length, 5);
    ck('图例色块与画布同一个颜色', near(hex(cssVar('--info')), BLUE) && near(hex(cssVar('--error')), RED), `${cssVar('--info')}/${cssVar('--error')}`);
    ck('操作提示讲清三种手势', /拖动/.test(text('.keyhint')) && /撤销/.test(text('.keyhint')), text('.keyhint'));
    eq('统计项七条', document.querySelectorAll('.stats .stat').length, 7);
    ck('按钮都够点', [...document.querySelectorAll('.acts button, .modes button, .top-actions button')].every((x) => x.getBoundingClientRect().height >= 28), [...document.querySelectorAll('.acts button')].map((x) => x.getBoundingClientRect().height).join(','));
    ck('顶部按钮不重叠', (() => {
      const bs = [...document.querySelectorAll('.top-actions button')].map((x) => x.getBoundingClientRect());
      for (let i = 1; i < bs.length; i++) if (bs[i].left < bs[i - 1].right - 1) return false;
      return true;
    })(), true);
    ck('提示框不横向溢出', $('.hint-box').scrollWidth <= $('.hint-box').clientWidth + 1, `${$('.hint-box').scrollWidth} vs ${$('.hint-box').clientWidth}`);
    ck('两支笔的标签写着帐篷与草地', [text('#btn-mode-tent'), text('#btn-mode-grass')].join('/'), '▲ 帐篷/· 草地');

    // Motion: the toggle has to reach the styles that animate, not just a class.
    const dur = () => getComputedStyle($('#btn-undo')).transitionDuration;
    eq('动效全开时有过渡时长', /s$/.test(dur()) && !/^0s/.test(dur()), true);
    $('#btn-motion').click();
    await wait(40);
    eq('按下「动效 省」之后过渡时长归零', dur(), '0s');
    ck('body 挂着 reduce-motion', document.body.classList.contains('reduce-motion'));
    $('#btn-motion').click();
    await wait(40);
    eq('再点一次动效回来了', /s$/.test(dur()) && !/^0s/.test(dur()), true);
    // The system preference is a floor the toggle cannot lift, so an OS asking for less motion
    // must win even while the in-game setting says 全.
    const realMM = w.matchMedia;
    w.matchMedia = (q) => ({ matches: /reduced-motion/.test(q), media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    $('#btn-sound').click();
    await wait(40);
    eq('系统要求省动效时 body 立刻挂上', document.body.classList.contains('reduce-motion'), true);
    eq('而存档里的开关没被系统改写', JSON.parse(localStorage.getItem('tents.save.v1')).settings.reduceMotion, false);
    eq('过渡仍然真的关掉了', dur(), '0s');
    $('#btn-sound').click();
    w.matchMedia = realMM;
    $('#btn-motion').click();
    await wait(40);
    $('#btn-motion').click();
    await wait(40);
    eq('音效开关回到开', en.Store.setting('sound'), true);
    eq('动效开关回到全', en.Store.setting('reduceMotion'), false);

    // And the win card, which has to stay inside the board it is announcing.
    A().begin({ tier: 'trainee', seed: 'scen|layout-win' });
    await wait(60);
    const g2 = A().game;
    const der2 = en.solve(g2.board).derived;
    A().stroke(tentsOf(der2), en.TENT);
    A().stroke([...Array(g2.board.n).keys()].filter((t) => !g2.board.tree[t] && der2[t] === en.GRASS), en.GRASS);
    await wait(60);
    eq('照解画完就胜利', g2.status, 'won');
    ck('胜利卡居中在棋盘内', (() => {
      const card = $('.win-card').getBoundingClientRect();
      const wrap = $('#board-wrap').getBoundingClientRect();
      return card.left >= wrap.left - 1 && card.right <= wrap.right + 1 && card.top >= wrap.top - 1 && card.bottom <= wrap.bottom + 1;
    })(), JSON.stringify({ c: $('.win-card').getBoundingClientRect(), w: $('#board-wrap').getBoundingClientRect() }));
    ck('胜利按钮点得到', $('#btn-again').getBoundingClientRect().width > 40, $('#btn-again').getBoundingClientRect().width);
    ck('满盘的帐篷画成绿色', near(tentPixel(tentsOf(der2)[0]), GREEN, 8), JSON.stringify(tentPixel(tentsOf(der2)[0])));
    setW(realIw, realIh);
    return report({ cell: bootGeo.cell, phone: phoneGeo.cell, dpr: A().view.geo.dpr });
  };

  w.__ng = { engine, gen, play, hint, stroke, conflict, save, resume, layout };
})(window);
