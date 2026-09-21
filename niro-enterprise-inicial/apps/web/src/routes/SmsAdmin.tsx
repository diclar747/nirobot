import { FormEvent, useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, ApiError } from '../lib/api';
import { useAlerts } from '../context/AlertContext';
import { EmptyState, LoadingRows, PageHeader, PageShell, Panel, Pill, StatCard, StatGrid } from '../components/PageKit';
import { Modal } from '../components/Modal';
import { Ui } from '../components/Ui';
import { gs, num } from '../lib/sms';
import '../styles/sms.css';

interface AdminOverview {
  provider: { configured: boolean; balance: number | null; error: string | null };
  priceGs: number;
  totals: { creditsSold: number; revenue: number; customerBalance: number; sent: number; failed: number };
  organizations: { id: string; name: string; active: boolean; balance: number; sent: number; failed: number; creditsCard: number; creditsAdmin: number }[];
}

// Superadmin: saldo real en Winsap, lo vendido y el saldo de cada empresa; asignar SMS a mano.
export function SmsAdmin() {
  const { notify } = useAlerts();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<AdminOverview['organizations'][number] | null>(null);
  const load = useCallback(() => { apiGet<AdminOverview>('/api/superadmin/sms/overview').then(setData).catch((err) => setError(err instanceof ApiError ? err.message : 'No se pudo cargar')); }, []);
  useEffect(() => { load(); }, [load]);

  async function registerWebhook() {
    try { await apiPost('/api/superadmin/sms/webhook/register', {}); notify('Webhook de entregas registrado en Winsap.', { tone: 'success' }); }
    catch (err) { notify(err instanceof ApiError ? err.message : 'No se pudo registrar el webhook', { tone: 'error' }); }
  }
  const providerLow = data?.provider.balance != null && data.provider.balance < data.totals.customerBalance;

  return (
    <PageShell>
      <PageHeader icon={<Ui name="smartphone" size={22} />} title="SMS · administración" subtitle="Saldo del proveedor, SMS vendidos y saldo de cada empresa." actions={<button type="button" className="btn secondary" onClick={registerWebhook}><Ui name="plug" size={15} /> Registrar webhook de entregas</button>} />
      {error && <div className="alert error">{error}</div>}
      {!data ? <LoadingRows /> : (
        <>
          <Panel title="Proveedor (Winsap)">
            <div className="sms-admin-provider">
              <div><span className="sms-eyebrow">SALDO REAL EN WINSAP</span>
                <div className="sms-balance"><b>{data.provider.balance === null ? '—' : num(data.provider.balance)}</b><span>SMS</span></div></div>
              <div>
                {!data.provider.configured && <Pill tone="danger" dot>Sin clave configurada</Pill>}
                {data.provider.error && <Pill tone="danger" dot>{data.provider.error}</Pill>}
                {providerLow && <div className="alert error" style={{ marginTop: 8 }}>Ojo: los clientes tienen {num(data.totals.customerBalance)} SMS de saldo y en Winsap quedan menos. Recargá para poder cubrirlos.</div>}
                <small style={{ color: 'var(--text-dim)' }}>Precio al cliente: {gs(data.priceGs)} por SMS</small>
              </div>
            </div>
          </Panel>
          <div className="mgmt-kpis"><StatGrid>
            <StatCard label="SMS vendidos" value={num(data.totals.creditsSold)} hint="recargas acreditadas" tone="primary" />
            <StatCard label="Facturado" value={gs(data.totals.revenue)} hint="ventas de saldo" tone="success" />
            <StatCard label="Saldo de clientes" value={num(data.totals.customerBalance)} hint="SMS sin usar" tone="violet" />
            <StatCard label="Enviados" value={num(data.totals.sent)} hint="en total" tone="neutral" />
            <StatCard label="Fallidos" value={num(data.totals.failed)} hint="en total" tone="danger" />
          </StatGrid></div>
          <Panel flush title="Empresas">
            {data.organizations.length === 0 ? <EmptyState icon={<Ui name="smartphone" size={24} />} title="Todavía no hay actividad de SMS" text="Cuando una empresa compre o envíe SMS aparece acá." /> : (
              <div className="page-table-wrap"><table className="mgmt-table"><thead><tr><th>Empresa</th><th className="num">Saldo</th><th className="num">Enviados</th><th className="num">Fallidos</th><th className="num">Comprados (pago)</th><th className="num">Asignados</th><th /></tr></thead>
                <tbody>{data.organizations.map((o) => (<tr key={o.id}><td><b>{o.name}</b>{!o.active && <small className="mgmt-sub">Inactiva</small>}</td><td className="num strong">{num(o.balance)}</td><td className="num">{num(o.sent)}</td><td className="num">{num(o.failed)}</td><td className="num">{num(o.creditsCard)}</td><td className="num">{num(o.creditsAdmin)}</td>
                  <td><button type="button" className="btn small" onClick={() => setAssigning(o)}>Asignar SMS</button></td></tr>))}</tbody></table></div>
            )}
          </Panel>
        </>
      )}
      {assigning && <AssignModal org={assigning} priceGs={data?.priceGs || 130} onClose={() => setAssigning(null)} onDone={() => { setAssigning(null); load(); }} />}
    </PageShell>
  );
}

function AssignModal({ org, priceGs, onClose, onDone }: { org: { id: string; name: string; balance: number }; priceGs: number; onClose: () => void; onDone: () => void }) {
  const { notify } = useAlerts();
  const [credits, setCredits] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = Number(credits.replace(/[^\d-]/g, ''));
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!Number.isInteger(value) || value === 0) { setError('Escribí la cantidad de SMS (usá un número negativo para descontar).'); return; }
    setBusy(true); setError(null);
    try {
      const res = await apiPost<{ balance: number }>(`/api/superadmin/sms/organizations/${org.id}/credits`, { credits: value, note: note.trim() || undefined });
      notify(`${org.name} ahora tiene ${num(res.balance)} SMS.`, { tone: 'success' }); onDone();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo asignar'); setBusy(false); }
  }
  return (
    <Modal title={`Asignar SMS · ${org.name}`} onClose={onClose}>
      <form onSubmit={submit} className="outcome-form">
        <p className="outcome-lead">Saldo actual: <b>{num(org.balance)} SMS</b>. Lo que cargues se suma a su saldo y queda en su historial de compras (para ventas por transferencia, cortesías o correcciones).</p>
        <div className="field"><label htmlFor="sms-credits">Cantidad de SMS</label><input id="sms-credits" className="input" inputMode="numeric" value={credits} onChange={(e) => setCredits(e.target.value)} placeholder="Ej.: 1000 (o -200 para descontar)" autoFocus />
          {value > 0 && <small className="area-help">Equivale a {gs(value * priceGs)} al precio de lista.</small>}</div>
        <div className="field"><label htmlFor="sms-note">Nota (opcional)</label><input id="sms-note" className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Ej.: pagó por transferencia" /></div>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="outcome-actions"><button type="button" className="btn secondary" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button></div>
      </form>
    </Modal>
  );
}
