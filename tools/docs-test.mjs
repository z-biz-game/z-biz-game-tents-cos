#!/usr/bin/env node
// 文档行号对账（fleet 通用腿）：把本仓 *.md 里印着的每一个「路径:行号」读回真文件逐条对账。
// 三条纪律各自对应一次事故，别把它们简化掉：
//   1) 输入集从盘上现数（`git ls-files -z *.md` 列出的全部文档，含子目录；被引文件按整仓走一遍建名索引）
//      ——按手写清单找输入的审计会整批漏掉工作，而它打印的完成读数看着和真核过一样；
//      只扫仓根是同一宗罪的另一种写法：`_docs/`、`docs/` 里的文档从没被读过一次，读数照样绿。
//   2) 引用文法不写死后缀（形状规则）——后缀列成 JS 家族那张名单时，这条腿在 Swift 仓里是哑的，
//      「0 条引用」和「每一条都核过」在纸面上完全一样；
//   3) 每条判据都要证明自己会红——反空转的刀在内存里改写解析输入，不碰盘上任何文件。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'DerivedData', 'build', '.build', 'Pods', 'dist']);
// 下划线开头的目录是这台机器上的暂存/对照副本（24points 的 `_scratch/objver/src/Views/HomeView.swift`
// 与产物里的 `src/Views/HomeView.swift` 同名）：文档写裸文件名时指的是产物那一份，
// 让副本进名字索引就会拿副本的行去判产物——判据红了而文档没错。副本仍可被**带目录的**原样路径命中。
const SCRATCH_DIR = /^_/;
let scratchSkipped = 0;
const PATH_SRC = '[\\w./@+-]+?\\.[A-Za-z][A-Za-z0-9]{0,11}'; // 后缀 = 点 + 字母开头、至多 12 位
// 逗号行号表是 iOS 文档的第三种写法（`GameBoard.swift:197,202,216`）：那是三个指针，
// 只判 197 的那一版把 202/216 整批漏掉——漏认不是漂，是解析器少一条边。
// 表里还能写范围（`…View.swift:230-243, 277-289`，puzzle-suite 的表格就这么写），
// 斜杠也是同一种表的分隔符（`HomeView.swift:147/185/344/379`，tiny-quest 的等宽数字行）：
// 单元格只吃到第一个数字时，277-289 判成"277 一行"、/185/344/379 根本没人判。
const LIST = '(?:\\s*[,，/]\\s*\\d{1,5}(?:\\s*[-–—]\\s*\\d{1,5})?)*';
const CITE_G = new RegExp('`?(' + PATH_SRC + '):(\\d{1,5})(?:\\s*[-–—]\\s*(\\d{1,5}))?(' + LIST + ')?`?', 'g');
const CITE_1 = new RegExp('`?(' + PATH_SRC + '):(\\d{1,5})(?:\\s*[-–—]\\s*(\\d{1,5}))?(' + LIST + ')?`?'); // 内层匹配用非全局版
// 一条匹配展开成若干指针：范围/单行是一根，表里每个单元格各是一根（单元格内可以是范围）
// ——主循环与反空转的刀共用这一个函数
const expandCite = (m) => {
  const arr = [{ a: Number(m[2]), b: Number(m[3] || m[2]), shown: `${m[1]}:${m[2]}${m[3] ? '-' + m[3] : ''}` }];
  for (const cell of (m[4] || '').split(/[,，/]/)) {
    const r = cell.match(/(\d{1,5})(?:\s*[-–—]\s*(\d{1,5}))?/);
    if (!r) continue;
    arr.push({ a: Number(r[1]), b: Number(r[2] || r[1]), shown: `${m[1]}:${r[1]}${r[2] ? '-' + r[2] : ''}` });
  }
  return arr;
};
// 反引号里那段是路径而不是表达式：`src/Models/GameBoard.swift:197,202`（`GameView.swift:346` 消费方）
// 里前一个是路径，把它当表达式就会要求 src/Models/swift 这些词落在被引窗口里——假红。
const PATHISH = new RegExp('^' + PATH_SRC + '(?::[\\d,，\\s-]*)?$');
const isPathish = (s2) => PATHISH.test(s2.trim());
// 反引号里那一段的四种身份：路径 / 点号标识符 / 定址不到的路径形状 / 表达式。
// 以前这里只有 isPathish 一刀切，于是 `window.nim`（`js/main.js:414`）被当成路径整条 continue：
// 锚点既不进「条带指认」也不判——隐形（不是红，是根本没被数到）。2026-10-22 按本地树实测这种前指式
// 有 18 处（8 仓：window.kaku / window.pour / rng.range / Game.setEdge / tier.patience …）。
// 判据换成「能不能定址到盘上的文件」：能定址才是路径；`a.b` 这种不能定址、又符合标识符形状的，
// 是按点号访问的名字，交给下面同一套「接收者查文件、成员词查那几行」的判法。
const DOTTED = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const spanKind = (s2) => {
  const t = s2.trim().replace(/:.*$/, '');
  if (!isPathish(s2)) return 'expr';
  const r = resolve(t);
  if (r.rel || r.why === 'ambiguous') return 'path';
  if (DOTTED.test(t)) return 'dotted';
  return 'unresolved-path';   // 看着像路径又定址不到：由引用那一头（D3/仓外）点名，不当成标识符锚点
};
const IDENT_BEFORE = new RegExp('`([A-Za-z_$][\\w$]{2,})`[ \\t]*(?:（|\\(|→|—|–|-)?[ \\t]*`(?:' + PATH_SRC + '):[\\d-]+`', 'g');
// 后指的间隔词不写死「的」：iOS 文档里同一个形状写成「`path:7` — `ColoringChapter`」「`path:52`、`ItemCategory`」，
// 只认「的」的那一版让这些锚点隐形（漏认的不是漂，是解析器少一条边）
const SEP = '[ \\t]*(?:的|[—–→]|、|，|,|:|：|[\\s]\\-[\\s]|(?<=[\\d`])[ \\t]+)+[ \\t]*';
const IDENT_AFTER = new RegExp('`(?:' + PATH_SRC + '):[\\d-]+`' + SEP + '`([A-Za-z_$][\\w$]{2,}(?:\\.[A-Za-z_$][\\w$]{2,})*)`', 'g');
const IDENT_SPAN = new RegExp('`(' + PATH_SRC + '):(\\d{1,5})[ \\t]+([A-Za-z_$][\\w$]{2,})`', 'g');
const EXPR_BEFORE = new RegExp('`([^`\\n]{3,60}?)`[ \\t]*(?:（|\\()[ \\t]*`(' + PATH_SRC + '):(\\d{1,5})(?:\\s*[-–]\\s*(\\d{1,5}))?`', 'g');
// 点号访问拆接收者与成员（主循环和 D6e 那把刀共用这一个函数）
const splitRecv = (expr, all) => {
  const rm = expr.trim().match(/^([A-Za-z_$][\w$]*)\.[A-Za-z_$]/);
  return (rm && all.includes(rm[1])) ? { recv: rm[1], toks: all.filter((t) => t !== rm[1]) } : { recv: null, toks: all };
};
const STOP = /[。！？；]/;
const FENCE = /^\s*(```|~~~)/;
// 代码块里印的是「转写」（终端输出、生成文件片段 `project.pbxproj:19`），不是指向本仓的指针：整段跳过。
// 闭合与未闭合都要判出来——少一条 ``` 会把后面整片文档吞进块里，那种文档要自己点名。
const fenceMask = (lines) => {
  const mask = new Array(lines.length).fill(false);
  let open = -1;
  lines.forEach((l, i) => {
    if (!FENCE.test(l)) { if (open >= 0) mask[i] = true; return; }
    mask[i] = true;
    if (open < 0) open = i; else open = -1;
  });
  return { mask, unclosed: open < 0 ? null : open + 1 };
};

// 被引文件的名字索引：整仓走一遍（iOS 文档习惯只写 `FocusSession.swift:129`，不带目录）
const byName = new Map();
const walk = (dir, depth) => {
  if (depth > 6) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (SKIP_DIRS.has(e.name) || SCRATCH_DIR.test(e.name) || e.name.endsWith('.xcodeproj') || e.name.endsWith('.xcworkspace')) {
      if (SCRATCH_DIR.test(e.name)) { try { scratchSkipped += fs.readdirSync(abs).length; } catch { scratchSkipped++; } }
      continue;
    }
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, depth + 1);
    else {
      const rel = path.relative(ROOT, abs);
      if (!byName.has(e.name)) byName.set(e.name, []);
      byName.get(e.name).push(rel);
    }
  }
};
walk(ROOT, 0);

const cache = new Map();
const linesOf = (rel) => {
  const abs = path.join(ROOT, rel);
  if (!cache.has(rel)) cache.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n') : null);
  return cache.get(rel);
};
// 原样给的路径优先；只写了文件名时按名索引解；同名多份 = 歧义（不挑一个判绿，而是每个候选都判）
const resolve = (rel) => {
  if (linesOf(rel)) return { rel, why: 'exact' };
  const cand = byName.get(path.basename(rel)) || [];
  if (cand.length === 1) return { rel: cand[0], why: 'name' };
  if (cand.length > 1) return { rel: null, why: 'ambiguous', cand };
  // 首段在本仓不存在、且这个名字在整仓索引里也没有 → 这条引用指的本来就不是本仓的文件
  // （Apple 库、SDK、别的仓的栈帧）。写成"定址失败"会把文档里合法的库引用判成漂；
  // 名字在仓里有（哪怕目录写错）就不算这一类，仍然红——那是真的指不回实处。
  const top = rel.split('/')[0];
  if (rel.includes('/') && top !== '.' && top !== '..' && !fs.existsSync(path.join(ROOT, top)))
    return { rel: null, why: 'outside' };
  return { rel: null, why: 'missing' };
};
// 一条引用可能对应多份实体文件（歧义）：返回全部候选，判据对每个都跑，一个不过就红
const targets = (rel) => {
  const r = resolve(rel);
  if (r.rel) return { list: [r.rel], why: r.why };
  if (r.why === 'ambiguous') return { list: r.cand, why: r.why };
  return { list: null, why: r.why };
};
// 一条引用的落点判定只有一个函数：主循环用它，反空转的刀也用它（刀若另写一份判据，就等于没验主循环）
const judge = (rel, a, b) => {
  const src = linesOf(rel);
  if (!src) return 'missing';
  if (a < 1 || b < a || b > src.length) return 'oob';
  const span = src.slice(a - 1, b);
  if (span.every((l) => l.trim() === '')) return 'blank';
  // 整段只有收尾符号（`}` / `);` / `],`）也是空落点：那一行不承载文档的说法。
  // 实测两处真漂都是这一类（nursery 指 HomeView.swift:93、ludo 指 GameViewModel.swift:386，各是一行 `}`），
  // 而 blank 判据放过它们 —— 空行只挡了"整段是空白"这一半。
  if (span.every((l) => /^[\s)\]},;]+$/.test(l))) return 'punct';
  return 'ok';
};
// 只给 FAIL 行取证人（那一行原本长什么样），不是一套新判据
const spanOf = (rel, a, b) => (linesOf(rel) || []).slice(a - 1, b).map((l) => l.trim());
// 续引：同一句里省掉路径的裸「:NN」。反引号不算阻隔（`title` `:59` 就是文档的写法，
// 把它挡在lookbehind 外面时这类续引一条都认不到，而读数看着仍像核过整句）。
const BARE_CONT = /(?<![\w./:=,-]):(\d{1,5})(?:\s*[-–]\s*(\d{1,5}))?/g;
// 取数与判据共用这两个函数：主循环用它们，反空转的 D6g 也用它们（刀另写一份就等于没验主循环）
const contPointers = (seg) => [...seg.matchAll(BARE_CONT)]
  .map((x) => ({ index: x.index, a: Number(x[1]), b: Number(x[2] || x[1]), shown: x[0].slice(1) }));
// 借的是「这个裸号之前最近的一处路径引用」，不是这一句里的第一处：
// 一行表格常有两条路径（`TTProgress.swift:78`、`CampaignView.swift:182`、`:278`），
// 认成第一处就会拿 A 文件的行数去判 B 文件的行号，越界是判据编出来的。
const ownerFor = (cites, idx) => {
  let best = null;
  for (const c of cites) { if (c.index < idx && (!best || c.index > best.index)) best = c; }
  return best;
};
const wholeIn = (name, text) =>
  new RegExp('(^|[^\\w$])' + name.replace(/\$/g, '\\$') + '([^\\w$]|$)').test(text);

let docsFrom = '';
const docs = (() => {
  // 输入集 = 被 git 跟踪的全部 .md（去掉 changelog / license 这类不承载说法的），**不是"躺在仓根的那几份"**。
  // 只扫仓根会让住在 `_docs/`、`docs/` 里的文档静默出局：纸面上"引用很密"，那一片闸却从没读过一次
  // （fleet 里 nikoli 丢 3 份中的 2 份、zebra 整份 DESIGN 没进账，两条读数都仍打印绿）。
  // 走 git 而不是自己遍历目录还有第二个理由：`_` 开头的目录在名字索引里是暂存副本要跳过，
  // 而 `_docs/` 里躺的是真文档——只有跟踪清单分得清这两者。
  let tracked = null;
  try {
    tracked = execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0').filter((f) => f && !/changelog|license|contributing/i.test(f));
  } catch { tracked = null; }
  if (tracked === null) {
    docsFrom = 'git ls-files 失败（这里不是 git 工作树？），退回仓根扫描——D1 会红，不会让缩小的输入集读成绿';
    return fs.readdirSync(ROOT).filter((f) => f.endsWith('.md')).sort();
  }
  docsFrom = 'git ls-files';
  return tracked.filter((f) => fs.existsSync(path.join(ROOT, f))).sort();
})();
const bad = [];
let refs = 0, judged = 0, cross = 0, anchored = 0, cont = 0, byNameHits = 0, unaddr = 0, ambig = 0;
const anchorSet = new Set();

let fencedRefs = 0, allPointers = 0; const unclosedFences = []; const maskByDoc = {};
for (const doc of docs) {
  const text = fs.readFileSync(path.join(ROOT, doc), 'utf8').split('\n');
  const fm = fenceMask(text);
  if (fm.unclosed) unclosedFences.push(`${doc}:${fm.unclosed}`);
  maskByDoc[doc] = fm.mask;
  text.forEach((line, idx) => {
    const site = `${doc}:${idx + 1}`;
    const nPts = [...line.matchAll(new RegExp(CITE_G.source, 'g'))].reduce((n, mm) => n + expandCite(mm).length, 0);
    allPointers += nPts;
    if (fm.mask[idx]) { fencedRefs += nPts; return; }
    for (const m of line.matchAll(CITE_G)) {
      const rel = m[1];
      if (rel.split('/')[0].startsWith('z-biz-game-')) { refs++; cross++; continue; }
      const t = targets(rel);
      if (!t.list) {
        for (const sp of expandCite(m)) { refs++; if (t.why === 'outside') { cross++; continue; } unaddr++; bad.push(`${site} 引用 ${sp.shown} 定址不到（本仓没有这个文件）`); }
        continue;
      }
      if (t.why === 'name') byNameHits++;
      if (t.list.length > 1) ambig++;
      // 歧义时每个候选都要过：文档只写了文件名，那"无论作者指的是哪一份都成立"才算指回实处
      for (const sp of expandCite(m)) {
        refs++; judged++;
        for (const rel2 of t.list) {
          const verdict = judge(rel2, sp.a, sp.b);
          if (verdict === 'oob') {
            bad.push(`${site} 引用 ${rel2}:${sp.a}${sp.b !== sp.a ? '-' + sp.b : ''} 越界（该文件共 ${linesOf(rel2).length} 行）`);
          } else if (verdict === 'blank') {
            bad.push(`${site} 引用 ${rel2}:${sp.a}${sp.b !== sp.a ? '-' + sp.b : ''} 那几行整段是空行`);
          } else if (verdict === 'punct') {
            bad.push(`${site} 引用 ${rel2}:${sp.a}${sp.b !== sp.a ? '-' + sp.b : ''} 那几行整段只有收尾符号（${spanOf(rel2, sp.a, sp.b).join(' ')}）`);
          }
        }
      }
    }
    // 锚点三种写法都要认（只认一种时，另一种写法的仓里锚点是隐形 0 条，判据照样绿）
    for (const [re, shape] of [[IDENT_BEFORE, 'NAME（path:NN）'], [IDENT_AFTER, 'path:NN 的 NAME'], [IDENT_SPAN, 'path:NN NAME（同一个 code span）']]) {
      for (const m of line.matchAll(re)) {
        const name = re === IDENT_SPAN ? m[3] : m[1]; // IDENT_SPAN 的路径是 1、行号 2、名字 3；其余三式名字在 1
        const cm = m[0].match(CITE_1);
        if (!cm) continue;
        anchored++;
        anchorSet.add(site + '@' + (m.index + m[0].search(CITE_1)));
        const t = targets(cm[1]);
        if (!t.list) {
          if (t.why !== 'outside') bad.push(`${site} 锚点 ${name} 的 ${cm[1]} 定址不到`);
          continue;
        }
        // 后指式的名字现在允许点号（`js/main.js:414` 的 `window.nim`）：同一套 splitRecv 判法，
        // 成员词进窗口、接收者查文件。单标识符那条老路一字不改（消息文案被台账引用着）。
        const all = [...new Set((name.match(/[A-Za-z_$][\w$]{2,}/g) || []))];
        const { recv: recvName, toks } = name.includes('.') ? splitRecv(name, all) : { recv: null, toks: [name] };
        // 歧义时每个候选都要含这个名字：只写文件名就意味着"哪一份都得对"
        for (const rel2 of t.list) {
          const src = linesOf(rel2);
          const a = Number(cm[2]), b = Number(cm[3] || cm[2]);
          const win = src.slice(Math.max(0, a - 1), Math.min(src.length, b + 2)).join('\n');
          if (!name.includes('.')) {
            if (!new RegExp('(^|[^\\w$])' + name.replace(/\$/g, '\\$') + '([^\\w$]|$)').test(win)) {
              bad.push(`${site} 引用 ${rel2}:${a}${b !== a ? '-' + b : ''} 那几行里没有 ${name}（整词）`);
            }
            continue;
          }
          const miss = toks.filter((x) => !new RegExp('(^|[^\\w$])' + x.replace(/\$/g, '\\$') + '([^\\w$]|$)').test(win));
          if (recvName && !new RegExp('(^|[^\\w$])' + recvName.replace(/\$/g, '\\$') + '([^\\w$]|$)').test(src.join('\n'))) miss.push(recvName + '（接收者不在这个文件里）');
          if (miss.length) bad.push(`${site} 引用 ${rel2}:${a}${b !== a ? '-' + b : ''} 那几行里没有 ${miss.join('、')}（点号锚点要求逐词在）`);
        }
      }
    }
    // 表达式锚点：iOS 文档写的是「用 `steps > 0 || focusSeconds > 0`（`FocusSession.swift:193`）」，
    // 引号里是一段带空格/运算符的代码而不是一个标识符 —— 取其中所有标识符，逐个要求出现在被指范围
    for (const m of line.matchAll(EXPR_BEFORE)) {
      const expr = m[1];
      const kind = spanKind(expr);
      if (kind === 'path' || kind === 'unresolved-path') continue;  // 那是路径不是表达式（见 PATHISH/spanKind）
      if (/^[A-Za-z_$][\w$]*$/.test(expr.trim())) continue; // 单个标识符已被上面两式认走
      const all = [...new Set((expr.match(/[A-Za-z_$][\w$]{2,}/g) || []))];
      // 点号访问的接收者是类型名，不是那一行里的词：`Card24Engine.deal(level:)`（`Card24Engine.swift:37`）
      // 要求 37 行同时印出 Card24Engine 就永远红——类型名住在文件名/文件头。拆成两头判：
      // 成员词必须在被引那几行里，接收者必须在**这个文件**里（在别处也算漂，D6e 那把刀证这条会红）。
      const { recv: recvName, toks } = splitRecv(expr, all);
      if (!toks.length) continue;
      anchored++;
      anchorSet.add(site + '@' + (m.index + m[0].search(CITE_1)));
      const t = targets(m[2]);
      if (!t.list) {
        if (t.why !== 'outside') bad.push(`${site} 表达式锚点 「${expr}」 的 ${m[2]} 定址不到`);
        continue;
      }
      for (const rel2 of t.list) {
        const src = linesOf(rel2);
        const a = Number(m[3]), b = Number(m[4] || m[3]);
        const win = src.slice(Math.max(0, a - 1), Math.min(src.length, b + 2)).join('\n');
        const miss = toks.filter((x) => !new RegExp('(^|[^\\w$])' + x.replace(/\$/g, '\\$') + '([^\\w$]|$)').test(win));
        if (recvName && !new RegExp('(^|[^\\w$])' + recvName.replace(/\$/g, '\\$') + '([^\\w$]|$)').test(src.join('\n'))) miss.push(recvName + '（接收者不在这个文件里）');
        if (miss.length) bad.push(`${site} 引用 ${rel2}:${a}${b !== a ? '-' + b : ''} 那几行里没有 ${miss.join('、')}（表达式锚点要求逐词在）`);
      }
    }
    // 续引：同一句里省掉路径的「:NN」，借它之前最近的一个能定址的文件名
    const segs = line.split(STOP);
    for (const seg of segs) {
      const cites = [...seg.matchAll(new RegExp(CITE_G.source, 'g'))];
      if (!cites.length) continue;
      for (const cp of contPointers(seg)) {
        const owner = ownerFor(cites, cp.index);
        if (!owner) continue;                       // 裸号在所有路径引用之前：没有可借的主语，不收
        const r = resolve(owner[1]);
        if (!r.rel) continue;
        cont++;
        // 借到文件名之后必须和主引用走同一条 judge()：只计数不读回真文件的话，
        // 「N 条续引」这句读数里每一条都没人核过（sudoku 的 `:59`/`:69` 就是这样漏掉的）。
        refs++; judged++;
        const verdict = judge(r.rel, cp.a, cp.b);
        if (verdict === 'oob') bad.push(`${site} 续引 ${r.rel}:${cp.shown} 越界（该文件共 ${linesOf(r.rel).length} 行）`);
        else if (verdict === 'blank') bad.push(`${site} 续引 ${r.rel}:${cp.shown} 那几行整段是空行`);
        else if (verdict === 'punct') bad.push(`${site} 续引 ${r.rel}:${cp.shown} 那几行整段只有收尾符号（${spanOf(r.rel, cp.a, cp.b).join(' ')}）`);
      }
    }
  });
}

const fails = [];
const rows = [];
const gate = (name, pass, detail) => {
  rows.push(`${pass ? '  ok   ' : '  FAIL '}${name} · ${detail}`);
  if (!pass) fails.push(name);
};

gate('D1 输入集非空（文档份数从 git 跟踪清单现数，含子目录；写死文件名或只扫仓根都算这条红）',
  docs.length >= 1 && docsFrom === 'git ls-files', `${docsFrom} · ${docs.length} 份：${docs.join(' ')}`);
gate('D2 引用解析数（解析到 0 条＝文法或引用格式改了，不是"本仓没有引用"）', refs >= 1, `解析 ${refs} 条`);
// 这条判据认的是「块内那几行的读数根本没进判据」：拿 bad 里每条点名的行号回查 mask——
// 把跳过那句关掉，块内指针就会既进 refs 又进 bad，bad 的行号落在 mask 为真的行上，等式和这条同时破。
const maskedBad = bad.filter((b) => {
  const mm = b.match(/^(\S+\.md):(\d+) /);
  return mm && maskByDoc[mm[1]] && maskByDoc[mm[1]][Number(mm[2]) - 1];
});
gate('D3b 代码块内不参与对账（转写不是仓库指针），未闭合的 ``` 必须点名',
  unclosedFences.length === 0 && refs + fencedRefs === allPointers + cont && maskedBad.length === 0,
  `解析 ${allPointers + cont} 个指针（${allPointers} 个带路径 + ${cont} 个续引） = 块外判 ${refs} + 块内跳过 ${fencedRefs}，块内行号进了判据的有 ${maskedBad.length} 条${unclosedFences.length ? '；未闭合：' + unclosedFences.join(', ') + '（后面整片都被算进块里）' : '；每份文档的围栏都成对'}`);
(() => {
  const ok = fenceMask(['a', '```', 'b', '```', 'c']);
  const bad = fenceMask(['```', 'x']);
  gate('D3c 反空转：合成五行里块内那条必须被跳过、块外两条必须参与，未闭合的围栏要报出行号',
    !ok.mask[0] && ok.mask[2] && !ok.mask[4] && ok.unclosed === null && bad.unclosed === 1,
    `合成 ['a','\`\`\`','b','\`\`\`','c'] 判出第 3 行在块内、1/5 行在块外且无未闭合；合成 ['\`\`\`','x'] 必须报未闭合在第 1 行`);
})();
gate('D3 每一条引用都定址并读回真文件（越界、整段空行、同名歧义没一份过、锚点漏认都在这条红）', bad.length === 0,
  bad.length ? `指不回实处的 ${bad.length} 处：${bad.slice(0, 5).join(' | ')}`
             : `判了 ${judged} 条（其中 ${byNameHits} 条按名索引解出、${ambig} 条同名多份且每份都过）· 仓外只计数 ${cross} 条 · 无法定址 ${unaddr} 处 · 名字索引跳过暂存副本 ${scratchSkipped} 项`);
gate('D4 四个桶之和等于解析条数（每一条都必须落进一个桶，不许静默跳过）',
  judged + cross + unaddr === refs,
  `解析 ${refs} = 判 ${judged} + 仓外 ${cross} + 无法定址 ${unaddr}`);
// 锚点这一头的两条纪律：
//   · 解析器会不会漏式，由 D5a 的合成靶子证明（不依赖本仓恰好写了哪种形状）；
//   · 本仓认到的条数会印进文档并由 D7 抄写台账钉住：解析式一旦退化，条数当场和文档不符。
// 曾经试过第三条「引用旁边贴着裸标识符却没被认走」的同段式漏认探针，实测假红成片
// （baby-learn 一仓 15 处，全是同一表格行里相邻的另一个 code span）：锚点关系不是距离关系，撤掉。
const shapeHits = (txt) => [IDENT_BEFORE, IDENT_AFTER, EXPR_BEFORE]
  .filter((re) => new RegExp(re.source, 'g').test(txt)).length;
const CTRL = '用 `fooBar`（`FocusSession.swift:193`）与 `FocusSession.swift:193` 的 `fooBar`'
  + '与 `FocusSession.swift:193` — `fooBar` 与 `steps > 0 || focusSeconds > 0`（`FocusSession.swift:193`）';
gate('D5a 反空转：三种锚点写法各给一个合成靶子，同一套正则必须三式都认到', shapeHits(CTRL) === 3,
  `合成一行含三式（前指（）、后指的/破折号、表达式），认到 ${shapeHits(CTRL)}/3（少于 3 是解析器漏式，不是本仓没写）`);

const CTRL2 = '`GameBoard.swift:197,202,216`（`GameView.swift:346` 消费方）';
const c2 = [...CTRL2.matchAll(new RegExp(CITE_G.source, 'g'))];
const CTRL3 = '`KidsPuzzle_CampaignGameView.swift:230-243, 277-289`';
const c3 = [...CTRL3.matchAll(new RegExp(CITE_G.source, 'g'))];
const e3 = c3.length ? expandCite(c3[0]) : [];
const CTRL4 = '`HomeView.swift:147/185/344/379`';
const c4 = [...CTRL4.matchAll(new RegExp(CITE_G.source, 'g'))];
gate('D5b 反空转：行号表要逐格展开（逗号格、斜杠格、格内带范围），路径形状的反引号不许被认成表达式',
  c2.length === 2 && expandCite(c2[0]).length === 3 &&
  expandCite(c2[0]).slice(1).every((x) => x.a === x.b) &&
  c3.length === 1 && e3.length === 2 && e3[0].a === 230 && e3[0].b === 243 && e3[1].a === 277 && e3[1].b === 289 &&
  c4.length === 1 && expandCite(c4[0]).length === 4 &&
  isPathish('src/Models/GameBoard.swift:197,202,216') && !isPathish('steps > 0 || focusSeconds > 0'),
  `三式合成靶子：逗号表认到 ${c2.length} 处、第一处展开 ${c2.length ? expandCite(c2[0]).length : 0} 根（197、202、216 各一根）；`
  + `「230-243, 277-289」展开 ${e3.length} 根（${e3.map((x) => `${x.a}-${x.b}`).join(' + ') || '没有'}，第二根必须是范围不是单行）；`
  + `「147/185/344/379」展开 ${c4.length ? expandCite(c4[0]).length : 0} 根；`
  + '且「`src/…swift:197,202,216`」判为路径、「`steps > 0 || focusSeconds > 0`」判为表达式');

// 身份判定的每一向都要有合成靶子：拿本仓真文件当靶子时，仓里一旦没有某种形状，读数看着仍像测过。
// 这一条防的是 D5b 那次修反方向时留的洞——isPathish 一刀切会把 `window.nim` 这类点号标识符
// 判成路径并整条丢掉（隐形 0 条锚点），分类器换名不换病。
gate('D5c 反空转：span 身份按「能否定址到盘上的文件」判——能定址才是路径，定址不到的 `a.b` 是锚点',
  (() => {
    cache.set('ctrl/path/Holder.mjs', ['const a = 1;']);   // 合成一份"盘上的文件"，不依赖本仓恰好有什么
    const p = spanKind('ctrl/path/Holder.mjs:12');
    const p2 = spanKind('ctrl/path/Holder.mjs');
    const d = spanKind('window.ctrlHolderZz');
    const d2 = spanKind('rng.ctrlRangeZz.range');
    const e = spanKind('steps > 0 || focusSeconds > 0');
    const u = spanKind('src/ctrl/Nope_zz.swift:197,202');
    // 后指式的名字捕获也要吃得到点号：上一版只允许单标识符，`path:NN` 的 `a.b` 一样隐形
    const af = [...'`js/ctrl/main.mjs:414` 的 `window.ctrlHolderZz`'.matchAll(new RegExp(IDENT_AFTER.source, 'g'))];
    cache.delete('ctrl/path/Holder.mjs');
    return p === 'path' && p2 === 'path' && d === 'dotted' && d2 === 'dotted' && e === 'expr' && u === 'unresolved-path'
      && af.length === 1 && af[0][1] === 'window.ctrlHolderZz';
  })(),
  '合成六个 span + 一条后指式：`ctrl/path/Holder.mjs:12` 与去掉行号的同一份都判 path、`window.ctrlHolderZz` 与三段点号判 dotted、'
  + '带运算符的判 expr、盘上没有又带斜杠的 `src/ctrl/Nope_zz.swift:197,202` 判 unresolved-path、'
  + '「`js/ctrl/main.mjs:414` 的 `window.ctrlHolderZz`」必须把带点的整个名字捕获到（七向缺一即分类器或文法漏边）');

// 反空转：刀在内存里改判据的输入，不碰盘上任何文件（改文件就挪行号，会把别的判据一起带漂）。
// 这三把刀都打 judge()/wholeIn() 这两个「和主循环同一个函数」，靶子由合成输入给出：
// 拿本仓内容当靶子的话，仓里一旦没有连续空行，刀就没有靶子，而读数看着仍像测过。
(() => {
  const local = [];
  for (const doc of docs) {
    for (const m of fs.readFileSync(path.join(ROOT, doc), 'utf8')
      .matchAll(new RegExp('(' + PATH_SRC + '):(\\d{1,5})', 'g'))) {
      const r = resolve(m[1]);
      if (r.rel) local.push({ doc, rel: r.rel, line: Number(m[2]) });
    }
  }
  if (!local.length) { gate('D6 刀需要靶子：本仓至少有一条能定址的真引用', false, '一条都没有'); return; }
  const pick = local[0];
  const src = linesOf(pick.rel) || [];
  const total = src.length;
  // ok 方向用合成内容：拿真文件当"界内应判 ok"的靶子时，一旦那一行本身是空行/越界，
  // 这把刀会红成"刀不通"，而真正发生的是文档那一处本来就漂（两件事要分开报）。
  gate('D6a 反空转：真文件推到末尾之外必须给 oob、合成内容界内必须给 ok、名字不在盘上必须给 missing',
    judge(pick.rel, 1, total + 5) === 'oob' &&
    (() => { cache.set('__ok_control__', ['p', 'q']); const v = judge('__ok_control__', 2, 2); cache.delete('__ok_control__'); return v === 'ok'; })() &&
    judge('__no_such_file_zz__.swift', 1, 1) === 'missing',
    `${pick.rel} 共 ${total} 行：指到 1-${total + 5} 判 oob；合成 ['p','q'] 第 2 行判 ok；不存在的文件名判 missing（三个方向都得对）`);
  gate('D6b 反空转：合成一段真有连续空行的内容，同一个 judge() 必须给出 blank',
    (() => {
      cache.set('__blank_control__', ['x', '', '', 'y']);
      const v = judge('__blank_control__', 2, 3);
      cache.delete('__blank_control__');
      return v === 'blank';
    })(),
    `judge() 在合成内容 ['x','','','y'] 的第 2-3 行上必须返回 blank（靶子由合成给出，不依赖本仓恰好有空行）`);
  gate('D6f 反空转：合成一段只有收尾符号的内容必须给 punct，掺进一行真代码必须给 ok（这条判据不能太宽）',
    (() => {
      cache.set('__punct_control__', ['x', '  }', ');', ']  ,', 'y']);
      const a = judge('__punct_control__', 2, 4);
      const b = judge('__punct_control__', 2, 5); // 第 5 行是 'y'（真内容）→ 不能算 punct
      const c = judge('__punct_control__', 1, 1); // 第 1 行 'x' → ok，别把整类判据误接成"含 ok 也红"
      cache.delete('__punct_control__');
      return a === 'punct' && b === 'ok' && c === 'ok';
    })(),
    '合成内容 [x, "  }", ");", "]  ,", y]：2-4 判 punct、2-5 判 ok（掺一行真代码就不是空落点）、1-1 判 ok（三个方向都得对）');
  gate('D6g 反空转：续引必须认「`title` `:59`」这种反引号写法、范围式带上界，且借的是之前最近的一处路径引用',
    (() => {
      const seg = '枚举本体：`src/Models/SudokuModels.swift:51`（`title` `:59`、`subtitle` `:64-69`）。';
      const cites = [...seg.matchAll(new RegExp(CITE_G.source, 'g'))];
      const got = contPointers(seg);
      const owner = got.length && cites ? ownerFor(cites, got[0].index) : null;
      // 一行里有两条路径时，裸号必须借它之前那一条（times-table 的表格行就是这么写的）
      const seg2 = '`TTProgress.swift:78 isUnlocked`、`:94 resumeLevel`、`CampaignView.swift:182 chapterSection`、`:278 LevelTile`';
      const cites2 = [...seg2.matchAll(new RegExp(CITE_G.source, 'g'))];
      const own2 = contPointers(seg2).map((x) => (ownerFor(cites2, x.index) || [])[1]);
      return cites.length === 1 && got.length === 2 && got[0].a === 59 && got[0].b === 59
        && got[1].a === 64 && got[1].b === 69 && owner && owner[1] === 'src/Models/SudokuModels.swift'
        && own2.join(',') === 'TTProgress.swift,CampaignView.swift';
    })(),
    '合成两段：:59 与范围 :64-69 各成一根、借到前面那份文件；两条路径混排那段里 :94 借第一份、:278 借第二份（借错就会拿另一份的行数判越界）');
  gate('D6e 反空转：`Card24Engine.deal(level:)` 必须拆成「接收者 Card24Engine 查文件、deal/level 查那几行」，而 `steps > 0` 这种不带点的不许拆',
    (() => {
      const a = splitRecv('Card24Engine.deal(level:)', ['Card24Engine', 'deal', 'level']);
      const b = splitRecv('steps > 0 || focusSeconds > 0', ['steps', 'focusSeconds']);
      return a.recv === 'Card24Engine' && a.toks.join(',') === 'deal,level' && b.recv === null && b.toks.length === 2;
    })(),
    '合成两式：点号访问那式拆出接收者（成员词才进窗口判据），非点号那式必须原样全部进窗口判据（拆错就把判据放松了）');
  const ctrlWin = 'let ctrlTokenZz = 1;';
  gate('D6c 反空转：整词判据必须一真一假、且前缀不算命中',
    wholeIn('ctrlTokenZz', ctrlWin) && !wholeIn('noSuchSymbolZz', ctrlWin) && !wholeIn('ctrlToken', ctrlWin),
    `合成窗口「${ctrlWin}」里 ctrlTokenZz 判在、noSuchSymbolZz 判漂、只到前缀的 ctrlToken 也必须判漂（三条都得成立）`);
})();

// 抄写台账：文档里印着的本腿读数必须等于本轮实数；「一处都没写」同样红
const docText = docs.map((d) => fs.readFileSync(path.join(ROOT, d), 'utf8')).join('\n');
const claims = [...docText.matchAll(/文档行号对账：(\d+) 份文档 · (\d+) 条引用 · (\d+) 条带指认 · (\d+) 条续引 · (\d+) 条(?:跨仓|仓外)/g)];
gate('D7 抄写台账：文档印的五个读数等于本轮实跑（删掉这句话同样算红）',
  claims.length >= 1 && claims.every((c) => +c[1] === docs.length && +c[2] === refs && +c[3] === anchored && +c[4] === cont && +c[5] === cross),
  `闸数到 ${docs.length} 份 · ${refs} 条 · ${anchored} 指认 · ${cont} 续引 · ${cross} 仓外；文档写了 ${claims.length} 处${claims.length ? '' : '（一处都没写）'}`);

// 接线与执行是两件事：注释里提到这条腿不算被跑
const execish = (txt) => txt.split('\n').filter((l) => !/^\s*(#|\/\/)/.test(l)
  && /docs-test\.mjs/.test(l) && /(?:\bnode\b|subprocess|os\.system|os\.exec|execFile)/.test(l));
const rd = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const ciTxt = rd(path.join(ROOT, '.github', 'workflows', 'ci.yml'));
// 本地整闸入口的名字从盘上现数：cos 那批叫 verify_engine.py / ci.sh / wiring-check.sh，
// iOS 这批叫 verify_levels.py / verify_graph.py / verify_corpus.py，写死任何一个都会把另一批判成"没接线"。
const localCarriers = (() => {
  const named = ['tools/verify_engine.py', 'tools/ci.sh', 'tools/verify.sh', 'package.json', 'Makefile'];
  let inTools = [];
  try {
    inTools = fs.readdirSync(path.join(ROOT, 'tools'))
      .filter((f) => /^(?:verify|check|ci)[\w-]*\.(?:py|sh|mjs)$/.test(f) && f !== 'docs-test.mjs')
      .map((f) => 'tools/' + f);
  } catch { /* 没有 tools/ 目录：本仓没有本地入口这一说 */ }
  return [...new Set([...named, ...inTools])].filter((f) => fs.existsSync(path.join(ROOT, f)));
})();
const wired = localCarriers.filter((f) => execish(rd(path.join(ROOT, f))).length);
gate('D8a 远端接线：ci.yml 里有一行真的执行这条腿（注释里提到路径不算）',
  execish(ciTxt).length >= 1, execish(ciTxt).length ? execish(ciTxt)[0].trim().slice(0, 96) : 'ci.yml 里没有这一行');
gate('D8b 本地接线：本仓的本地入口（名字由盘上现数）里有一行真的执行这条腿',
  wired.length >= 1,
  wired.length ? `${wired.join(' ')} 各 ${execish(rd(path.join(ROOT, wired[0]))).length} 处`
               : `盘上有 ${localCarriers.length} 个本地入口候选（${localCarriers.join(' ') || '一个都没有'}），没有一个调用这条腿`);
gate('D8d 反空转：本地入口候选必须只数盘上真有执行形态的载体（把腿自己排除掉）',
  !localCarriers.includes('tools/docs-test.mjs') &&
  execish('    subprocess.run(["node", "tools/docs-test.mjs"])').length === 1,
  `候选列表=${localCarriers.length} 项，且"一行真调用"必须能数到 1（这条防的是候选里混进腿自己、或 execish 恒零）`);
gate('D8c 反空转：把调用行换成注释后同一套匹配必须归零',
  execish('      # run: node tools/docs-test.mjs\n# see tools/docs-test.mjs\n    subprocess.run(["node", "tools/other.mjs"])').length === 0,
  '注释形态的调用行必须匹配不到');

// 尾闸：文档里 echo 的「N 条判据 / rows: N fail: N」必须是本轮终值。
// D7 只等式化了前五个数，判据条数没人读——加一条判据（这次是 D6f）就会在树里留一个过期数，
// 而过期数比没有数更容易被下一轮当成实测引用。放在所有 gate 之后，所以这里要自己 +1 把本行算进终数。
const docPlain = docs.map((d) => {
  const t = fs.readFileSync(path.join(ROOT, d), 'utf8').split('\n');
  const mk = maskByDoc[d] || [];
  return t.map((l, i) => (mk[i] ? '' : l)).join('\n');   // 代码块里转写的盖章不是本仓的主张
}).join('\n');
const echoOk = (txt, rn, fn) => {
  const s = [...txt.matchAll(/(\d+) 条判据/g)];
  const e = [...txt.matchAll(/rows: (\d+) fail: (\d+)/g)];
  return s.length >= 1 && e.length >= 1
    && s.every((x) => +x[1] === rn) && e.every((x) => +x[1] === rn && +x[2] === fn);
};
const rn = rows.length + 1;
const stamped = [...docPlain.matchAll(/(\d+) 条判据，`?rows: (\d+) fail: (\d+)/g)];
gate('D9 抄写台账（尾闸）：文档 echo 的判据条数与 rows/fail 等于本轮终值（删掉这句盖章同样算红）',
  echoOk(docPlain, rn, fails.length) && !echoOk('__没有盖章__', rn, fails.length) && !echoOk(`9 条判据，rows: 9 fail: 0`, rn, fails.length),
  `本轮终数 ${rn} 条判据、fails=${fails.length}；文档盖章 ${stamped.length ? stamped.map((x) => `${x[1]} 条判据/rows ${x[2]} fail ${x[3]}`).join(' + ') : '一处都没有'}`);

console.log(`文档行号对账：${docs.length} 份文档 · ${refs} 条引用 · ${anchored} 条带指认 · ${cont} 条续引 · ${cross} 条仓外 · ${rows.length} 条判据`);
for (const b of bad.slice(0, 40)) console.log('  [漂] ' + b);
rows.forEach((r) => { if (r.startsWith('  FAIL')) console.log(r); });
console.log(`rows: ${rows.length} fail: ${fails.length}`);
if (fails.length) console.log('  未过：' + fails.join(' | '));
console.log(`RESULT docs-test ok=${fails.length === 0} checks=${rows.length} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
