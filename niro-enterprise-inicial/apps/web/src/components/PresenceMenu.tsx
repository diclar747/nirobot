import { useEffect, useRef, useState } from 'react';
import { apiPost } from '../lib/api';
import { getSocket, setPresenceStatus } from '../lib/socket';
import { useAuth } from '../context/AuthContext';
import { PRESENCE_COLOR, PRESENCE_HELP, PRESENCE_LABEL, PRESENCE_SELECTABLE, readPresence, savePresence } from '../lib/presence';
import type { AgentPresence, AgentPresenceStatus } from '../types';
import '../styles/presence.css';

// "Mi estado": En línea, Ocupado, Pendiente, Receso o Descanso. El cambio se ve al instante en todo el equipo.
export function PresenceMenu() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState<AgentPresenceStatus>(() => (user ? readPresence(user.id) : 'available'));
  const [connected, setConnected] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user) return;
    const socket = getSocket();
    const chosen = readPresence(user.id);
    setPresenceStatus(chosen);
    setMine(chosen);
    // Lo que el servidor dice de mí manda: si cambio el estado desde otra pestaña o dispositivo, esta se entera.
    const onPresence = ({ presence }: { presence: AgentPresence[] }) => {
      const me = presence.find((p) => p.userId === user.id);
      setConnected(Boolean(me?.online));
      if (me?.online && me.status !== 'offline') setMine(me.status);
    };
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    socket.on('agent:presence_list', onPresence);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    setConnected(socket.connected);
    return () => { socket.off('agent:presence_list', onPresence); socket.off('connect', onConnect); socket.off('disconnect', onDisconnect); };
  }, [user]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [open]);

  if (!user || user.role === 'SUPERADMIN') return null;
  const shown: AgentPresenceStatus = connected ? mine : 'offline';

  async function choose(status: AgentPresenceStatus) {
    if (!user) return;
    setMine(status); setOpen(false);
    savePresence(user.id, status);
    setPresenceStatus(status);
    // Respaldo por HTTP por si el socket está reconectando en este instante.
    apiPost('/api/org/presence/status', { status }).catch(() => {});
  }

  return (
    <div className="presence-menu" ref={box}>
      <button type="button" className="presence-trigger" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} title="Cambiar mi estado">
        <i style={{ background: PRESENCE_COLOR[shown] }} aria-hidden="true" />
        <span>{PRESENCE_LABEL[shown]}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <div className="presence-dropdown" role="menu" aria-label="Mi estado">
          <div className="presence-dropdown-title">Mi estado</div>
          {PRESENCE_SELECTABLE.map((status) => (
            <button type="button" role="menuitemradio" aria-checked={status === mine} key={status} className={`presence-option ${status === mine ? 'selected' : ''}`} onClick={() => choose(status)}>
              <i style={{ background: PRESENCE_COLOR[status] }} aria-hidden="true" />
              <span><b>{PRESENCE_LABEL[status]}</b><small>{PRESENCE_HELP[status]}</small></span>
            </button>
          ))}
          {!connected && <div className="presence-note">Sin conexión con el servidor: se aplica cuando vuelva.</div>}
        </div>
      )}
    </div>
  );
}
