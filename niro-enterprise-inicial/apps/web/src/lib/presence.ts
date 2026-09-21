import type { AgentPresenceStatus } from '../types';

// Estados de presencia. Los que se pueden elegir (SELECTABLE) los cambia la persona; "offline" lo deriva el servidor.
export const PRESENCE_LABEL: Record<AgentPresenceStatus, string> = {
  available: 'En línea',
  busy: 'Ocupado',
  pending: 'Pendiente',
  break: 'Receso',
  rest: 'Descanso',
  away: 'Ausente',
  offline: 'Desconectado'
};
export const PRESENCE_COLOR: Record<AgentPresenceStatus, string> = {
  available: '#10b981',
  busy: '#ef4444',
  pending: '#f59e0b',
  break: '#8b5cf6',
  rest: '#0ea5e9',
  away: '#94a3b8',
  offline: '#64748b'
};
export const PRESENCE_HELP: Partial<Record<AgentPresenceStatus, string>> = {
  available: 'Atendiendo chats con normalidad',
  busy: 'Atendiendo algo importante',
  pending: 'Con tareas o chats pendientes',
  break: 'Pausa corta',
  rest: 'Descanso o almuerzo',
  away: 'Lejos del teclado'
};
export const PRESENCE_SELECTABLE: AgentPresenceStatus[] = ['available', 'busy', 'pending', 'break', 'rest', 'away'];
export const PRESENCE_ORDER: Record<AgentPresenceStatus, number> = { available: 0, busy: 1, pending: 2, break: 3, rest: 4, away: 5, offline: 6 };

// El estado elegido se recuerda en este navegador: al reconectarse (o si el servidor se reinicia) se vuelve a informar.
const KEY = (userId: string) => `niro.presence.${userId}`;
export function readPresence(userId: string): AgentPresenceStatus {
  try {
    const value = localStorage.getItem(KEY(userId)) as AgentPresenceStatus | null;
    return value && PRESENCE_SELECTABLE.includes(value) ? value : 'available';
  } catch { return 'available'; }
}
export function savePresence(userId: string, status: AgentPresenceStatus) {
  try { localStorage.setItem(KEY(userId), status); } catch { /* sin almacenamiento: no pasa nada */ }
}
