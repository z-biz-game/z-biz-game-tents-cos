// PWA 注册。单独一个模块而不是塞进 main.js：main.js 是游戏本体，任何一条 DOM 断言都不该
// 被 worker 注册的成功与否影响；而且 file:// （Electron 直接 loadFile）必须整段跳过且不抛。

const SW_PATH = 'sw.js';

export function registerServiceWorker() {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  if (!nav || !nav.serviceWorker) return false;
  const proto = typeof location !== 'undefined' ? location.protocol : '';
  if (proto !== 'http:' && proto !== 'https:') return false;
  try {
    const base = (typeof document !== 'undefined' && document.baseURI) ||
      (typeof location !== 'undefined' && location.href) || 'file:///';
    nav.serviceWorker.register(new URL(SW_PATH, base).href).catch(() => {
      /* 注册失败（离线、配额、Pages 前缀形态下路径不对）只是没有离线模式，游戏照玩 */
    });
    return true;
  } catch {
    return false;
  }
}

const ready = typeof document !== 'undefined' && (document.readyState === 'complete' || document.readyState === 'interactive');
if (ready) registerServiceWorker();
else if (typeof window !== 'undefined') window.addEventListener('load', () => registerServiceWorker(), { once: true });
