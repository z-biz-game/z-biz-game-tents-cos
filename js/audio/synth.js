// Synthesised feedback, no sample files. A puzzle game's sound is a *state* readout —
// "a line went down", "that line breaks a number", "every number adds up" — and each of those is
// one short envelope, so a synth keeps the artifact small and the vocabulary honest.

let ctx = null;
let master = null;
let enabled = true;
// 观测数：harness 靠这两个数分辨"真静音"和"把 gain 设成 0 的假静音"。
const stats = { oscillators: 0, suspended: 0, resumed: 0 };

function audio() {
  if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return null;
  if (!ctx) {
    const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') {
    stats.resumed++;
    ctx.resume().catch(() => {});
  }
  return ctx;
}

// One oscillator with a two-point pitch glide and an exponential decay. Everything below is
// a call to this; adding a second voice shape is how a game ends up with sounds that do not
// belong to the same instrument.
function tone({ f0, f1 = f0, dur = 0.12, type = 'sine', gain = 0.22, delay = 0 }) {
  // 静音态必须在碰 AudioContext 之前就返回：走下去会 resume() 一个本该睡着的上下文，
  // 还会新建振荡器节点 —— 那正是"只是把 gain 设 0"的假静音。
  if (!enabled) return;
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  stats.oscillators++;
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
  vol.gain.setValueAtTime(0.0001, t);
  vol.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(vol).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// The context is parked, not merely silent: suspend() stops its own clock, so a muted tab does
// no audio work at all, and resume() is the only way back.
function park(on) {
  if (!ctx) return;
  try {
    if (!on && ctx.state === 'running') {
      stats.suspended++;
      ctx.suspend().catch(() => {});
    } else if (on && ctx.state === 'suspended') {
      stats.resumed++;
      ctx.resume().catch(() => {});
    }
  } catch {
    /* 状态读不到只是少了观测；静音本身由 `enabled` 保证 */
  }
}

export const Sound = {
  setEnabled(v) {
    enabled = !!v;
    park(enabled);
  },
  enabled: () => enabled,
  // Read by the verification harness: `state` is the AudioContext's own, so a fake mute (gain 0
  // with the context still running) cannot hide behind it.
  inspect: () => ({ enabled, state: ctx ? ctx.state : 'none', ...stats }),

  place() {
    tone({ f0: 520, f1: 880, dur: 0.14, type: 'triangle', gain: 0.2 });
  },
  rub() {
    tone({ f0: 300, f1: 240, dur: 0.07, type: 'square', gain: 0.07 });
  },
  erase() {
    tone({ f0: 240, f1: 180, dur: 0.08, type: 'sine', gain: 0.1 });
  },
  undo() {
    tone({ f0: 420, f1: 300, dur: 0.11, type: 'triangle', gain: 0.13 });
  },
  // Two detuned voices: an interval that is deliberately unpleasant, for the one thing the
  // player must notice without looking.
  conflict() {
    tone({ f0: 200, f1: 150, dur: 0.16, type: 'sawtooth', gain: 0.11 });
    tone({ f0: 214, f1: 158, dur: 0.16, type: 'sawtooth', gain: 0.09, delay: 0.01 });
  },
  hint() {
    tone({ f0: 760, f1: 1020, dur: 0.16, type: 'sine', gain: 0.16 });
    tone({ f0: 1140, dur: 0.1, type: 'sine', gain: 0.07, delay: 0.06 });
  },
  win() {
    [523, 659, 784, 1046].forEach((f, i) => tone({ f0: f, dur: 0.26, type: 'triangle', gain: 0.17, delay: i * 0.09 }));
  },
};
