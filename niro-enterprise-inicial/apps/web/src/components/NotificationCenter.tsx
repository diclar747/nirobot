import { useEffect, useRef, useState } from 'react';
import { useNotifications, type AppNotification } from '../context/NotificationsContext';
import { playMessageSound, playTransferSound } from '../lib/sounds';
import { Modal } from './Modal';
import { Ui } from './Ui';
import { PushNotificationsRow } from './NotificationBell';
import '../styles/notifications.css';

function timeAgo(at: number) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 45) return 'ahora';
  if (s < 3600) return `hace ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return new Date(at).toLocaleDateString('es-PY', { day: '2-digit', month: 'short' });
}

// Logo de Facebook (mismo trazo que el menú lateral) para los avisos que vienen del panel.
function FacebookGlyph({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M15 8h-1.5A2.5 2.5 0 0 0 11 10.5V12H9v3h2v6h3v-6h2.2l.3-3H14v-1.2c0-.44.36-.8.8-.8H15V8Z" fill="currentColor" stroke="none" /></svg>;
}

function Item({ n, onOpen }: { n: AppNotification; onOpen: (n: AppNotification) => void }) {
  return (
    <button type="button" className={`nc-item ${n.read ? '' : 'unread'} ${n.type}`} onClick={() => onOpen(n)}>
      <span className="nc-icon">{n.type === 'facebook' ? <FacebookGlyph size={18} /> : <Ui name={n.type === 'transfer' ? 'transfer' : 'chat'} size={18} />}</span>
      <span className="nc-body"><b>{n.title}</b><small>{n.body}</small></span>
      <span className="nc-time">{timeAgo(n.at)}</span>
    </button>
  );
}

/** Campanita del topbar: centro de notificaciones (mensajes y transferencias) con contador. */
export function NotificationCenter({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { items, unread, open, markAllRead, clearAll } = useNotifications();
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!show) return;
    tick((v) => v + 1);
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setShow(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShow(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [show]);

  return (
    <div className="nc-wrap" ref={ref}>
      <button type="button" className={`topbar-icon-btn nc-bell ${unread > 0 ? 'has-unread' : ''}`} onClick={() => setShow((v) => !v)} title="Notificaciones" aria-label={`Notificaciones${unread ? `, ${unread} sin leer` : ''}`} aria-expanded={show}>
        <Ui name="bell" size={18} />
        {unread > 0 && <span className="nc-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {show && (
        <div className="nc-panel" role="dialog" aria-label="Notificaciones">
          <div className="nc-head">
            <strong>Notificaciones</strong>
            <span>
              <button type="button" onClick={markAllRead} disabled={unread === 0}>Marcar todo leído</button>
              <button type="button" onClick={clearAll} disabled={items.length === 0}>Limpiar</button>
            </span>
          </div>
          <div className="nc-list">
            {items.length === 0 ? (
              <div className="nc-empty"><Ui name="bell" size={30} /><p>Todo al día</p><small>Acá vas a ver los mensajes nuevos, los chats que te transfieran y los avisos de Facebook / Instagram.</small></div>
            ) : items.map((n) => <Item key={n.id} n={n} onOpen={(x) => { setShow(false); open(x); }} />)}
          </div>
          <div className="nc-foot"><button type="button" onClick={() => { setShow(false); onOpenSettings(); }}><Ui name="settings" size={14} /> Sonidos y avisos</button></div>
        </div>
      )}
    </div>
  );
}

/** Pop-ups que aparecen en pantalla cuando llega una transferencia o un mensaje. */
export function NotificationToasts() {
  const { toasts, open, dismissToast } = useNotifications();
  if (toasts.length === 0) return null;
  return (
    <div className="nt-stack" aria-live="polite">
      {toasts.map(({ id, notification: n }) => (
        <div key={id} className={`nt-toast ${n.type}`} role="alert">
          <span className="nt-icon">{n.type === 'facebook' ? <FacebookGlyph size={20} /> : <Ui name={n.type === 'transfer' ? 'transfer' : 'chat'} size={20} />}</span>
          <div className="nt-body"><b>{n.title}</b><small>{n.body}</small>
            <div className="nt-actions"><button type="button" className="nt-primary" onClick={() => open(n)}>{n.type === 'transfer' ? 'Ver chat' : n.type === 'facebook' ? 'Ver en Facebook' : 'Abrir'}</button><button type="button" onClick={() => dismissToast(id)}>Cerrar</button></div>
          </div>
          <button type="button" className="nt-x" onClick={() => dismissToast(id)} aria-label="Cerrar aviso"><Ui name="x" size={16} /></button>
        </div>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, title, description, extra }: { checked: boolean; onChange: (v: boolean) => void; title: string; description: string; extra?: React.ReactNode }) {
  return (
    <div className="ns-row">
      <div><b>{title}</b><small>{description}</small></div>
      {extra}
      <label className="ns-switch"><input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span /></label>
    </div>
  );
}

/** Preferencias de sonido y avisos del usuario. */
export function NotificationSettingsModal({ onClose }: { onClose: () => void }) {
  const { prefs, updatePrefs } = useNotifications();
  const supported = typeof Notification !== 'undefined';
  const [permission, setPermission] = useState<NotificationPermission>(supported ? Notification.permission : 'denied');

  async function toggleDesktop(on: boolean) {
    if (!on) { updatePrefs({ desktop: false }); return; }
    if (!supported) return;
    const result = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    setPermission(result);
    updatePrefs({ desktop: result === 'granted' });
  }

  return (
    <Modal title="Sonidos y avisos" onClose={onClose} className="ns-modal">
      <p className="ns-lead">Elegí cómo querés enterarte de los mensajes nuevos y de los chats que te transfieren. Se guarda para tu usuario en este navegador.</p>
      <Toggle checked={prefs.soundMessages} onChange={(v) => updatePrefs({ soundMessages: v })} title="Sonido de mensajes nuevos" description="Un “ding” suave cuando te escribe un cliente y no tenés ese chat abierto."
        extra={<button type="button" className="ns-test" onClick={() => playMessageSound(prefs.volume)}><Ui name="volume" size={14} /> Probar</button>} />
      <Toggle checked={prefs.soundTransfers} onChange={(v) => updatePrefs({ soundTransfers: v })} title="Sonido de transferencias" description="Una melodía distinta cuando alguien te transfiere un chat."
        extra={<button type="button" className="ns-test" onClick={() => playTransferSound(prefs.volume)}><Ui name="volume" size={14} /> Probar</button>} />
      <div className="ns-row slider"><div><b>Volumen</b><small>{Math.round(prefs.volume * 100)}%</small></div>
        <input type="range" min={10} max={100} value={Math.round(prefs.volume * 100)} onChange={(e) => updatePrefs({ volume: Number(e.target.value) / 100 })} aria-label="Volumen de las notificaciones" /></div>
      <Toggle checked={prefs.popups} onChange={(v) => updatePrefs({ popups: v })} title="Avisos emergentes" description="Un cuadro en pantalla cuando llega una transferencia o un mensaje." />
      <Toggle checked={prefs.desktop && permission === 'granted'} onChange={toggleDesktop} title="Avisos del navegador" description={!supported ? 'Tu navegador no los soporta.' : permission === 'denied' ? 'Están bloqueados: habilitalos desde los permisos del sitio en tu navegador.' : 'Te avisa aunque estés en otra pestaña o ventana.'} />
      <PushNotificationsRow render={({ checked, disabled, description, onChange }) => <Toggle checked={checked} onChange={(v) => { if (!disabled) void onChange(v); }} title="Notificaciones push" description={description} />} />
      <div className="ns-foot"><button type="button" className="btn" onClick={onClose}>Listo</button></div>
    </Modal>
  );
}
