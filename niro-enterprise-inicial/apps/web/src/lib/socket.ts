import { io, type Socket } from 'socket.io-client';
import { refreshAccessSession } from './api';

let socket: Socket | null = null;
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

    // The access token lasts 15 minutes. HTTP requests already refresh it, but
    // Socket.IO has its own handshake and otherwise keeps retrying with the
    // expired cookie, leaving incoming WhatsApp messages invisible in the UI.
    current.on('connect_error', async (error) => {
      const message = String(error?.message || '').toLowerCase();
      if (!message.includes('unauthorized') && !message.includes('token')) return;
      const refreshed = await refreshAccessSession();
      if (refreshed && socket === current && !current.connected) current.connect();
    });

    current.connect();
  }
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
