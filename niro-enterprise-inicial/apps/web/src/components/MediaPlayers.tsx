import { useEffect, useRef, useState } from 'react';
import Plyr from 'plyr';
import WaveSurfer from 'wavesurfer.js';
import 'plyr/dist/plyr.css';
import '../styles/media-players.css';
import { Ui } from './Ui';

function formatClock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Video con controles Plyr (play, barra, volumen, velocidad, pantalla completa). */
export function PlyrVideo({ src, poster }: { src: string; poster?: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const player = new Plyr(ref.current, {
      controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'settings', 'fullscreen'],
      settings: ['speed'],
      speed: { selected: 1, options: [0.75, 1, 1.25, 1.5, 2] },
      tooltips: { controls: false, seek: true },
      clickToPlay: true,
      hideControls: true,
      i18n: { speed: 'Velocidad', normal: 'Normal', play: 'Reproducir', pause: 'Pausar', mute: 'Silenciar', unmute: 'Activar sonido', enterFullscreen: 'Pantalla completa', exitFullscreen: 'Salir de pantalla completa', settings: 'Ajustes' }
    });
    return () => { try { player.destroy(); } catch { /* el nodo ya no existe */ } };
  }, [src]);
  return (
    <div className="media-video">
      <video ref={ref} src={src} poster={poster} preload="metadata" playsInline />
    </div>
  );
}

/** Nota de voz / audio estilo WhatsApp: botón, onda, tiempo y velocidad. */
export function WaveAudio({ src, outbound }: { src: string; outbound?: boolean }) {
  const holder = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!holder.current) return;
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.src = src;
    audioRef.current = audio;
    let ws: WaveSurfer | null = null;
    const onTime = () => setCurrent(audio.currentTime);
    const onMeta = () => setDuration(audio.duration);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    audio.addEventListener('play', () => setPlaying(true));
    audio.addEventListener('pause', () => setPlaying(false));
    audio.addEventListener('ended', () => { setPlaying(false); setCurrent(0); });
    audio.addEventListener('error', () => setFailed(true));
    try {
      ws = WaveSurfer.create({
        container: holder.current,
        media: audio,
        height: 30,
        barWidth: 2,
        barGap: 2,
        barRadius: 2,
        cursorWidth: 0,
        normalize: true,
        waveColor: outbound ? 'rgba(15, 23, 42, 0.35)' : 'rgba(148, 163, 184, 0.55)',
        progressColor: outbound ? '#0f766e' : '#38bdf8'
      });
      ws.on('error', () => { /* sin onda si el navegador no decodifica el códec; el audio igual suena */ });
    } catch {
      setFailed(true);
    }
    return () => {
      audio.pause();
      try { ws?.destroy(); } catch { /* noop */ }
      audio.removeAttribute('src');
    };
  }, [src, outbound]);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => setFailed(true)); else audio.pause();
  }

  function cycleRate() {
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }

  if (failed) return <audio src={src} controls className="media-audio-fallback" />;

  return (
    <div className={`media-audio ${outbound ? 'out' : 'in'}`}>
      <button type="button" className="media-audio-play" onClick={toggle} aria-label={playing ? 'Pausar' : 'Reproducir'}>
        <Ui name={playing ? 'pause' : 'play'} size={16} />
      </button>
      <div className="media-audio-body">
        <div ref={holder} className="media-audio-wave" />
        <div className="media-audio-time"><span>{formatClock(playing || current > 0 ? current : duration)}</span></div>
      </div>
      <button type="button" className="media-audio-rate" onClick={cycleRate} title="Velocidad de reproducción">{rate}×</button>
    </div>
  );
}
