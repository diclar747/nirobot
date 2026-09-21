import { io, type Socket } from 'socket.io-client';
import { refreshAccessSession } from './api';

let socket: Socket | null = null;
let presenceStatus: string | null = null;
let retryTimer: number | undefined;

// Estado de presencia elegido por la persona: se vuelve a informar cada vez que se (re)conecta el socket
// (por ejemplo, después de un reinicio del servidor), así el resto del equipo lo ve siempre actualizado.
export function setPresenceStatus(status: string | null) {
  presenceStatus = status;
  if (socket?.connected && status) socket.emit('agent:set_status', { status });
}

export function getSocket(): Socket {
  if (!socket) {
    const current = io({
      withCredentials: true,
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    });
    socket = current;

    current.on('connect', () => {
      window.clearTimeout(retryTimer);
      if (presenceStatus) current.emit('agent:set_status', { status: presenceStatus });
    });

    // El token de acceso dura 15 minutos: se renueva y se reintenta. Si todavía no hay sesión (justo antes de iniciar
    // sesión con QR), socket.io NO reintenta solo cuando el servidor rechaza el acceso, así que se reintenta acá: sin
    // esto, el equipo quedaba "desconectado" hasta recargar la página.
    current.on('connect_error', async (error) => {
      const message = String(error?.message || '').toLowerCase();
      if (!message.includes('unauthorized') && !message.includes('token')) return;
      const refreshed = await refreshAccessSession();
      if (socket !== current || current.connected) return;
      if (refreshed) { current.connect(); return; }
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => { if (socket === current && !current.connected) current.connect(); }, 4000);
    });

    current.connect();
  }
  return socket;
}

// Reconecta si quedó caído (al iniciar sesión, al volver a la pestaña o al recuperar la red).
export function ensureSocketConnected() {
  const current = getSocket();
  if (!current.connected && !current.active) current.connect();
}

export function disconnectSocket() {
  window.clearTimeout(retryTimer);
  socket?.disconnect();
  socket = null;
}

if (typeof window !== 'undefined') {
  const wake = () => { if (socket && !socket.connected) socket.connect(); };
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);
}
