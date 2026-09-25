import { useEffect, useState } from 'react';
import { getPushStatus, subscribeToPush, unsubscribeFromPush, type PushSupport } from '../lib/push';

const DESCRIPTION: Record<PushSupport, string> = {
  unsupported: '',
  unconfigured: '',
  default: 'Te llegan al celular o la computadora aunque Niro esté cerrado.',
  available: 'Te llegan al celular o la computadora aunque Niro esté cerrado.',
  subscribed: 'Activadas en este navegador.',
  denied: 'Están bloqueadas: habilitalas desde los permisos del sitio en tu navegador.'
};

/**
 * Notificaciones push del navegador (antes era una segunda campanita en el topbar, al lado del centro
 * de notificaciones: ahora es una fila más de «Sonidos y avisos»). Devuelve null si el navegador no
 * soporta push o el servidor no tiene las claves VAPID: no tiene sentido mostrar algo que no hace nada.
 */
export function PushNotificationsRow({ render }: { render: (props: { checked: boolean; disabled: boolean; description: string; onChange: (on: boolean) => void }) => JSX.Element }) {
  const [status, setStatus] = useState<PushSupport>('unsupported');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPushStatus()
      .then(setStatus)
      .catch(() => setStatus('unsupported'));
  }, []);

  if (status === 'unsupported' || status === 'unconfigured') return null;

  async function onChange(on: boolean) {
    if (busy || status === 'denied') return;
    setBusy(true);
    try {
      if (!on) {
        await unsubscribeFromPush();
        setStatus('available');
      } else {
        await subscribeToPush();
        setStatus('subscribed');
      }
    } catch (err) {
      console.error('[push]', err);
      setStatus(await getPushStatus().catch(() => status));
    } finally {
      setBusy(false);
    }
  }

  return render({ checked: status === 'subscribed', disabled: busy || status === 'denied', description: DESCRIPTION[status], onChange });
}
