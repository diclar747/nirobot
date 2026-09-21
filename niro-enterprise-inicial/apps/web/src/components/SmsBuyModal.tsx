import { useEffect, useMemo, useRef, useState } from 'react';
import { apiPost, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { Modal } from './Modal';
import { Ui } from './Ui';
import { gs, num, type SmsPurchase } from '../lib/sms';
import '../styles/sms.css';

// Compra de saldo: paquetes o la cantidad que quiera. Cada SMS cuesta lo mismo. Al pagar con tarjeta/QR de Winsap el saldo
// se acredita solo (llega por webhook y también se consulta cada pocos segundos por si el aviso demora).
export function SmsBuyModal({ priceGs, packages, min, max, suggested, onClose, onCredited }: {
  priceGs: number; packages: number[]; min: number; max: number; suggested?: number; onClose: () => void; onCredited: (balance?: number) => void;
}) {
  const need = suggested && suggested > 0 ? Math.max(min, suggested) : 0;
  const [credits, setCredits] = useState<number>(need || packages[1] || packages[0] || 1000);
  const [custom, setCustom] = useState(need && !packages.includes(need) ? String(need) : '');
  const [purchase, setPurchase] = useState<SmsPurchase | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const done = useRef(false);

  const amount = credits * priceGs;
  const valid = Number.isInteger(credits) && credits >= min && credits <= max;
  const packageList = useMemo(() => packages.map((p) => ({ credits: p, amount: p * priceGs })), [packages, priceGs]);

  async function verify(silent = false) {
    if (done.current) return;
    if (!silent) setChecking(true);
    try {
      const res = await apiPost<{ credited: number; balance: number }>('/api/org/sms/purchases/verify', {});
      if (res.credited > 0 && !done.current) { done.current = true; onCredited(res.balance); }
    } catch (err) {
      if (!silent) setError(err instanceof ApiError ? err.message : 'No se pudo verificar el pago');
    } finally { if (!silent) setChecking(false); }
  }

  useEffect(() => {
    if (!purchase) return;
    const socket = getSocket();
    const onBalance = (payload: { balance: number; purchaseId?: string }) => {
      if (done.current) return;
      if (!payload.purchaseId || payload.purchaseId === purchase.id) { done.current = true; onCredited(payload.balance); }
    };
    socket.on('sms:balance', onBalance);
    const timer = window.setInterval(() => verify(true), 6000);
    return () => { socket.off('sms:balance', onBalance); window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchase]);

  async function pay() {
    if (!valid) { setError(`Elegí entre ${num(min)} y ${num(max)} SMS.`); return; }
    setBusy(true); setError(null);
    try {
      const res = await apiPost<{ purchase: SmsPurchase }>('/api/org/sms/purchases', { credits });
      setPurchase(res.purchase);
      if (res.purchase.paymentUrl) window.open(res.purchase.paymentUrl, '_blank', 'noopener');
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo generar el link de pago'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Comprar saldo de SMS" onClose={onClose} className="sms-buy-modal">
      {!purchase ? (
        <div className="sms-buy">
          {suggested !== undefined && suggested > 0 && <div className="alert error" role="alert"><span>Te faltan <b>{num(suggested)}</b> SMS para enviar esta campaña. La compra mínima es de {num(min)} SMS.</span></div>}
          <p className="sms-buy-lead">Cada SMS cuesta <b>{gs(priceGs)}</b>. Elegí un paquete o escribí la cantidad que quieras; se acredita apenas se confirma el pago.</p>
          <div className="sms-packages" role="radiogroup" aria-label="Paquetes">
            {packageList.map((p) => (
              <button type="button" key={p.credits} role="radio" aria-checked={credits === p.credits && !custom} className={`sms-package ${credits === p.credits && !custom ? 'selected' : ''}`} onClick={() => { setCredits(p.credits); setCustom(''); setError(null); }}>
                <b>{num(p.credits)}</b><span>SMS</span><small>{gs(p.amount)}</small>
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor="sms-custom">O la cantidad que quieras</label>
            <input id="sms-custom" className="input" inputMode="numeric" placeholder={`Mínimo ${num(min)}`} value={custom ? num(Number(custom)) : ''} onChange={(e) => { const digits = e.target.value.replace(/\D/g, '').slice(0, 7); setCustom(digits); if (digits) setCredits(Number(digits)); else setCredits(packages[1] || packages[0] || 1000); setError(null); }} />
          </div>
          <div className="sms-total"><span>Total a pagar</span><strong>{gs(amount)}</strong><small>{num(credits)} SMS × {gs(priceGs)}</small></div>
          {error && <div className="alert error" role="alert">{error}</div>}
          <div className="sms-buy-actions">
            <button type="button" className="btn secondary" onClick={onClose}>Cancelar</button>
            <button type="button" className="btn" onClick={pay} disabled={busy || !valid}>{busy ? 'Generando…' : `Pagar ${gs(amount)}`}</button>
          </div>
        </div>
      ) : (
        <div className="sms-buy sms-waiting">
          <span className="sms-spinner" aria-hidden="true" />
          <h3>Esperando tu pago</h3>
          <p>Abrimos la página de pago de Winsap en otra pestaña (tarjeta o QR). Apenas se confirme, tus <b>{num(purchase.credits)} SMS</b> se acreditan solos.</p>
          {purchase.paymentUrl && <a className="btn secondary" href={purchase.paymentUrl} target="_blank" rel="noopener noreferrer"><Ui name="external" size={15} /> Abrir la página de pago</a>}
          {error && <div className="alert error" role="alert">{error}</div>}
          <div className="sms-buy-actions">
            <button type="button" className="btn secondary" onClick={onClose}>Cerrar (sigue esperando el pago)</button>
            <button type="button" className="btn" onClick={() => verify(false)} disabled={checking}>{checking ? 'Verificando…' : 'Ya pagué'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
