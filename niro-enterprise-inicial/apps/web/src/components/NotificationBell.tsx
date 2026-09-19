import { useEffect, useState } from 'react';
import { getPushStatus, subscribeToPush, unsubscribeFromPush, type PushSupport } from '../lib/push';

const TITLE: Record<PushSupport, string> = {
  unsupported: '',
  unconfigured: '',
  default: 'Activar notificaciones push',
  available: 'Activar notificaciones push en este navegador',
  subscribed: 'Notificaciones push activadas — clic para desactivar',
  denied: 'Notificaciones bloqueadas. Habilitalas desde los permisos del sitio en tu navegador'
};

/**
 * Campanita del topbar para prender/apagar las notificaciones push del navegador. Se esconde
 * sola si el navegador no soporta push o si el servidor no tiene las claves VAPID configuradas —
 * no tiene sentido mostrar un botón que no puede hacer nada.
 */
export function NotificationBell() {
  const [status, setStatus] = useState<PushSupport>('unsupported');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPushStatus()
      .then(setStatus)
      .catch(() => setStatus('unsupported'));
  }, []);

  if (status === 'unsupported' || status === 'unconfigured') return null;

  async function handleClick() {
    if (busy || status === 'denied') return;
    setBusy(true);
    try {
      if (status === 'subscribed') {
        await unsubscribeFromPush();
        setStatus('available');
      } else {
        await subscribeToPush();
        setStatus('subscribed');
      }
    } catch (err) {
      console.error('[push]', err);
      const fresh = await getPushStatus().catch(() => status);
      setStatus(fresh);
    } finally {
      setBusy(false);
    }
  }

  const active = status === 'subscribed';

  return (
    <button
      type="button"
      className={`topbar-icon-btn ${active ? 'is-active' : ''}`}
      onClick={handleClick}
      disabled={busy || status === 'denied'}
      title={TITLE[status]}
    >
      {active ? (
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
          <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" />
        </svg>
      ) : status === 'denied' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M18 8a6 6 0 0 0-9.33-5" />
          <path d="M4 4l16 16" />
          <path d="M17.61 17.61A6 6 0 0 1 6 16v-5a5.9 5.9 0 0 1 .35-2" />
          <path d="M10.34 21a2 2 0 0 0 3.32 0" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      )}
    </button>
  );
}
