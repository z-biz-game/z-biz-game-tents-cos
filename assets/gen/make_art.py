#!/usr/bin/env python3
"""帐篷 Tents 的美术资产工厂：一条命令把图标、纹理、sprite、社交卡全部重画出来。

    python3 assets/gen/make_art.py            # 全量重建
    python3 assets/gen/make_art.py --check    # 只核对盘上资产的类型/宽高/字节

为什么要在仓里自己写：图标是品牌资产，但母题必须由玩法决定。这盘游戏的视觉母题是
**夜里的营地**——深蓝夜空当纸、细星当噪声、蓝色线描的帐篷（门口一点琥珀）、铅笔灰的树，
和 js/theme.js 里的 Palette 同源（bg-top #080B16 → bg-bottom #131A2E、info #7BB8FF、
accent #FFC85C、pencil-strong #8FA6CC）。形状由 canvas 渲染器 js/render/board.js 里
真实的 drawTent/drawTree 拓扑决定，所以图标和盘面是同一种语言，而不是两张不相干的图。

产出（全部真 PNG，无 0 字节、无 SVG 冒充）：
  assets/icons/icon-{16,32,48,64,96,180,192,512,1024}.png  圆角方母图（1024 是母本）
  assets/icons/maskable-{192,512}.png                      主体缩进 80% 安全区
  assets/icons/favicon-32.png / apple-touch-icon.png       index.html 直接引用
  assets/textures/night-paper-256.png                      可平铺纸纹（画布板面 + CSS 底）
  assets/sprites/{tent,tree,grass,rule-tent-spacing}-128.png  玩法说明/胜利卡里的透明 sprite
  assets/img/og-cover.png                                  1200x630 社交卡

重画像素只依赖 Pillow；不联网、不读仓外文件，同一份脚本在任何机器上画出同样的像素（seed 写死）。
--check 只用标准库（无 Pillow 也能跑），所以它能直接当 CI 的资产闸。

--check 除了核对 IHDR，还核对两件事：色板常量与 js/theme.js 的 Palette 是否仍然同源，以及
index.html / css/game.css / manifest.webmanifest 里引用的每个 assets/*.png 是否真在盘上。
"""
import argparse
import os
import random
import re
import struct
import sys

# --check 只用标准库（读 IHDR + 正则对色板与引用链），所以 Pillow 缺失时它照样能当 CI 的资产闸；
# 只有真的重画像素才需要 Pillow，那份要求在 main() 里按需报出来。
try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:
    Image = ImageDraw = ImageFilter = ImageFont = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SEED = 20261002  # 写死：像素必须可复现，图标不能每次构建都换一副面孔

# js/theme.js Palette 的十六进制值。两边改一边会在这份脚本的 --check 里暴露：
# 它会把源码里实测到的 hex 和这里对一遍。
BG_TOP = (8, 11, 22)
BG_BOTTOM = (19, 26, 46)
SURFACE = (16, 22, 39)
SURFACE_LIFT = (24, 32, 54)
LINE = (36, 48, 80)
LINE_HEAVY = (58, 74, 114)
INK = (242, 245, 251)
ACCENT = (255, 200, 92)
ACCENT_EDGE = (255, 227, 166)
INFO = (123, 184, 255)
PENCIL = (143, 166, 204)
SUCCESS = (61, 220, 145)

ICON_SIZES = [16, 32, 48, 64, 96, 180, 192, 512, 1024]


def mix(a, b, t):
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3))


def rgba(c, a=255):
    return (c[0], c[1], c[2], a)


def w_of(S, px):
    """把 1024 母本上的像素宽度换算到任意边长，且最小保留 1px（16px 图标上 0.5 会变成 0）。"""
    return max(1, int(round(px * S / 1024.0)))


def vertical_gradient(S, top=BG_TOP, bottom=BG_BOTTOM, H=None):
    H = H or S
    img = Image.new('RGB', (S, H))
    for y in range(H):
        img.paste(mix(top, bottom, y / max(1, H - 1)), (0, y, S, y + 1))
    return img


def starfield(S, density, seed, colors=(INK, INFO, ACCENT), H=None):
    """细星：只当噪声用，单颗不超过 2px（母本 1024 上），缩到 16px 自然化掉。"""
    H = H or S
    layer = Image.new('RGBA', (S, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    rnd = random.Random(seed)
    n = int(S * H / 1024 / 1024 * density)
    for _ in range(n):
        x, y = rnd.randrange(S), rnd.randrange(H)
        r = max(1, int(round(rnd.choice([0.8, 1.0, 1.0, 1.6]) * S / 1024.0)))
        c = rnd.choice(colors)
        d.ellipse([x - r, y - r, x + r, y + r], fill=rgba(c, rnd.randint(26, 96)))
    return layer


def rounded_mask(S, radius):
    m = Image.new('L', (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)
    return m


def draw_tree(d, cx, base, size, colour, width):
    """和 js/render/board.js drawTree 同拓扑：一段树干 + 一个圆形树冠。"""
    d.line([cx, base, cx, base - size * 0.42], fill=colour, width=width)
    r = size * 0.26
    cy = base - size * 0.52
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=colour, width=width)


def draw_tent(d, x0, y0, size, colour, width, door=ACCENT):
    """和 drawTent 同拓扑：两杆交于顶点、地线相连、中间一个门。"""
    inset = size * 0.14
    apex = (x0 + size / 2, y0 + inset)
    left = (x0 + inset, y0 + size - inset)
    right = (x0 + size - inset, y0 + size - inset)
    d.line([left, apex, right], fill=colour, width=width, joint='curve')
    d.line([left, right], fill=colour, width=width)
    d.polygon([(apex[0], apex[1] + size * 0.16),
               (apex[0] - size * 0.11, y0 + size - inset),
               (apex[0] + size * 0.11, y0 + size - inset)],
              outline=door, width=max(1, width // 2))


def grid_lines(d, S, n, colour, width):
    step = S / n
    for i in range(1, n):
        d.line([i * step, S * 0.06, i * step, S * 0.94], fill=colour, width=width)
        d.line([S * 0.06, i * step, S * 0.94, i * step], fill=colour, width=width)


def master_icon(S=1024, maskable=False):
    """母图：夜空纸面 + 3x3 网格（这盘游戏的地盘）+ 一顶蓝线帐篷 + 两棵铅笔树 + 琥珀门。"""
    base = vertical_gradient(S).convert('RGBA')
    base = Image.composite(base, Image.new('RGBA', (S, S), (0, 0, 0, 0)),
                          rounded_mask(S, S * (0.22 if not maskable else 0.0)))
    # 主体在 maskable 下缩进 80% 安全区（Android 会裁掉外圈 20%）
    k = 1.0 if not maskable else 0.80

    # 网格：整张盘面的骨架，压到很暗，只当"这是一块棋盘"的暗示
    grid = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid, 'RGBA')
    grid_lines(gd, S, 5, rgba(LINE, 120), max(1, S // 512))
    base = Image.alpha_composite(base, grid)
    base = Image.alpha_composite(base, starfield(S, 46, SEED))
    d = ImageDraw.Draw(base, 'RGBA')

    span = S * (0.44 if maskable else 0.56)
    tx = S / 2 - span / 2
    ty = S * (0.40 if maskable else 0.30)
    draw_tent(d, tx, ty, span, rgba(INFO, 255), w_of(S, 26), door=rgba(ACCENT, 255))
    # 两棵树：帐篷只能扎在树旁边，所以图标里树和帐必须同时出现
    ts = span * 0.62
    draw_tree(d, S * (0.24 if not maskable else 0.30), S * 0.70, ts, rgba(PENCIL, 235), w_of(S, 20))
    draw_tree(d, S * (0.78 if not maskable else 0.72), S * 0.62, ts * 0.8, rgba(PENCIL, 200), w_of(S, 18))
    # 地面线：把三个元素钉在同一块地上
    d.line([S * 0.18, S * 0.72, S * 0.82, S * 0.72], fill=rgba(LINE_HEAVY, 190), width=w_of(S, 10))
    # 高光：左上到右下的极淡斜光，让图标在暗色桌面上不至于是一块死蓝
    sheen = Image.new('L', (S, S), 0)
    ImageDraw.Draw(sheen).ellipse([-S * 0.35, -S * 0.55, S * 0.75, S * 0.45], fill=26)
    hi = Image.new('RGBA', (S, S), rgba(mix(ACCENT_EDGE, INK, 0.5), 255))
    base = Image.composite(hi, base, sheen)
    return base


def build_icons(outdir):
    os.makedirs(outdir, exist_ok=True)
    made = {}
    master = master_icon(1024)
    master.save(os.path.join(outdir, 'icon-1024.png'))
    made['icon-1024.png'] = 1024
    for s in ICON_SIZES:
        if s == 1024:
            continue
        master.resize((s, s), Image.LANCZOS).save(os.path.join(outdir, f'icon-{s}.png'))
        made[f'icon-{s}.png'] = s
    m192 = master_icon(192, maskable=True)
    m512 = master_icon(512, maskable=True)
    m192.save(os.path.join(outdir, 'maskable-192.png'))
    m512.save(os.path.join(outdir, 'maskable-512.png'))
    made['maskable-192.png'] = 192
    made['maskable-512.png'] = 512
    master.resize((180, 180), Image.LANCZOS).save(os.path.join(outdir, 'apple-touch-icon.png'))
    made['apple-touch-icon.png'] = 180
    master.resize((32, 32), Image.LANCZOS).save(os.path.join(outdir, 'favicon-32.png'))
    made['favicon-32.png'] = 32
    master.resize((64, 64), Image.LANCZOS).save(os.path.join(outdir, 'favicon-64.png'))
    made['favicon-64.png'] = 64
    return made


def build_texture(path, S=256):
    """可平铺的夜纸纹理：竖向渐变 + 极淡的斜向纸纹 + 细星。上下左右四个边必须无缝。

    振幅只做到 ±5：画布的格子底色由 js/render/board.js 按 Palette 平铺，纹理只涂在格子之外的
    板面上（tools/scenarios.js 对纸色像素的取样容差是 8~12，压到 ±5 才不会被判成"格子换色了"）。
    """
    rnd = random.Random(SEED + 3)
    img = Image.new('RGBA', (S, S))
    px = img.load()
    for y in range(S):
        t = 0.5 + 0.5 * (y / S)  # 平铺：用 cos 而不是线性，接缝处导数连续
        base = mix(BG_TOP, BG_BOTTOM, 0.35 + 0.35 * (1 - t))
        for x in range(S):
            rib = int(2.5 * ((x + y) % 8 == 0)) + int(1.8 * ((x - y) % 13 == 0))
            jit = rnd.randint(-2, 3)
            c = tuple(max(0, min(255, v + rib + jit)) for v in base)
            px[x, y] = (c[0], c[1], c[2], 255)
    for _ in range(90):
        x, y = rnd.randrange(S), rnd.randrange(S)
        r = rnd.choice([0, 0, 1])
        col = rnd.choice([INK, INFO, ACCENT])
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                if dx * dx + dy * dy > r * r:
                    continue
                xx, yy = (x + dx) % S, (y + dy) % S
                cur = px[xx, yy]
                f = 0.5 if (dx or dy) else 1.0
                px[xx, yy] = tuple(int(cur[i] + (col[i] - cur[i]) * f * 0.28) for i in range(3)) + (255,)
    img.save(path)
    return S


def build_sprites(outdir):
    """透明 sprite：玩法说明与胜利卡用。形状仍然取自画布渲染器，所以图上和盘上是一个东西。"""
    os.makedirs(outdir, exist_ok=True)
    made = {}
    S = 128

    def canvas():
        im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        return im, ImageDraw.Draw(im, 'RGBA')

    im, d = canvas()
    draw_tent(d, 8, 12, S - 16, rgba(INFO, 255), 7, door=rgba(ACCENT_EDGE, 255))
    im.save(os.path.join(outdir, 'tent-128.png'))
    made['tent-128.png'] = S

    im, d = canvas()
    draw_tree(d, S / 2, S - 16, S - 24, rgba(PENCIL, 255), 7)
    im.save(os.path.join(outdir, 'tree-128.png'))
    made['tree-128.png'] = S

    im, d = canvas()
    d.ellipse([S / 2 - 14, S / 2 - 14, S / 2 + 14, S / 2 + 14], fill=rgba(SUCCESS, 235))
    for a in range(-2, 3):
        d.line([S / 2 + a * 14, S - 20, S / 2 + a * 14 + 6, S - 40], fill=rgba(PENCIL, 200), width=4)
    im.save(os.path.join(outdir, 'grass-128.png'))
    made['grass-128.png'] = S

    # 一帐八周空：把"斜角也算"这条最容易漏的规则画成图，86x86 的三格一角
    im, d = canvas()
    cell = S // 3
    for i in range(4):
        for j in range(4):
            d.rectangle([i * cell + 2, j * cell + 2, (i + 1) * cell - 2, (j + 1) * cell - 2],
                        outline=rgba(LINE, 200), width=2)
    d.rectangle([cell, cell, 2 * cell, 2 * cell], outline=rgba(ACCENT, 255), width=4)
    for i in (0, 1, 2, 3):
        for j in (0, 1, 2, 3):
            if abs(i - 1) <= 1 and abs(j - 1) <= 1 and (i, j) != (1, 1):
                d.line([i * cell + cell * 0.3, j * cell + cell * 0.3,
                        i * cell + cell * 0.7, j * cell + cell * 0.7], fill=rgba((255, 92, 122), 235), width=3)
                d.line([i * cell + cell * 0.7, j * cell + cell * 0.3,
                        i * cell + cell * 0.3, j * cell + cell * 0.7], fill=rgba((255, 92, 122), 235), width=3)
    im.save(os.path.join(outdir, 'rule-tent-spacing-128.png'))
    made['rule-tent-spacing-128.png'] = S
    return made


def font(size, bold=False):
    cands = [
        '/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Arial.ttf',
        '/System/Library/Fonts/Helvetica.ttc',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ]
    for p in cands:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size), p
            except Exception:
                continue
    try:
        return ImageFont.load_default(size=size), 'pillow-default'
    except TypeError:  # Pillow < 9.2
        return ImageFont.load_default(), 'pillow-default-bitmap'


def cjk_font(size):
    for p in ('/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Light.ttc',
              '/System/Library/Fonts/Hiragino Sans GB.ttc',
              '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size), p
            except Exception:
                continue
    return None, None


def build_og(path):
    """社交卡 1200x630：夜空 + 真实网格 + 几顶帐篷几棵树，右侧留字位。中文缺字库时退回纯拉丁。"""
    W, H = 1200, 630
    img = vertical_gradient(W, H=H)
    img = Image.alpha_composite(img.convert('RGBA'), starfield(W, 90, SEED + 11, H=H))
    d = ImageDraw.Draw(img, 'RGBA')
    # 左半：一块 5x5 的盘，上面摆着合法的帐篷/树（和引擎规则一致：每棵树旁边一顶，帐不相邻）
    cell = 96
    ox, oy = 60, (H - cell * 5) // 2
    for i in range(6):
        d.line([ox + i * cell, oy, ox + i * cell, oy + 5 * cell], fill=rgba(LINE, 200), width=2)
        d.line([ox, oy + i * cell, ox + 5 * cell, oy + i * cell], fill=rgba(LINE, 200), width=2)
    tents = [(0, 1), (1, 3), (2, 0), (3, 2), (4, 4)]
    trees = [(0, 0), (1, 2), (2, 1), (3, 3), (4, 3)]
    for (r, c) in trees:
        draw_tree(d, ox + c * cell + cell / 2, oy + r * cell + cell * 0.82, cell * 0.86,
                  rgba(PENCIL, 240), 5)
    for (r, c) in tents:
        draw_tent(d, ox + c * cell, oy + r * cell, cell, rgba(INFO, 255), 5, door=rgba(ACCENT, 255))
    tx = ox + 5 * cell + 66
    right = W - 44
    f_big, fp1 = font(104, bold=True)
    d.text((tx, H * 0.26), 'TENTS', font=f_big, fill=rgba(INK, 255))
    f_mid, fp2 = font(30)
    d.text((tx, H * 0.26 + 122), 'trees, tents & the numbers on the edge', font=f_mid,
           fill=rgba(mix(INK, BG_BOTTOM, 0.35), 255))
    f_small, _ = font(22)
    for i, ln in enumerate([
        'one tent orthogonally beside every tree',
        'no two tents touch, not even diagonally',
        'the counts say how many per line',
    ]):
        d.text((tx, H * 0.58 + i * 36), '\u2022  ' + ln, font=f_small, fill=rgba(PENCIL, 235))
    f_tag, _ = font(17, bold=True)
    d.text((tx, H * 0.58 + 3 * 36 + 20), 'ONE SOLUTION PER BOARD - ALL DERIVABLE BY LOGIC',
           font=f_tag, fill=rgba(ACCENT, 240))
    fc, cjk_path = cjk_font(54)
    if fc:
        d.text((tx, H * 0.10), '帐篷', font=fc, fill=rgba(ACCENT_EDGE, 255))
        f_note, _ = cjk_font(24)
        if f_note:
            d.text((tx + 140, H * 0.10 + 20), '树与帐篷推理', font=f_note, fill=rgba(INK, 210))
    for box in [(tx, H * 0.26, f_big, 'TENTS'), (tx, H * 0.26 + 122, f_mid,
                'trees, tents & the numbers on the edge'),
                (tx, H * 0.58, f_small, '\u2022  no two tents touch, not even diagonally'),
                (tx, H * 0.58 + 3 * 36 + 20, f_tag, 'ONE SOLUTION PER BOARD - ALL DERIVABLE BY LOGIC')]:
        x0, y0, ff, s = box
        bb = d.textbbox((x0, y0), s, font=ff)
        if bb[2] > right:
            raise SystemExit('og 文字超出右边界：%s 到 %d > %d（改小字号或缩短文案）' % (s, bb[2], right))
    img.save(path)
    return {'latin_font': fp1, 'cjk_font': cjk_path or 'none(拉丁兜底)'}


def read_ihdr(p):
    """自己读 PNG 文件头的 IHDR，不信任何人的文件名。返回 (w, h) 或 (-1, -1)。"""
    with open(p, 'rb') as fh:
        head = fh.read(24)
    if head[:8] != b'\x89PNG\r\n\x1a\n' or head[12:16] != b'IHDR':
        return (-1, -1)
    return struct.unpack('>II', head[16:24])


# js/theme.js 里那一份是运行时的唯一真源；这里是画师用的那一份。键名对不上就是画和盘分家了。
PALETTE_MIRROR = {
    'bgTop': BG_TOP, 'bgBottom': BG_BOTTOM, 'surface': SURFACE, 'surfaceLift': SURFACE_LIFT,
    'line': LINE, 'lineHeavy': LINE_HEAVY, 'ink': INK, 'accent': ACCENT,
    'accentEdge': ACCENT_EDGE, 'info': INFO, 'pencilStrong': PENCIL, 'success': SUCCESS,
}


def palette_drift():
    """把 js/theme.js 的 Palette hex 和上面的常量逐个对，返回不符的清单（缺键也算不符）。"""
    src = os.path.join(ROOT, 'js', 'theme.js')
    if not os.path.isfile(src):
        return ['js/theme.js 读不到']
    body = open(src, encoding='utf-8').read()
    found = dict(re.findall(r"(\w+):\s*'(#[0-9A-Fa-f]{6})'", body))
    out = []
    for key, rgb in PALETTE_MIRROR.items():
        raw = found.get(key)
        if raw is None:
            out.append('%s 在 theme.js 里不见了' % key)
            continue
        got = tuple(int(raw[1 + i:3 + i], 16) for i in (0, 2, 4))
        if got != rgb:
            out.append('%s theme.js=%s 画师=%s' % (key, raw, '#%02X%02X%02X' % rgb))
    return out


REF_SOURCES = ['index.html', os.path.join('css', 'game.css'), 'manifest.webmanifest']
# 社交卡只被抓取机器人读，离线首开用不到它；写明白，免得下一个人以为是漏项。
OFFLINE_EXEMPT = {'assets/img/og-cover.png'}


def precached():
    """sw.js 的 PRECACHE 清单（手写的，所以正因为手写才要机器对）。"""
    p = os.path.join(ROOT, 'sw.js')
    if not os.path.isfile(p):
        return set()
    body = open(p, encoding='utf-8').read()
    block = re.search(r'const PRECACHE = \[([\s\S]*?)\];', body)
    if not block:
        return set()
    return set(re.findall(r"['\"]\./(assets/[^'\"]+\.png)['\"]", block.group(1)))


def broken_refs():
    """html/css/manifest 里点名的每个 assets/*.png 都必须真在盘上且非 0 字节。"""
    refs = set()
    for rel in REF_SOURCES:
        p = os.path.join(ROOT, rel)
        if not os.path.isfile(p):
            continue
        refs.update(re.findall(r'assets/[A-Za-z0-9_\-./]+\.png', open(p, encoding='utf-8').read()))
    out = []
    for r in sorted(refs):
        fp = os.path.join(ROOT, r)
        if not os.path.isfile(fp):
            out.append('%s 被引用但盘上没有' % r)
        elif os.path.getsize(fp) == 0:
            out.append('%s 是 0 字节' % r)
    return sorted(refs), out


def offline_miss(refs):
    """被 html/css 点名、却没进 sw.js PRECACHE 的资产：离线首开就是缺件。"""
    have = precached()
    return sorted(r for r in refs if r not in have and r not in OFFLINE_EXEMPT)


def check(outdir):
    rows, bad = [], []
    for base, _, files in os.walk(ROOT):
        if 'assets' not in base and not base.endswith('assets'):
            continue
        for f in sorted(files):
            if not f.endswith('.png'):
                continue
            p = os.path.join(base, f)
            size = os.path.getsize(p)
            w, h = read_ihdr(p)
            rows.append((os.path.relpath(p, ROOT), w, h, size))
            if (w, h) == (-1, -1) or size == 0:
                bad.append(p)
    for r in rows:
        print('%-46s %4dx%-4d %8d B' % r)
    refs, miss = broken_refs()
    drift = palette_drift()
    miss_off = offline_miss(refs)
    for m in miss:
        print('  引用断链：%s' % m)
    for d in drift:
        print('  色板漂移：%s' % d)
    for m in miss_off:
        print('  离线缺件：%s 被引用但没进 sw.js PRECACHE' % m)
    print('PNG 文件 %d 张，坏 %d 张，边长≥180 的 %d 张' % (len(rows), len(bad),
          sum(1 for r in rows if min(r[1], r[2]) >= 180)))
    print('引用链：%d 条被 html/css/manifest 点名，断链 %d 条；离线未 precache %d 条；色板镜像 %d 键，漂移 %d 键'
          % (len(refs), len(miss), len(miss_off), len(PALETTE_MIRROR), len(drift)))
    return 1 if (bad or miss or drift or miss_off) else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true',
                    help='核对盘上 PNG 的类型/宽高、theme.js 色板是否仍同源、html/css/manifest 引用链是否断链')
    args = ap.parse_args()
    if args.check:
        return check(None)
    if Image is None:
        raise SystemExit('重画像素需要 Pillow（pip install pillow）；只核对资产请用 --check，那条走标准库。')
    icons = os.path.join(ROOT, 'assets', 'icons')
    texdir = os.path.join(ROOT, 'assets', 'textures')
    sprdir = os.path.join(ROOT, 'assets', 'sprites')
    imgdir = os.path.join(ROOT, 'assets', 'img')
    os.makedirs(texdir, exist_ok=True)
    os.makedirs(imgdir, exist_ok=True)
    made = build_icons(icons)
    build_texture(os.path.join(texdir, 'night-paper-256.png'))
    sprites = build_sprites(sprdir)
    info = build_og(os.path.join(imgdir, 'og-cover.png'))
    total = len(made) + len(sprites) + 2
    pngs = [os.path.join(b, f) for b, _, fs in os.walk(os.path.join(ROOT, 'assets'))
            for f in fs if f.endswith('.png')]
    big = sum(1 for p in pngs if min(read_ihdr(p)) >= 180)
    print('生成 %d 张 PNG（盘上实测 %d 张，其中边长≥180 的 %d 张）：icons=%d sprites=%d texture=1 og=1'
          % (total, len(pngs), big, len(made), len(sprites)))
    print('og 字体：拉丁=%s 中文=%s' % (info['latin_font'], info['cjk_font']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
