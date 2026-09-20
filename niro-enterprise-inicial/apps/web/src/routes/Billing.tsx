import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiGet, apiPost, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { formatGs, formatLeft, type BillingStatus } from '../components/BillingGate';
import { Logo } from '../components/Logo';
import '../styles/billing.css';

const BENEFITS = [
  'Conversaciones ilimitadas con tu WhatsApp conectado',
  'CRM, etiquetas, agentes y transferencias',
  'Campañas masivas, programadas y a grupos',
  'Bot de flujos + asistentes con IA',
  'Llamadas, pedidos y reportes completos'
];

const STATUS_LABEL: Record<string, string> = { paid: 'Pagado', pending: 'Pendiente', failed: 'Fallido', expired: 'Vencido' };

export function BillingPage({ status: initial, onRefresh, expired }: { status: BillingStatus | null; onRefresh?: () => void; expired?: boolean }) {
  const { user, logout } = useAuth();
  const [params] = useSearchParams();
  const [status, setStatus] = useState<BillingStatus | null>(initial);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const canPay = user ? ['OWNER', 'ADMIN'].includes(user.role) : false;

  useEffect(() => { setStatus(initial); }, [initial]);
  useEffect(() => { if (!initial) apiGet<BillingStatus>('/api/org/billing/status').then(setStatus).catch(() => {}); }, [initial]);

  async function verify(silent = false) {
    if (!silent) setChecking(true);
    try {
      const res = await apiPost<{ activated: number }>('/api/org/billing/verify');
      const fresh = await apiGet<BillingStatus>('/api/org/billing/status');
      setStatus(fresh);
      if (res.activated > 0) { setInfo('¡Pago recibido! Tu plan está activo.'); onRefresh?.(); }
      else if (!silent) setInfo('Todavía no vemos el pago. Si ya pagaste, esperá unos segundos y volvé a comprobar.');
    } catch (err) {
      if (!silent) setError(err instanceof ApiError ? err.message : 'No se pudo comprobar el pago');
    } finally { setChecking(false); }
  }

  // Al volver de la pasarela (?paid=1) comprobamos solos, con reintentos, porque el webhook puede tardar unos segundos.
  useEffect(() => {
    if (params.get('paid') !== '1') return;
    let tries = 0;
    verify(true);
    const timer = setInterval(() => { tries += 1; if (tries > 8) clearInterval(timer); else verify(true); }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pay() {
    setBusy(true); setError(null);
    try {
      const res = await apiPost<{ payment: { paymentUrl: string } }>('/api/org/billing/checkout');
      window.location.href = res.payment.paymentUrl;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo iniciar el pago');
      setBusy(false);
    }
  }

  const access = status?.access;
  const price = access?.priceGs ?? 49000;
  return (
    <div className={`billing-page ${expired ? 'wall' : ''}`}>
      <div className="billing-card">
        <div className="billing-brand"><Logo size={40} /><span>NIRO</span></div>
        {expired ? (
          <>
            <span className="billing-tag expired">Plan demo vencido</span>
            <h1>Tu prueba gratuita terminó</h1>
            <p className="billing-lead">Activá tu plan para seguir disfrutando de todos los beneficios de Niro. Tus chats, contactos y configuraciones siguen guardados.</p>
          </>
        ) : access?.state === 'active' ? (
          <>
            <span className="billing-tag active">Plan activo</span>
            <h1>Tu plan está al día</h1>
            <p className="billing-lead">Vence en <b>{formatLeft(access.msLeft)}</b>{access.endsAt ? ` (${new Date(access.endsAt).toLocaleDateString('es-PY', { dateStyle: 'long' })})` : ''}. Podés renovar cuando quieras: se suma al tiempo restante.</p>
          </>
        ) : access?.state === 'exempt' ? (
          <>
            <span className="billing-tag active">Cuenta sin cargo</span>
            <h1>Tu cuenta tiene acceso completo</h1>
          </>
        ) : (
          <>
            <span className="billing-tag trial">Prueba gratuita</span>
            <h1>Te quedan {access ? formatLeft(access.msLeft) : '…'} de prueba</h1>
            <p className="billing-lead">Probá todo el sistema sin límites. Si activás el plan ahora, se suman 30 días desde el pago.</p>
          </>
        )}

        <div className="billing-price"><strong>{formatGs(price)}</strong><span>por mes · pago con tarjeta o QR</span></div>
        <ul className="billing-benefits">{BENEFITS.map((item) => <li key={item}>✓ {item}</li>)}</ul>

        {error && <div className="billing-alert error">{error}</div>}
        {info && <div className="billing-alert ok">{info}</div>}
        {status && !status.online && <div className="billing-alert error">El cobro en línea no está disponible por el momento. Contactá a soporte.</div>}

        {canPay ? (
          <div className="billing-actions">
            <button type="button" className="billing-pay" onClick={pay} disabled={busy || (status ? !status.online : false)}>{busy ? 'Abriendo pasarela…' : access?.state === 'active' ? 'Renovar plan' : 'Activar plan ahora'}</button>
            <button type="button" className="billing-secondary" onClick={() => verify()} disabled={checking}>{checking ? 'Comprobando…' : 'Ya pagué, comprobar'}</button>
          </div>
        ) : (
          <div className="billing-alert error">Solo el administrador de la cuenta puede activar el plan. Pedile que lo haga.</div>
        )}
        <p className="billing-secure">🔒 Pago procesado por Winsap · Bancard. No guardamos datos de tu tarjeta.</p>

        {status && status.payments.length > 0 && (
          <div className="billing-history">
            <h3>Historial de pagos</h3>
            {status.payments.map((p) => (
              <div key={p.id} className="billing-history-row">
                <span>{new Date(p.createdAt).toLocaleString('es-PY', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                <span>{formatGs(p.amount)}</span>
                <span className={`billing-pill ${p.status}`}>{STATUS_LABEL[p.status] || p.status}</span>
                {p.status === 'pending' && p.paymentUrl && <a href={p.paymentUrl}>Continuar pago</a>}
              </div>
            ))}
          </div>
        )}

        {expired && <button type="button" className="billing-logout" onClick={() => logout()}>Cerrar sesión</button>}
      </div>
    </div>
  );
}

export function Billing() {
  return <BillingPage status={null} />;
}
