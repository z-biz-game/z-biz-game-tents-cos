// Service worker：离线可玩 + 更新不被钉死。
//
// 两条来自别人踩过的坑：
//   1) 手工 VERSION + cache-first 会把 js/css 永久钉在旧版 —— 出新 HTML 配旧 JS 的鬼状态。
//      所以同源子资源一律**网络优先，失败退缓存**：在线时永远拿最新字节，断网才有得玩。
//   2) cache 名带版本号，且 activate 时清掉旧版本桶，否则每次改 VERSION 都在偷偷涨配额。
//
// 只在 http(s) 下有意义；file:// 由 js/pwa.js 在注册侧就跳过（这里再兜一层，直接放行网络）。

const VERSION = 'tents-v1.0.0';
const SHELL = 'tents-shell-' + VERSION;
const RUNTIME = 'tents-runtime-' + VERSION;

const PRECACHE = [
  './',
  './index.html',
  './css/game.css',
  './manifest.webmanifest',
  './js/main.js',
  './js/pwa.js',
  './js/store.js',
  './js/theme.js',
  './js/audio/synth.js',
  './js/engine/count.js',
  './js/engine/generate.js',
  './js/engine/tents.js',
  './js/render/board.js',
  './js/ui/game.js',
  './assets/icons/favicon-32.png',
  './assets/icons/favicon-64.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-1024.png',
  './assets/icons/maskable-192.png',
  './assets/icons/maskable-512.png',
  './assets/textures/night-paper-256.png',
  './assets/sprites/tent-128.png',
  './assets/sprites/tree-128.png',
  './assets/sprites/grass-128.png',
  './assets/sprites/rule-tent-spacing-128.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(SHELL)
      // 单个文件 404 不许拖垮整次安装（Pages 的前缀形态下相对路径最容易出这种事）
      .then((cache) => Promise.allSettled(PRECACHE.map((u) => cache.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tents-') && k !== SHELL && k !== RUNTIME)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req) {
  const cache = await caches.open(RUNTIME);
  try {
    const res = await fetch(req);
    if (res && res.ok && (req.method === 'GET' || req.method === undefined)) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 不碰跨源
  if (url.pathname.endsWith('/sw.js')) return;      // 别把自己的更新脚本喂进缓存
  ev.respondWith(networkFirst(req));
});
