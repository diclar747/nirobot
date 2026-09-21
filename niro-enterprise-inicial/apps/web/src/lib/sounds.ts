// Sonidos de notificación generados con Web Audio (sin archivos): suaves, cortos y agradables.
let ctx: AudioContext | null = null;
let unlocked = false;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

/** Los navegadores solo permiten sonido después de un clic o tecla: lo "desbloqueamos" en la primera interacción. */
export function installSoundUnlock() {
  if (unlocked || typeof window === 'undefined') return;
  const unlock = () => {
    const c = audio();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
    unlocked = true;
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

function tone(c: AudioContext, freq: number, start: number, duration: number, volume: number, type: OscillatorType = 'sine') {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, c.currentTime + start);
  gain.gain.setValueAtTime(0.0001, c.currentTime + start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), c.currentTime + start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + duration);
  osc.connect(gain).connect(c.destination);
  osc.start(c.currentTime + start);
  osc.stop(c.currentTime + start + duration + 0.05);
}

/** Mensaje nuevo: dos notas suaves ("ding-ding"). */
export function playMessageSound(volume = 0.7) {
  const c = audio();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  const v = 0.22 * volume;
  tone(c, 880, 0, 0.34, v);
  tone(c, 1318.5, 0.12, 0.42, v * 0.85);
}

/** Transferencia de chat: cuatro notas ascendentes, más llamativa para que no pase desapercibida. */
export function playTransferSound(volume = 0.7) {
  const c = audio();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  const v = 0.24 * volume;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(c, f, i * 0.13, 0.5, v * (0.8 + i * 0.07), 'triangle'));
}
