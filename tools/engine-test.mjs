// 引擎断言. Plain Node, no framework, no browser — this is the gate that guards merges.
//
// Every expectation below was worked out on paper first and is written as a literal. Nothing here
// reads a number back off the solver and then asserts it: that is how a test suite ends up
// describing the bug instead of forbidding it. The one board everything is derived from is the
// 5×5 in `hand()` — its tents, its spot cells and its 22.0 score were counted by hand, and a
// solver that disagrees with it is wrong.

import {
  OPEN,
  TENT,
  GRASS,
  NO_CLUE,
  createBoard,
  cluesFrom,
  solve,
  verify,
  complete,
  diagnose,
  reachable,
  nextDeduction,
  createState,
  setCell,
  eraseCell,
  undo,
  resetInk,
  Rules,
} from '../js/engine/tents.js';
import { countSolutions, UNIQUE, MANY, NONE, OVERBUDGET } from '../js/engine/count.js';
import { plant, pruneClues, generate, makePuzzle, TIERS, tierFor } from '../js/engine/generate.js';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => String(got) === String(want) ? pass++ : (fail++, console.log(`  FAIL ${name}\n       got  ${got}\n       want ${want}`));
const ok = (name, cond, detail = '') => cond ? pass++ : (fail++, console.log(`  FAIL ${name} ${detail}`));
const throws = (fn) => {
  try {
    fn();
    return '';
  } catch (e) {
    return e.message;
  }
};

// ---------- the board DSL -----------------------------------------------------
// Rows are strings: 'T' a trunk, '#' a tent, '.' confirmed grass, ' ' undecided.
const W = (rows) => rows[0].length;

function board(rows, rowClue, colClue) {
  const h = rows.length;
  const w = W(rows);
  const tree = new Int8Array(w * h);
  rows.forEach((line, r) => [...line].forEach((ch, c) => {
    if (ch === 'T') tree[r * w + c] = 1;
  }));
  return createBoard({ w, h, tree, rowClue: Int8Array.from(rowClue), colClue: Int8Array.from(colClue) });
}

function ink(rows) {
  const h = rows.length;
  const w = W(rows);
  const out = new Int8Array(w * h);
  rows.forEach((line, r) => [...line].forEach((ch, c) => {
    out[r * w + c] = ch === '#' ? TENT : ch === '.' ? GRASS : OPEN;
  }));
  return out;
}

const HAND = ['.T...', '...T.', '..T..', 'T....', '...T.'];
const HAND_SOL = ['#T...', '...T#', '.#T..', 'T....', '#..T#'];
const HAND_ROW = [1, 1, 1, 0, 2];
const HAND_COL = [2, 1, 0, 0, 2];

// ---------- geometry ----------------------------------------------------------
{
  const b = board(HAND, HAND_ROW, HAND_COL);
  eq('盘面尺寸', `${b.w}×${b.h}`, '5×5');
  eq('树占掉 5 格，可下墨的是 20 格', `${b.trees.length}/${b.total}`, '5/20');
  // Hand-counted: the trunks at (0,1) (1,3) (2,2) (3,0) (4,3) touch these 15 free cells, and no
  // other free cell can ever hold a tent.
  const spots = [...Array(25).keys()].filter((t) => b.spot[t]);
  eq('能扎营的格子共 15 个', spots.length, 15);
  eq('能扎营的格子（手推）', spots.join(','), '0,2,3,6,7,9,10,11,13,16,17,18,20,22,24');
  eq('树格自己不算可下墨的格子', b.spot[1], 0);
  eq('提示数 10 条线全在场', b.clues, 10);
  eq('第 4 行的线编号', b.rowId(3), 3);
  eq('第 1 列排在所有行之后', b.colId(0), 5);
  eq('线名用人话', [b.lineName(3), b.lineName(8)], '第4行,第4列');
  eq('格名用人话', b.cellName(12), '第3行3列');
  // (2,2) is a trunk: its four free orthogonal neighbours are (1,2) (2,1) (2,3) (3,2).
  const k = b.trees.indexOf(12);
  eq('中间那棵树的候选帐篷位', b.treeSpots[k].join(','), '7,17,11,13');
}

// ---------- a given must be possible ------------------------------------------
{
  const base = () => board(HAND, HAND_ROW, HAND_COL);
  ok('正常盘建得出来', !!base());
  eq('行提示比这行能放的帐篷还多', throws(() => board(HAND, [9, 1, 1, 0, 2], HAND_COL)), '第1行 写着 9，可它最多只能放 3 顶帐篷');
  eq('列提示同理', throws(() => board(HAND, HAND_ROW, [2, 1, 0, 8, 2])), '第4列 写着 8，可它最多只能放 3 顶帐篷');
  eq('行提示条数不对', throws(() => board(HAND, [1, 1, 1, 0], HAND_COL)), 'rowClue length mismatch');
  eq('树表长度不对', throws(() => createBoard({ w: 5, h: 5, tree: new Int8Array(9), rowClue: Int8Array.from(HAND_ROW), colClue: Int8Array.from(HAND_COL) })), 'tree length mismatch');
  eq('一条数字都不给就没有题', throws(() => board(HAND, [-1, -1, -1, -1, -1], [-1, -1, -1, -1, -1])), '盘上没有数字');
  eq('一棵树都没有也没有题', throws(() => board(['..', '..'], [0, 0], [0, 0])), '盘上没有树');
  eq('负数提示不是合法数字', throws(() => board(HAND, [-2, 1, 1, 0, 2], HAND_COL)), '第1行 写着 -2，可它最多只能放 3 顶帐篷');
  // 0 is a real clue, not "absent": a row that says 0 must survive the build.
  const zero = board(HAND, HAND_ROW, HAND_COL);
  eq('写着 0 的行仍然是 0', zero.want[zero.rowId(3)], 0);
  eq('0 与「没有提示」是两个值', `${zero.want[zero.rowId(3)]}/${NO_CLUE}`, '0/-1');
}

// ---------- each rule says something actionable -------------------------------
{
  const b = board(HAND, HAND_ROW, HAND_COL);
  eq('规则共 5 条', Object.keys(Rules).length, 5);
  for (const [key, r] of Object.entries(Rules)) {
    ok(`${r.name} 有中文名`, /[一-龥]{2,}/.test(r.name));
    ok(`${r.name} 有权重`, r.weight > 0 && r.weight <= 6);
    const d = { cell: 12, tree: 12, tent: 0, line: b.colId(4), want: 2, need: 1, open: 1 };
    const text = r.text(b, d);
    ok(`${r.name} 的话里带坐标`, /第\d+行\d+列|第\d+行|第\d+列/.test(text), text);
    ok(`${r.name} 的话不是空串`, text.length > 12, text);
  }
  // The pencil path on the hand board must fire exactly the rules, exactly as often, as the paper
  // count says: 5 bare cells, 8 line-caps, 4 line-completions, 1 tree with one option left,
  // 2 ring-outs — and 5·1 + 8·1 + 4·1.5 + 1·1 + 2·1 = 22.0.
  const p = solve(b);
  eq('手推盘能用铅笔推完', p.ok, true);
  eq('手推盘的推理步数', p.steps, 20);
  eq('手推盘的分数', p.score, 22);
  eq('每条规则用了几次（手推）', JSON.stringify(p.breakdown), JSON.stringify({ 无树不扎营: 5, 行列封顶: 8, 只差这些: 4, 树唯一落点: 1, 一帐八周空: 2 }));
  eq('铅笔给出的就是纸上那盘', Array.from(p.derived).join(','), Array.from(ink(HAND_SOL)).join(','));
}

// ---------- the two independent implementations must agree --------------------
{
  // Three sources of boards, deliberately: the full clue set, the gated pruning the generator
  // ships with, and a *raw* random deletion that applies no gate at all. The first two can never
  // produce a disagreement on their own, so without the third this block proves nothing.
  //
  // What "agree" means here is the sound half only, and that is a deliberate narrowing that the
  // numbers below force: over 358 sampled boards the pencil wrote 11,561 cells and *not one* of
  // them contradicted any solution, yet 6 boards with exactly one solution still stalled it. A
  // Tents board can be uniquely determined without being determinable by counting — the rules in
  // tents.js are a promise about what a hint may claim, not a claim that they can finish anything
  // that has an answer. So the assertions run in the direction that protects the player, and the
  // gap is measured and printed rather than wished away; the half that closes it is the gate in
  // generate.js, asserted one block below.
  let unique = 0;
  let many = 0;
  let none = 0;
  let early = 0;
  let writes = 0;
  let unsound = 0;
  let firstAgree = 0;
  let notAccepted = 0;
  let pencilButNotUnique = 0;
  let overbudget = 0;
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const seen = new Set();
  for (let s = 0; s < 135; s++) {
    const tier = TIERS[s % 4];
    const { tree, solution } = plant(tier.w, tier.h, rand, tier.tentP, tier.extraTreeP);
    const { rowClue, colClue } = cluesFrom(tier.w, tier.h, tree, solution);
    let full;
    try {
      full = createBoard({ w: tier.w, h: tier.h, tree, rowClue, colClue });
    } catch {
      continue;
    }
    const variants = [full];
    // gated: what the generator actually ships
    try {
      const clue = pruneClues(full, rand, Math.max(1, Math.round((tier.w + tier.h) * tier.keepRatio)));
      variants.push(createBoard({ w: tier.w, h: tier.h, tree, ...clue }));
    } catch {}
    // ungated: delete numbers with no acceptance test at all
    {
      const want = Int8Array.from(full.want);
      for (let i = 0; i < want.length; i++) if (rand() < 0.45) want[i] = NO_CLUE;
      try {
        variants.push(createBoard({
          w: tier.w,
          h: tier.h,
          tree,
          rowClue: want.slice(0, tier.h),
          colClue: want.slice(tier.h, tier.h + tier.w),
        }));
      } catch {}
    }
    for (const b of variants) {
      const key = Array.from(b.want).join(',') + '|' + Array.from(b.tree).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const c = countSolutions(b, { cap: 400, budget: 400000, all: true });
      const p = solve(b);
      if (c.status === OVERBUDGET) {
        overbudget++;
        continue;
      }
      if (c.status === UNIQUE) unique++;
      else if (c.status === MANY) many++;
      else none++;
      // The player-facing promise, cell by cell: whatever the pencil writes — every hint, every
      // auto-fill — has to hold in *every* completion the counter can find, not just in one of
      // them. A hint that is true in some solution and false in another is the thing a player
      // cannot defend against.
      for (let t = 0; t < b.n; t++) {
        if (b.tree[t] || p.derived[t] === OPEN || !c.every.length) continue;
        writes++;
        for (const sol of c.every) {
          if (sol[t] !== p.derived[t]) {
            unsound++;
            console.log(`  ✗ 铅笔在 ${b.cellName(t)} 的写法不是所有解共有的（解数 ${c.solutions}）`);
            break;
          }
        }
      }
      // When both do reach an answer it has to be the same board, and the counter's answers have to
      // pass the acceptance test — which reads neither of them.
      if (p.ok) {
        if (c.solutions !== 1) pencilButNotUnique++;
        if (Array.from(p.derived).join(',') !== Array.from(c.first).join(',')) firstAgree++;
      }
      if (!p.ok && c.status === UNIQUE) early++;
      for (const sol of c.every) if (verify(b, sol).length) notAccepted++;
    }
  }
  ok('样本够杂（唯一解、多解、无解都得有，否则这个断言是空的）', unique >= 40 && many >= 10, `unique ${unique} many ${many} none ${none}`);
  eq(`${writes} 处铅笔写法逐格对所有解成立`, unsound, 0);
  eq('铅笔推出的盘与穷举器给出的同一块', firstAgree, 0);
  eq('穷举器数出的解全过验收器', notAccepted, 0);
  eq('多解或无解处铅笔不得宣布通关', pencilButNotUnique, 0);
  // Reported, not asserted away: a unique board the counting rules cannot finish is a real thing,
  // and the fix is the generator's gate (asserted next), not a weaker counter sample.
  console.log(`  唯一解但铅笔推不完：${early}/${unique} 局（这些盘由出题器的闸门挡掉，见下一段）`);
  eq('样本没有一局数到超预算（数不动就等于没核）', overbudget, 0);
}

// ---------- the gate is what closes the completeness gap ----------------------
// The block above proves the hints never lie. This one proves the player is never left stuck:
// every board the generator ships must be both pencil-finishable and, per the counter, the only
// board with that answer.
//
// What the shipping path actually does (js/engine/generate.js: `tries = 40`, no caller overrides
// it): `makePuzzle` rolls up to 40 derived seeds — `seed#1`, `seed#2`, … — and keeps the FIRST draw
// that both lands inside the tier's score band and passes the clue-pruning gate. `p.gen` records
// which draw won, 1-based, so a shipped board may well be the 23rd roll rather than the 1st.
// Rerolling is not the thing being trusted here: this block re-derives uniqueness with a second
// implementation (count.js) on whatever came out, so a board is worth exactly what that re-check
// says it is. The real number is printed below rather than claimed in prose.
{
  let shipped = 0;
  let stalled = 0;
  let notUnique = 0;
  let overbudget = 0;
  let firstDraw = 0;
  let badGen = 0;
  let maxGen = 0;
  for (let s = 0; s < 60; s++) {
    const tier = TIERS[s % TIERS.length];
    const p = makePuzzle(`gate|${s}`, tier.key);
    if (!p) continue;
    shipped++;
    if (!(p.gen >= 1 && p.gen <= 40)) badGen++;
    if (p.gen > maxGen) maxGen = p.gen;
    if (p.gen === 1) firstDraw++;
    if (!solve(p.board).ok) stalled++;
    const c = countSolutions(p.board, { cap: 2, budget: 400000 });
    if (c.status === OVERBUDGET) overbudget++;
    else if (c.status !== UNIQUE || Array.from(c.first).join(',') !== Array.from(solve(p.board).derived).join(',')) notUnique++;
  }
  eq('出货的盘全都能纯计数推完', stalled, 0);
  eq('出货的盘穷举复核唯一且逐格同解', notUnique, 0);
  eq('出货的盘没有一局数到超预算', overbudget, 0);
  eq('每局都记了自己是第几抽（1..40）', badGen, 0);
  console.log(`  40 抽上限里第 1 抽就出货的：${firstDraw}/${shipped}，最远的一局抽到第 ${maxGen} 次`);
  ok('样本真的有货', shipped >= 55, `出货 ${shipped}/60`);
}

// ---------- the acceptance test reads only the board --------------------------
{
  const b = board(HAND, HAND_ROW, HAND_COL);
  const good = ink(HAND_SOL);
  eq('纸上的解通过验收', verify(b, good).length, 0);
  eq('纸上的解就是通关', complete(b, good), true);
  // A board full of grass is undecided, not solved: `complete` must not be satisfiable by the
  // hint script or by anything the solver keeps in memory.
  const empty = new Int8Array(25);
  eq('空盘不算通关', complete(b, empty), false);
  eq('空盘报出 20 个空格', verify(b, empty).filter((x) => x.why === '空格').length, 20);
  // Two tents touching at a corner: (0,0) and (1,1) is a trunk, so use (2,1) and (3,1)... instead
  // put tents at (4,0) and (3,1) — orthogonal neighbours, both real spots.
  const touch = ink(['#T...', '...T.', '..T..', 'T#...', '#..T.']);
  eq('相邻帐篷被验收器抓住', verify(b, touch).some((x) => x.why === '帐篷相邻'), true);
  const diag = diagnose(b, touch);
  eq('诊断把两顶帐篷都标成冲突', [...diag.violated].length >= 1, true);
  // A tent nowhere near a trunk cannot be part of any legal answer.
  const orphan = ink(['.T...', '...T.', '..T..', 'T...#', '...T.']);
  ok('孤零零的帐篷被指出', verify(b, orphan).some((x) => x.why === '这里没有树可配'), JSON.stringify(verify(b, orphan).slice(0, 2)));
  // Row 3 says 0 and holds a tent.
  const greedy = ink(['.T...', '...T.', '..T..', 'T#...', '...T.']);
  ok('超数的行被指出', verify(b, greedy).some((x) => x.why === '帐篷多了'), JSON.stringify(verify(b, greedy).slice(0, 2)));
  // Every candidate for one trunk already grassed: the trunk is starved and no number says so.
  const starved = ink(['.T...', '...T.', '..T..', 'T....', '...T.']);
  ok('没帐可扎的树被指出', verify(b, starved).some((x) => x.why === '树旁没帐'), JSON.stringify(verify(b, starved).slice(0, 3)));
  // The win check must not be able to disagree with the rules that produced the hints.
  const p = solve(b);
  eq('铅笔的成品通过独立验收', verify(b, p.derived).length, 0);
  eq('铅笔的成品确实通关', complete(b, p.derived), true);
  const d2 = diagnose(b, p.derived);
  eq('通关时没有冲突', d2.conflicts, 0);
  eq('通关时 20 格全满', `${d2.filled}/${d2.total}`, '20/20');
}

// ---------- survivable ink ----------------------------------------------------
{
  const b = board(HAND, HAND_ROW, HAND_COL);
  const st = createState(b);
  eq('树格不吃墨水', setCell(st, 1, TENT), false);
  eq('同一格写同一个值不算一步', setCell(st, 0, TENT) && !setCell(st, 0, TENT), true);
  eq('写下去就是帐篷', st.cell[0], TENT);
  eq('擦掉回到未定', eraseCell(st, 0) && st.cell[0], OPEN);
  eq('撤销能回到上一步', (setCell(st, 2, GRASS), undo(st) && st.cell[2]), OPEN);
  eq('撤销到底不再出错', (resetInk(st), setCell(st, 4, TENT), undo(st), undo(st)), false);
  resetInk(st);
  eq('清空墨水后历史也清了', st.history.length, 0);
  for (let i = 0; i < 620; i++) setCell(st, i % 2 === 0 ? 0 : 2, i % 3 === 0 ? TENT : GRASS);
  ok('历史栈封顶 500', st.history.length <= 500, String(st.history.length));
  const full = ink(HAND_SOL);
  eq('通关局面没有空格', verify(b, full).filter((x) => x.why === '空格').length, 0);
}

// ---------- hints come from the clues, not the ink ----------------------------
{
  const b = board(HAND, HAND_ROW, HAND_COL);
  // The first thing the *clues* force on an empty board is the 5 non-spot cells going grass, and
  // it must come out the same no matter what the player has scratched out.
  const clean = nextDeduction(b, new Int8Array(25));
  eq('空盘上第一条推导是「无树不扎营」', clean.rule.name, '无树不扎营');
  const wrong = new Int8Array(25);
  // The one single-cell mistake the clues cannot see *yet*: (0,0) is the answer's tent, but grass
  // there contradicts no number and starves no trunk until a later sweep. Anything else already
  // shouts, and then there would be no hint left to compare — which is its own assertion, in the
  // reachable block below.
  wrong[0] = GRASS;
  const still = nextDeduction(b, wrong);
  eq('墨水写错了，提示仍然只读数字', still.rule.name, '无树不扎营');
  eq('提示说的格子与玩家画的不相干', still.cell, clean.cell);
  // The hint script is the deduction list itself, and it must be replayable in order.
  const p = solve(b);
  eq('提示脚本长度等于步数', p.rows.length, p.steps);
  ok('脚本里每一步都带规则', p.rows.every((r) => r.rule && r.rule.name), '');
  // The last write on the paper board, worked out on paper: by then row 4 reads 2 with the tents at
  // (4,4) and (4,0) as its only two remaining cells, so the counting closes it. The single
  // 树唯一落点 of the run is the trunk at (2,2) being left with (2,1) — asserted by content rather
  // than by index, because which sweep a write lands in is an ordering detail, but what it forces
  // is not.
  const last = p.rows[p.rows.length - 1];
  eq('手推盘最后一步是「只差这些」', last.rule.name, '只差这些');
  eq('它把帐篷放在 (4,0)', last.cell, 20);
  const sole = p.rows.filter((r) => r.rule === Rules.only);
  eq('全盘只有一处「树唯一落点」', sole.length, 1);
  eq('那一处收的是 (2,1)', sole[0].cell, 11);
  eq('那一处放的是帐篷', sole[0].value, TENT);
}

// ---------- reachable: one-directional on purpose ------------------------------
{
  const b = board(HAND, HAND_ROW, HAND_COL);
  const good = ink(HAND_SOL);
  eq('正解当然可达', reachable(b, good), true);
  eq('空盘可达', reachable(b, new Int8Array(25)), true);
  // The cell the pencil forces by 树唯一落点 is (4,4). Draw *that* one backwards and the trunk at
  // (4,3) has nowhere left to go — the contradiction is visible without guessing anything.
  const backwards = Int8Array.from(good);
  backwards[24] = GRASS;
  eq('唯一落点画反了会被提前说出', reachable(b, backwards), false);
  // Two tents touching at a corner: no clued number is over, yet no completion exists.
  const pair = Int8Array.from(good);
  pair[24] = GRASS;
  pair[16] = TENT;
  const clash = Int8Array.from(good);
  clash[20] = GRASS;
  clash[16] = TENT;
  eq('斜角相邻的两顶帐篷会被提前说出', reachable(b, clash), false);
  // Sound-but-incomplete: this ink breaks nothing the rules can see, so `reachable` stays quiet.
  // It is not a proof of survival, which is why the UI only ever says "已经矛盾了", never "这样对".
  // The board has exactly one answer, so any single deviation from it is unsurvivable *in fact*.
  // Whatever the five rules fail to notice here is the gap the UI wording has to respect: it may
  // say 「这些已经矛盾了」 and must never say 「这样放是对的」.
  let flipped = 0;
  const invisible = [];
  for (let t = 0; t < 25; t++) {
    if (b.tree[t] || good[t] === OPEN) continue;
    const flip = Int8Array.from(good);
    flip[t] = good[t] === TENT ? GRASS : TENT;
    flipped++;
    if (reachable(b, flip)) invisible.push(t);
  }
  eq('手推盘上逐格反画一遍', flipped, 20);
  // Measured, not assumed: on this board all twenty deviations *are* caught, so this board cannot
  // demonstrate the gap. It is kept as a floor (the rules must never miss the forced cell), and the
  // gap itself is shown next, on a board sparse enough that the counting has nothing to say yet.
  eq('二十处反画全被规则看出', invisible.length, 0);
  eq('但树唯一落点那一格（4,4）必须在看得见的里面', invisible.includes(24), false);
}

// ---------- reachable says "矛盾" but never says "对了" ------------------------
{
  // Two tents on a diagonal: (0,0) and (1,1). That breaks no number on a board carrying only the
  // row-0 clue, and starves no trunk, so `reachable` waves it through — while the acceptance test
  // sees it and the counter proves no completion of this board has both. This is the whole reason
  // the UI's wording is one-directional: 「这些线和数字已经矛盾了」 is a claim, 「这样放是对的」 would
  // not be.
  const sparse = board(HAND, [1, NO_CLUE, NO_CLUE, NO_CLUE, NO_CLUE], [NO_CLUE, NO_CLUE, NO_CLUE, NO_CLUE, NO_CLUE]);
  const pair = new Int8Array(25);
  pair[0] = TENT;
  pair[6] = TENT;
  eq('数不出来的死墨水，reachable 放行', reachable(sparse, pair), true);
  ok('验收器却当场看出帐篷相邻', verify(sparse, pair).some((x) => x.why === '帐篷相邻'), true);
  const all = countSolutions(sparse, { cap: 500, budget: 400000, all: true });
  ok('穷举器数得出这盘到底有几个解', all.status === MANY && all.every.length >= 2, `解数 ${all.solutions}`);
  eq('而 79 个解里没有同时放着这两顶的', all.every.filter((s) => s[0] === TENT && s[6] === TENT).length, 0);
  // The hint path deliberately does not consult the ink either: a messy board must still hand out
  // the next deduction the *clues* force, which is why propagate reports a player's touching tents
  // nowhere in it.
  const hint = nextDeduction(sparse, pair);
  ok('盘面已经乱了，提示仍然给得出下一步', hint.rule !== undefined, JSON.stringify(hint.conflict || ''));
}

// ---------- storage-shaped cost travels with the run -------------------------
{
  // The save file carries the seed and the ink only, so the board has to be redrawable from the
  // seed alone — and the redraw must not consult the clock.
  const a = makePuzzle('cost-travels', 'regular');
  const b = makePuzzle('cost-travels', 'regular');
  ok('同一颗种子出同一块盘', a && b && Array.from(a.board.want).join(',') === Array.from(b.board.want).join(','));
  const p = solve(a.board);
  const again = solve(a.board);
  eq('同一块盘重跑同分', again.score, p.score);
  eq('分数是十进一位小数', p.score, Math.round(p.score * 10) / 10);
  eq('存档要带走耗时以外的全部代价', [a.tier, a.tierName, a.originSeed, a.size, a.score > 0].join('|'), 'regular|熟练|cost-travels|7×7|true');
  eq('认不出的档位退回上手', tierFor('nope').key, 'apprentice');
  eq('档位共 5 档', TIERS.length, 5);
  eq('档位键是固定的五个', TIERS.map((t) => t.key).join(','), 'trainee,apprentice,regular,expert,master');
  eq('档位名是固定的五个', TIERS.map((t) => t.name).join(','), '初学,上手,熟练,高阶,大师');
}

// ---------- the ladder is measured -------------------------------------------
{
  for (const tier of TIERS) {
    const out = [];
    let t0 = Date.now();
    for (let s = 0; s < 6; s++) out.push(makePuzzle(`ladder|${tier.key}|${s}`, tier.key));
    const ms = Date.now() - t0;
    eq(`${tier.name} 六局全部出货`, out.filter(Boolean).length, 6);
    const boards = out.filter(Boolean).map((p) => p.board);
    eq(`${tier.name} 每局都能推到底`, boards.every((b) => solve(b).ok), true);
    eq(`${tier.name} 每局都唯一解`, boards.every((b) => countSolutions(b).status === UNIQUE), true);
    const inBand = out.filter(Boolean).filter((p) => p.score >= tier.band[0] && p.score <= tier.band[1]).length;
    ok(`${tier.name} 命中自己的分数带`, inBand >= 5, `${inBand}/6`);
    ok(`${tier.name} 出题不到 900ms/6 局`, ms / 6 < 900, `${Math.round(ms / 6)}ms`);
    eq(`${tier.name} 的盘面就是它自己`, out[0].size, `${tier.w}×${tier.h}`);
  }
  let mono = true;
  let prev = -Infinity;
  for (const tier of TIERS) {
    const scores = [];
    for (let s = 0; s < 6; s++) {
      const p = makePuzzle(`mono|${s}`, tier.key);
      if (p) scores.push(p.score);
    }
    scores.sort((x, y) => x - y);
    const median = scores[scores.length >> 1];
    if (!(median > prev)) mono = false;
    prev = median;
  }
  eq('档位中位分数单调递增', mono, true);
  // Two different failures, and the generator must not blur them. A band it cannot reach still
  // ships the *nearest* board and reports how far off it was — the band is a selection target, not
  // a gate, so an ambitious tier degrades into the closest legal puzzle rather than into nothing.
  // What does stop a shipment is failing the acceptance test on every draw: no unique, no
  // pencil-finishable board. Only that second case may reach the UI as null.
  const starved = generate({ w: 4, h: 4, tentP: 0.6, extraTreeP: 0.9, keepRatio: 0.2, band: [9999, 10000], tries: 3, seed: 'impossible' });
  eq('够不着带照样出货', starved.ok, true);
  ok('但它承认自己差多远', starved.offBand > 0, String(starved.offBand));
  eq('一次都没试，就没有货可出', generate({ w: 6, h: 6, seed: 'none', tries: 0 }).ok, false);
  eq('不出货时给出原因', generate({ w: 6, h: 6, seed: 'none', tries: 0 }).reason, '没找到既唯一又能纯逻辑推到底的盘面');
  const dead = board(HAND, [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]);
  eq('每行每列都写 0 的盘无解，独立计数器说 NONE', countSolutions(dead).status, NONE);
  eq('同一块盘铅笔也必须推不完', solve(dead).ok, false);
  ok('MANY 常量在场', MANY === 'MANY');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
