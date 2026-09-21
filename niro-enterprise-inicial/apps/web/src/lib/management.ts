// Gestión de ventas: categorías con las que se cierra una conversación y utilidades de monto.
export type OutcomeKind = 'WON' | 'LOST' | 'QUOTE' | 'OTHER';

export const KIND_LABEL: Record<OutcomeKind, string> = { WON: 'Venta', LOST: 'Perdida', QUOTE: 'Cotización', OTHER: 'Otra gestión' };
export const KIND_HELP: Record<OutcomeKind, string> = {
  WON: 'Cuenta como venta cerrada y suma al monto vendido. Pide el monto.',
  LOST: 'Cuenta como venta perdida.',
  QUOTE: 'Cotización o presupuesto (el monto es opcional).',
  OTHER: 'Cualquier otra gestión que quieras medir.'
};
// Colores por tipo para los gráficos (verde = venta, rojo = perdida, azul = cotización, gris = otra).
export const KIND_COLOR: Record<OutcomeKind, string> = { WON: '#10b981', LOST: '#ef4444', QUOTE: '#0284c7', OTHER: '#94a3b8' };

export interface OutcomeCategory {
  id: string;
  name: string;
  kind: OutcomeKind;
  requiresAmount: boolean;
  color: string;
  active: boolean;
  sortOrder: number;
  used?: number;
}

export interface OutcomeInput { categoryId: string; amount: number | null; note: string | null }

export const formatGs = (value: number) => `Gs. ${Math.round(value).toLocaleString('es-PY')}`;
export const formatCompact = (value: number) => {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1).replace(/\.0$/, '')} mil M`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1).replace(/\.0$/, '')} M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)} mil`;
  return String(Math.round(value));
};

// "1500000" -> "1.500.000" mientras se escribe.
export function formatAmountInput(raw: string) {
  const digits = raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
export function parseAmountInput(text: string): number | null {
  const digits = text.replace(/\D/g, '');
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface OutcomeRow {
  id: string;
  conversationId: string;
  contact: { id: string; name: string | null; phone: string | null } | null;
  agentId: string | null;
  agentName: string;
  categoryId: string | null;
  categoryName: string;
  kind: OutcomeKind;
  color: string | null;
  amount: number | null;
  note: string | null;
  closedConversation: boolean;
  createdAt: string;
}

export interface Bucket { outcomes: number; won: number; lost: number; quotes: number; other: number; revenue: number; closed: number }
export interface ManagementSummary {
  range: { from: string; to: string };
  totals: Bucket & { avgTicket: number; winRate: number | null };
  byAgent: (Bucket & { agentId: string | null; name: string; avgTicket: number; winRate: number | null; messages: number; chats: number })[];
  byCategory: { categoryId: string | null; name: string; kind: OutcomeKind; color: string; count: number; amount: number }[];
  daily: (Bucket & { day: string })[];
}
