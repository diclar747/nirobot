// Notificaciones push del navegador (Web Push / VAPID). Todo lo que toca claves privadas vive en
// el servidor; acá solo se pide permiso, se registra el service worker y se manda la suscripción
// que genera el propio navegador.
import { api, apiGet, apiPost, ApiError } from './api';

export type PushSupport = 'unsupported' | 'unconfigured' | 'default' | 'denied' | 'subscribed' | 'available';

function urlBase64ToUint8Array(base64: string): BufferSource {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64Safe);
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return buffer;
}

function isBrowserCapable() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isBrowserCapable()) return null;
  return navigator.serviceWorker.register('/sw.js');
}

/** Estado actual, para decidir qué mostrar en el botón de la campanita. */
export async function getPushStatus(): Promise<PushSupport> {
  if (!isBrowserCapable()) return 'unsupported';

  let vapid: { configured: boolean } | null = null;
  try {
    vapid = await apiGet<{ publicKey: string | null; configured: boolean }>('/api/org/push/vapid-public-key');
  } catch {
    return 'unsupported';
  }
  if (!vapid?.configured) return 'unconfigured';

  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'default') return 'default';

  const registration = await navigator.serviceWorker.getRegistration('/sw.js').catch(() => null);
  const existing = await registration?.pushManager.getSubscription().catch(() => null);
  return existing ? 'subscribed' : 'available';
}

/** Pide permiso (si hace falta) y suscribe este navegador. Lanza ApiError/Error en caso de fallo. */
export async function subscribeToPush(): Promise<void> {
  if (!isBrowserCapable()) throw new Error('Este navegador no soporta notificaciones push');

  const { publicKey, configured } = await apiGet<{ publicKey: string | null; configured: boolean }>(
    '/api/org/push/vapid-public-key'
  );
  if (!configured || !publicKey) throw new Error('Las notificaciones push no están configuradas en el servidor');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permiso de notificaciones denegado');

  const registration = await getRegistration();
  if (!registration) throw new Error('No se pudo registrar el service worker');
  await navigator.serviceWorker.ready;

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });

  await apiPost('/api/org/push/subscribe', { subscription: subscription.toJSON() });
}

/** Desuscribe este navegador (del lado del push del navegador y del registro en el servidor). */
export async function unsubscribeFromPush(): Promise<void> {
  if (!isBrowserCapable()) return;
  const registration = await navigator.serviceWorker.getRegistration('/sw.js').catch(() => null);
  const subscription = await registration?.pushManager.getSubscription().catch(() => null);
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe().catch(() => {});
  // apiDelete no manda body; el servidor necesita el endpoint para saber cuál borrar.
  await api('/api/org/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint }) }).catch(() => {});
}

export function isPushError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
