import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiGet } from '../lib/api';
import { getSocket } from '../lib/socket';
import { initials } from '../lib/format';
import '../styles/status-stories.css';
import { Ui } from './Ui';

export type StoryItem = {
  id: string;
  kind: 'image' | 'video' | 'text';
  text: string | null;
  caption: string | null;
  backgroundColor: string | null;
  mediaUrl: string | null;
  postedAt: string;
  expiresAt: string;
};

export type StoryGroup = {
  key: string;
  contactId: string | null;
  name: string;
  phone: string | null;
  avatarUrl: string | null;
  fromMe: boolean;
  latestAt: string;
  items: StoryItem[];
};

const SEEN_KEY = 'niro_seen_statuses';
const STORY_DURATION_MS = 5000;

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-500)));
  } catch {
    // Storage can be unavailable (private mode); "seen" is only a convenience.
  }
}

function timeAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `hace ${hours} h`;
}

function StoryAvatar({ group, size }: { group: StoryGroup; size: number }) {
  if (group.avatarUrl) {
    return <img className="story-avatar-img" src={group.avatarUrl} alt="" referrerPolicy="no-referrer" style={{ width: size, height: size }} />;
  }
  return (
    <span className="story-avatar-fallback" style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {group.fromMe ? <Ui name="plus" size={18} /> : initials(group.name)}
    </span>
  );
}

export function StatusStories() {
  const [groups, setGroups] = useState<StoryGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [seen, setSeen] = useState<Set<string>>(() => loadSeen());
  const [viewer, setViewer] = useState<{ group: number; item: number } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [loop, setLoop] = useState(false);       // hay más estados que espacio: se duplica la fila para que dé la vuelta sin cortes
  const pausedRef = useRef(false);               // el mouse encima / foco / toque detienen el movimiento
  const viewerOpenRef = useRef(false);

  const load = useCallback(() => {
    apiGet<{ groups: StoryGroup[] }>('/api/org/statuses')
      .then((data) => setGroups(data.groups || []))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    load();
    const socket = getSocket();
    socket.on('status:new', load);
    socket.on('status:deleted', load);
    // Statuses expire after 24 h: refresh so vanished ones disappear without a reload.
    const timer = window.setInterval(load, 5 * 60 * 1000);
    return () => {
      socket.off('status:new', load);
      socket.off('status:deleted', load);
      window.clearInterval(timer);
    };
  }, [load]);

  // ¿Entran todos los estados? Si no, la fila se mueve sola (carrusel).
  useEffect(() => {
    const list = listRef.current;
    const track = trackRef.current;
    if (!list || !track) return;
    const measure = () => setLoop(track.scrollWidth > list.clientWidth + 6);
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(list);
    return () => observer?.disconnect();
  }, [groups]);

  useEffect(() => { viewerOpenRef.current = viewer !== null; }, [viewer]);

  // Movimiento lento y continuo hacia la izquierda; se detiene con el mouse encima y sigue al sacarlo.
  useEffect(() => {
    const list = listRef.current;
    const track = trackRef.current;
    if (!list || !track || !loop) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const SPEED = 26; // píxeles por segundo
    let raf = 0;
    let last = performance.now();
    let pos = list.scrollLeft;
    let wasPaused = true;
    const step = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      if (pausedRef.current || viewerOpenRef.current || document.hidden) {
        wasPaused = true;
      } else {
        if (wasPaused) { pos = list.scrollLeft; wasPaused = false; } // retoma desde donde quedó (incluye lo que se movió a mano)
        pos += (SPEED * dt) / 1000;
        const half = track.offsetWidth;
        if (half > 0 && pos >= half) pos -= half; // vuelta completa sin salto visible
        list.scrollLeft = pos;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [loop, groups.length]);

  const markSeen = useCallback((id: string) => {
    setSeen((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      saveSeen(next);
      return next;
    });
  }, []);

  const openGroup = (index: number) => {
    const group = groups[index];
    const firstUnseen = group.items.findIndex((item) => !seen.has(item.id));
    setViewer({ group: index, item: firstUnseen === -1 ? 0 : firstUnseen });
  };

  const totalUnseen = useMemo(
    () => groups.reduce((sum, group) => sum + group.items.filter((item) => !seen.has(item.id)).length, 0),
    [groups, seen]
  );

  return (
    <section className="stories-strip" aria-label="Estados de WhatsApp">
      <div className="stories-strip-head">
        <span>Estados</span>
        {totalUnseen > 0 && <span className="stories-strip-badge">{totalUnseen} nuevos</span>}
      </div>
      {loaded && groups.length === 0 ? (
        <p className="stories-empty">Aún no hay estados de tus contactos. Aparecen aquí durante 24 horas.</p>
      ) : (
        <div
          className={`stories-strip-list ${loop ? 'is-carousel' : ''}`}
          ref={listRef}
          onMouseEnter={() => { pausedRef.current = true; }}
          onMouseLeave={() => { pausedRef.current = false; }}
          onWheel={(e) => { if (loop && listRef.current) listRef.current.scrollLeft += e.deltaY + e.deltaX; }}
          onFocusCapture={() => { pausedRef.current = true; }}
          onBlurCapture={() => { pausedRef.current = false; }}
          onTouchStart={() => { pausedRef.current = true; }}
          onTouchEnd={() => { window.setTimeout(() => { pausedRef.current = false; }, 1500); }}
        >
          {[false, true].map((hidden) => (hidden && !loop ? null : (
            <div className="stories-track" key={hidden ? 'copy' : 'main'} ref={hidden ? undefined : trackRef} aria-hidden={hidden || undefined}>
              {groups.map((group, index) => {
                const unseen = group.items.some((item) => !seen.has(item.id));
                return (
                  <button type="button" key={`${hidden ? 'c' : 'm'}-${group.key}`} className="story-chip" onClick={() => openGroup(index)} title={group.name} tabIndex={hidden ? -1 : undefined}>
                    <span className={`story-ring ${unseen ? 'unseen' : 'seen'}`}>
                      <span className="story-ring-inner">
                        <StoryAvatar group={group} size={46} />
                      </span>
                    </span>
                    <span className="story-chip-name">{group.fromMe ? 'Mi estado' : group.name.split(' ')[0]}</span>
                  </button>
                );
              })}
            </div>
          )))}
        </div>
      )}
      {viewer && groups[viewer.group] && (
        <StoryViewer
          groups={groups}
          start={viewer}
          onSeen={markSeen}
          onClose={() => setViewer(null)}
        />
      )}
    </section>
  );
}

function StoryViewer({
  groups,
  start,
  onSeen,
  onClose
}: {
  groups: StoryGroup[];
  start: { group: number; item: number };
  onSeen: (id: string) => void;
  onClose: () => void;
}) {
  const [position, setPosition] = useState(start);
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const group = groups[position.group];
  const item = group?.items[position.item];

  const next = useCallback(() => {
    setProgress(0);
    setPosition((current) => {
      const currentGroup = groups[current.group];
      if (current.item < currentGroup.items.length - 1) return { group: current.group, item: current.item + 1 };
      if (current.group < groups.length - 1) return { group: current.group + 1, item: 0 };
      onClose();
      return current;
    });
  }, [groups, onClose]);

  const previous = useCallback(() => {
    setProgress(0);
    setPosition((current) => {
      if (current.item > 0) return { group: current.group, item: current.item - 1 };
      if (current.group > 0) return { group: current.group - 1, item: groups[current.group - 1].items.length - 1 };
      return current;
    });
  }, [groups]);

  useEffect(() => {
    if (item) onSeen(item.id);
  }, [item, onSeen]);

  // Images and text advance on a timer; videos follow their own playback (see onTimeUpdate).
  useEffect(() => {
    if (!item || item.kind === 'video' || paused) return;
    const startedAt = performance.now() - progress * STORY_DURATION_MS;
    let frame = 0;
    const tick = (now: number) => {
      const value = Math.min(1, (now - startedAt) / STORY_DURATION_MS);
      setProgress(value);
      if (value >= 1) next();
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // progress is intentionally excluded: it is the value this effect produces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, paused, next]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (paused) video.pause();
    else video.play().catch(() => setMuted(true));
  }, [paused, item]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowRight') next();
      else if (event.key === 'ArrowLeft') previous();
      else if (event.key === ' ') setPaused((value) => !value);
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [next, previous, onClose]);

  if (!group || !item) return null;

  return createPortal(
    <div className="story-viewer" role="dialog" aria-modal="true" aria-label={`Estado de ${group.name}`}>
      <div className="story-viewer-backdrop" onClick={onClose} />
      <div
        className="story-card"
        onMouseDown={() => setPaused(true)}
        onMouseUp={() => setPaused(false)}
        onMouseLeave={() => setPaused(false)}
        onTouchStart={() => setPaused(true)}
        onTouchEnd={() => setPaused(false)}
      >
        <div className="story-bars">
          {group.items.map((entry, index) => (
            <span key={entry.id} className="story-bar">
              <span
                className="story-bar-fill"
                style={{ width: `${index < position.item ? 100 : index === position.item ? progress * 100 : 0}%` }}
              />
            </span>
          ))}
        </div>

        <header className="story-head">
          <span className="story-head-avatar"><StoryAvatar group={group} size={36} /></span>
          <span className="story-head-text">
            <strong>{group.fromMe ? 'Mi estado' : group.name}</strong>
            <small>{timeAgo(item.postedAt)}</small>
          </span>
          {item.kind === 'video' && (
            <button type="button" className="story-icon-btn" onMouseDown={(e) => e.stopPropagation()} onClick={() => setMuted((value) => !value)} aria-label={muted ? 'Activar sonido' : 'Silenciar'}>
              <Ui name={muted ? 'mic-off' : 'volume'} size={18} />
            </button>
          )}
          <button type="button" className="story-icon-btn" onMouseDown={(e) => e.stopPropagation()} onClick={onClose} aria-label="Cerrar"><Ui name="x" size={18} /></button>
        </header>

        <div className="story-media" style={item.kind === 'text' ? { background: item.backgroundColor || '#0e1a38' } : undefined}>
          {item.kind === 'image' && item.mediaUrl && <img src={item.mediaUrl} alt={item.caption || 'Estado'} draggable={false} />}
          {item.kind === 'video' && item.mediaUrl && (
            <video
              key={item.id}
              ref={videoRef}
              src={item.mediaUrl}
              autoPlay
              playsInline
              muted={muted}
              onTimeUpdate={(event) => {
                const video = event.currentTarget;
                if (video.duration > 0) setProgress(video.currentTime / video.duration);
              }}
              onEnded={next}
            />
          )}
          {item.kind === 'text' && <p className="story-text">{item.text}</p>}
          {item.kind !== 'text' && item.caption && <p className="story-caption">{item.caption}</p>}
        </div>

        <button type="button" className="story-nav story-nav-prev" onMouseDown={(e) => e.stopPropagation()} onClick={previous} aria-label="Anterior" />
        <button type="button" className="story-nav story-nav-next" onMouseDown={(e) => e.stopPropagation()} onClick={next} aria-label="Siguiente" />
      </div>
    </div>,
    document.body
  );
}
