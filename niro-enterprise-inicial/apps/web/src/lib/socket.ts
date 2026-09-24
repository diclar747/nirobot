import { io, type Socket } from 'socket.io-client';
import { refreshSession } from './api';

let socket: Socket | null = null;
let presenceStatus: string | null = null;
let retryTimer: number | undefined;

// Estado de presencia elegido por la persona: se vuelve a informar cada vez que se (re)conecta el socket
// (por ejemplo, después de un reinicio del servidor), así el resto del equipo lo ve siempre actualizado.
export function setPresenceStatus(status: string | null) {
  presenceStatus = status;
  if (socket?.connected && status) socket.emit('agent:set_status', { status });
}

// Con qué usuario se abrió la conexión actual. La conexión se autentica con la cookie UNA vez, al abrirse: si se
// cierra sesión y entra otra persona en la misma pestaña, hay que abrirla de nuevo. Si no, quedaba conectada como
// el usuario anterior y el nuevo figuraba "Desconectado" (y seguía recibiendo los avisos del anterior).
let sessionUserId: string | null = null;

export function getSocket(): Socket {
  if (!socket) {
    // No se conecta sola: la abre connectSocketFor() cuando hay sesión. Las pantallas solo se suscriben a eventos.
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

    // El token de acceso dura 15 minutos: si venció, se renueva y se reintenta (socket.io no reintenta solo cuando
    // el servidor rechaza el acceso). Si no hay sesión, no se insiste: se vuelve a abrir al iniciar sesión.
    current.on('connect_error', async (error) => {
      const message = String(error?.message || '').toLowerCase();
      if (!message.includes('unauthorized') && !message.includes('token')) return;
      if (!sessionUserId) return;
      const result = await refreshSession();
      if (socket !== current || current.connected || !sessionUserId) return;
      if (result === 'ok') { current.connect(); return; }
      if (result === 'denied') return;
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => { if (socket === current && sessionUserId && !current.connected) current.connect(); }, 4000);
    });
  }
  return socket;
}

// Abre (o reabre) el tiempo real para la persona que inició sesión. Se usa siempre el mismo objeto de conexión,
// así las pantallas que ya se suscribieron a eventos siguen recibiéndolos después de reconectar.
export function connectSocketFor(userId: string) {
  const current = getSocket();
  if (sessionUserId !== userId) {
    sessionUserId = userId;
    window.clearTimeout(retryTimer);
    if (current.connected || current.active) current.disconnect();
    current.connect();
    return;
  }
  if (!current.connected && !current.active) current.connect();
}

// Al cerrar sesión: corta la conexión (deja de figurar en línea y de recibir avisos) sin descartar las suscripciones.
export function disconnectSocket() {
  window.clearTimeout(retryTimer);
  sessionUserId = null;
  socket?.disconnect();
}

if (typeof window !== 'undefined') {
  const wake = () => { if (socket && sessionUserId && !socket.connected && !socket.active) socket.connect(); };
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);
}
