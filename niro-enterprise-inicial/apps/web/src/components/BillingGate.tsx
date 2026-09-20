import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import { getSocket } from '../lib/socket';
import { useAuth } from '../context/AuthContext';
import { BillingPage } from '../routes/Billing';
import '../styles/billing.css';

export interface BillingAccess {
  state: 'trial' | 'active' | 'expired' | 'exempt';
  blocked: boolean;
  msLeft: number;
  endsAt: string | null;
  priceGs: number;
  planName: string;
  planDays: number;
}
export interface BillingPaymentRow { planName?: string | null; id: string; amount: number; status: string; paymentUrl: string | null; paymentMethod: string | null; paidAt: string | null; createdAt: string }
export interface SeatInfo { state: string; planId: string | null; planName: string | null; seats: number; maxAgents: number; agentsUsed: number; activeUsers: number; full: boolean }
export interface PlanInfo { id: string; name: string; description: string | null; priceGs: number; maxAgents: number; features: string[]; popular: boolean }
export interface BillingStatus { access: BillingAccess; payments: BillingPaymentRow[]; online: boolean; seats?: SeatInfo | null }
interface Notice { id: string; title: string; body: string; level: 'info' | 'warning' | 'success'; read: boolean }

export function formatGs(value: number) { return `${new Intl.NumberFormat('es-PY').format(value)} Gs`; }

export function formatLeft(ms: number) {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${mins} min`;
  return `${mins} min`;
}

/** Muestra el banner de prueba/plan, los avisos del superadmin y, si la prueba venció, el muro de pago. */
export function BillingGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [locked, setLocked] = useState(false);
  const enabled = Boolean(user && user.role !== 'SUPERADMIN');

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await apiGet<BillingStatus>('/api/org/billing/status');
      setStatus(data);
      setLocked(data.access.blocked);
      const list = await apiGet<{ notices: Notice[] }>('/api/org/billing/notices');
      setNotices(list.notices.filter((n) => !n.read));
    } catch { /* si falla la consulta no bloqueamos la app */ }
  }, [enabled]);

  useEffect(() => { refresh(); const timer = setInterval(refresh, 60000); return () => clearInterval(timer); }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    const onLocked = () => setLocked(true);
    window.addEventListener('niro:subscription-required', onLocked);
    const socket = getSocket();
    socket.on('billing:updated', refresh);
    socket.on('notice:new', refresh);
    return () => { window.removeEventListener('niro:subscription-required', onLocked); socket.off('billing:updated', refresh); socket.off('notice:new', refresh); };
  }, [enabled, refresh]);

  async function dismiss(id: string) {
    setNotices((prev) => prev.filter((n) => n.id !== id));
    apiPost(`/api/org/billing/notices/${id}/read`).catch(() => {});
  }

  if (!enabled) return <>{children}</>;
  if (locked || status?.access.blocked) return <BillingPage status={status} onRefresh={refresh} expired />;

  const access = status?.access;
  const showTrial = access?.state === 'trial';
  const showRenew = access?.state === 'active' && access.msLeft < 3 * 24 * 3600 * 1000;
  return (
    <>
      {showTrial && access && (
        <div className={`billing-banner ${access.msLeft < 3 * 3600 * 1000 ? 'urgent' : ''}`}>
          <span>⏳ <b>Prueba gratuita:</b> te quedan <b>{formatLeft(access.msLeft)}</b>. Después activá el plan de {formatGs(access.priceGs)} por mes.</span>
          {location.pathname !== '/billing' && <Link to="/billing" className="billing-banner-btn">Activar plan</Link>}
        </div>
      )}
      {showRenew && access && (
        <div className="billing-banner urgent">
          <span>🔔 Tu plan vence en <b>{formatLeft(access.msLeft)}</b>. Renovalo para no perder el acceso.</span>
          <Link to="/billing" className="billing-banner-btn">Renovar</Link>
        </div>
      )}
      {notices.slice(0, 2).map((notice) => (
        <div key={notice.id} className={`billing-notice ${notice.level}`}>
          <div><b>{notice.title}</b><span>{notice.body}</span></div>
          <button type="button" onClick={() => dismiss(notice.id)} aria-label="Cerrar aviso">×</button>
        </div>
      ))}
      {children}
    </>
  );
}
