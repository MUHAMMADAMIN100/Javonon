/**
 * Короткий звук нового сообщения (как в Telegram) — без файла, WebAudio.
 *
 * Браузер разрешает звук только после первого действия человека на странице,
 * поэтому AudioContext создаётся лениво и «будится» первым кликом/нажатием.
 * Если звук недоступен — молча ничего не делаем.
 */
let ctx: AudioContext | null = null;
let lastAt = 0;

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    ctx = null;
  }
  return ctx;
}

if (typeof window !== 'undefined') {
  const wake = () => {
    const a = audio();
    if (a && a.state === 'suspended') a.resume().catch(() => undefined);
  };
  window.addEventListener('pointerdown', wake, { passive: true });
  window.addEventListener('keydown', wake);
}

export function playChatSound() {
  // Пачка сообщений подряд — один звук.
  const now = Date.now();
  if (now - lastAt < 800) return;
  lastAt = now;
  const a = audio();
  if (!a || a.state !== 'running') return;
  try {
    const t = a.currentTime;
    const gain = a.createGain();
    gain.connect(a.destination);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    for (const [freq, start] of [[880, 0], [1320, 0.09]] as const) {
      const osc = a.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + start);
      osc.connect(gain);
      osc.start(t + start);
      osc.stop(t + 0.34);
    }
  } catch {
    /* звук — не главное */
  }
}
