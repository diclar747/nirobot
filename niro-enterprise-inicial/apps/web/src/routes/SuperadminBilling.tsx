import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost, apiDelete, ApiError } from '../lib/api';
import { Modal } from '../components/Modal';
import { EmptyState, LoadingRows, PageHeader, PageShell, Panel, PersonCell, Pill, StatCard, StatGrid, type Tone } from '../components/PageKit';
import { formatGs } from '../components/BillingGate';

interface Customer {
  id: string; name: string; active: boolean; createdAt: string; phone: string | null;
  owner: { name: string; email: string } | null; users: number; contacts: number;
  state: 'trial' | 'active' | 'expired' | 'exempt'; hasPending: boolean; plan: { id: string; name: string; maxAgents: number } | null;
  trialEndsAt: string; paidUntil: string | null; lastPayment: { amount: number; paidAt: string } | null;
}
interface Overview { summary: { total: number; active: number; trial: number; expired: number; exempt: number; pending: number; revenueTotal: number; revenueMonth: number; payments: number; priceGs: number }; customers: Customer[] }
interface Notice { id: string; audience: string; organizationName: string | null; title: string; body: string; level: string; createdAt: string; reads: number }
interface Detail { users: { id: string; name: string; email: string; role: string; active: boolean }[]; payments: { id: string; amount: number; status: string; paymentMethod: string | null; paidAt: string | null; createdAt: string }[] }

const STATE_LABEL: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Pagado', tone: 'success' }, trial: { label: 'En prueba', tone: 'primary' },
  expired: { label: 'Vencido / no pagó', tone: 'danger' }, exempt: { label: 'Sin cargo', tone: 'violet' }
};
const AUDIENCE_LABEL: Record<string, string> = { all: 'Todos los clientes', trial: 'En prueba', active: 'Con plan pagado', expired: 'Vencidos', org: 'Un cliente' };
const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleString('es-PY', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export function SuperadminBilling() {
  const [data, setData] = useState<Overview | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [filter, setFilter] = useState<'all' | 'active' | 'trial' | 'expired' | 'pending'>('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ customer: Customer; data: Detail } | null>(null);
  const [plans, setPlans] = useState<{ id: string; name: string; maxAgents: number }[]>([]);
  const [grantPlan, setGrantPlan] = useState('');
  const [showNotice, setShowNotice] = useState<Customer | 'broadcast' | null>(null);

  const load = useCallback(async () => {
    try {
      const [overview, list] = await Promise.all([apiGet<Overview>('/api/superadmin/billing/overview'), apiGet<{ notices: Notice[] }>('/api/superadmin/notices')]);
      setData(overview); setNotices(list.notices);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo cargar la facturación'); }
  }, []);
  useEffect(() => { load(); apiGet<{ plans: { id: string; name: string; maxAgents: number }[] }>('/api/superadmin/plans').then((r) => setPlans(r.plans)).catch(() => {}); }, [load]);

  const rows = useMemo(() => (data?.customers || []).filter((c) => {
    if (filter === 'pending' ? !(c.hasPending && c.state !== 'active') : filter !== 'all' && c.state !== filter) return false;
    const q = query.trim().toLowerCase();
    return !q || `${c.name} ${c.phone || ''} ${c.owner?.email || ''}`.toLowerCase().includes(q);
  }), [data, filter, query]);

  async function action(path: string, body: unknown, customer?: Customer) {
    try {
      await apiPost(path, body);
      await load();
      if (customer && detail) openDetail(customer);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo aplicar la acción'); }
  }
  async function openDetail(customer: Customer) {
    const d = await apiGet<Detail>(`/api/superadmin/billing/organizations/${customer.id}/users`);
    setDetail({ customer, data: d });
  }

  const s = data?.summary;
  return (
    <PageShell>
      <PageHeader title="Clientes y cobros" subtitle={`Plan mensual ${s ? formatGs(s.priceGs) : ''} · 24 h de prueba por teléfono conectado`}
        actions={<button className="btn" onClick={() => setShowNotice('broadcast')}>📣 Enviar aviso</button>} />
      {error && <div className="campaign-alert error" style={{ marginBottom: 12 }}>{error}</div>}
      <StatGrid>
        <StatCard label="Clientes" value={s?.total ?? '—'} hint="Teléfonos conectados" tone="primary" />
        <StatCard label="Pagados" value={s?.active ?? '—'} hint="Plan vigente" tone="success" />
        <StatCard label="En prueba" value={s?.trial ?? '—'} hint="Dentro de las 24 h" tone="violet" />
        <StatCard label="Vencidos" value={s?.expired ?? '—'} hint="No pagaron" tone="danger" />
        <StatCard label="Cobrado este mes" value={s ? formatGs(s.revenueMonth) : '—'} hint={s ? `${formatGs(s.revenueTotal)} en total` : ''} tone="success" />
      </StatGrid>

      <Panel flush title="Clientes" actions={
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="input" style={{ width: 220 }} placeholder="Buscar nombre, teléfono, email…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {(['all', 'active', 'trial', 'expired', 'pending'] as const).map((f) => (
            <button key={f} className={`btn small ${filter === f ? '' : 'secondary'}`} onClick={() => setFilter(f)}>
              {{ all: 'Todos', active: 'Pagados', trial: 'En prueba', expired: 'No pagaron', pending: 'Pago pendiente' }[f]}
            </button>
          ))}
        </div>}>
        {!data ? <LoadingRows /> : rows.length === 0 ? <EmptyState title="Sin clientes en este filtro" /> : (
          <div className="page-table-wrap"><table>
            <thead><tr><th>Cliente</th><th>Teléfono</th><th>Plan</th><th>Estado</th><th>Vence</th><th>Último pago</th><th className="num">Usuarios</th><th></th></tr></thead>
            <tbody>{rows.map((c) => {
              const st = STATE_LABEL[c.state];
              return (
                <tr key={c.id}>
                  <td><PersonCell name={c.name} detail={c.owner?.email || '—'} /></td>
                  <td>{c.phone ? `+${c.phone}` : '—'}</td>
                  <td>{c.plan ? `${c.plan.name} · ${c.plan.maxAgents} ag.` : '—'}</td>
                  <td><Pill tone={st.tone} dot>{st.label}</Pill>{c.hasPending && c.state !== 'active' && <> <Pill tone="warning">Pago pendiente</Pill></>}</td>
                  <td>{c.state === 'active' ? fmtDate(c.paidUntil) : c.state === 'trial' ? fmtDate(c.trialEndsAt) : '—'}</td>
                  <td>{c.lastPayment ? `${formatGs(c.lastPayment.amount)} · ${fmtDate(c.lastPayment.paidAt)}` : '—'}</td>
                  <td className="num">{c.users}</td>
                  <td className="actions"><button className="btn secondary small" onClick={() => openDetail(c)}>Gestionar</button></td>
                </tr>);
            })}</tbody></table></div>
        )}
      </Panel>

      <Panel flush title="Avisos enviados">
        {notices.length === 0 ? <EmptyState title="Todavía no enviaste avisos" text="Los avisos aparecen como banner dentro del sistema de tus clientes." /> : (
          <div className="page-table-wrap"><table>
            <thead><tr><th>Aviso</th><th>Para</th><th>Fecha</th><th className="num">Leído por</th><th></th></tr></thead>
            <tbody>{notices.map((n) => (
              <tr key={n.id}><td><b>{n.title}</b><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{n.body.slice(0, 90)}</div></td>
                <td>{n.organizationName || AUDIENCE_LABEL[n.audience]}</td><td>{fmtDate(n.createdAt)}</td><td className="num">{n.reads}</td>
                <td className="actions"><button className="btn secondary small" onClick={async () => { await apiDelete(`/api/superadmin/notices/${n.id}`); load(); }}>Borrar</button></td></tr>))}</tbody></table></div>
        )}
      </Panel>

      {detail && (
        <Modal title={detail.customer.name} onClose={() => setDetail(null)}>
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select className="input" style={{ width: 'auto', padding: '5px 8px' }} value={grantPlan || detail.customer.plan?.id || ''} onChange={(e) => setGrantPlan(e.target.value)} aria-label="Plan a otorgar"><option value="">Sin cambiar plan</option>{plans.map((pl) => <option key={pl.id} value={pl.id}>{pl.name} ({pl.maxAgents} agentes)</option>)}</select>
              <button className="btn small" onClick={() => action(`/api/superadmin/billing/organizations/${detail.customer.id}/grant`, { days: 30, ...(grantPlan || detail.customer.plan?.id ? { planId: grantPlan || detail.customer.plan?.id } : {}) }, detail.customer)}>+30 días de plan</button>
              <button className="btn secondary small" onClick={() => action(`/api/superadmin/billing/organizations/${detail.customer.id}/trial`, { hours: 24 }, detail.customer)}>+24 h de prueba</button>
              <button className="btn secondary small" onClick={() => action(`/api/superadmin/billing/organizations/${detail.customer.id}/exempt`, { exempt: detail.customer.state !== 'exempt' }, detail.customer)}>{detail.customer.state === 'exempt' ? 'Quitar sin cargo' : 'Marcar sin cargo'}</button>
              <button className="btn secondary small" onClick={() => { setShowNotice(detail.customer); setDetail(null); }}>📣 Avisar</button>
            </div>
            <div><h4 style={{ margin: '0 0 6px' }}>Usuarios ({detail.data.users.length})</h4>
              {detail.data.users.map((u) => <div key={u.id} style={{ fontSize: 13, padding: '3px 0' }}>{u.name} · {u.email} · <Pill tone={u.active ? 'success' : 'neutral'}>{u.role}</Pill></div>)}</div>
            <div><h4 style={{ margin: '0 0 6px' }}>Pagos</h4>
              {detail.data.payments.length === 0 ? <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Sin pagos todavía</span> : detail.data.payments.map((p) => <div key={p.id} style={{ fontSize: 13, padding: '3px 0' }}>{fmtDate(p.createdAt)} · {formatGs(p.amount)} · {p.status}{p.paymentMethod ? ` · ${p.paymentMethod}` : ''}</div>)}</div>
          </div>
        </Modal>
      )}
      {showNotice && <NoticeModal target={showNotice} onClose={() => setShowNotice(null)} onSent={() => { setShowNotice(null); load(); }} />}
    </PageShell>
  );
}

function NoticeModal({ target, onClose, onSent }: { target: Customer | 'broadcast'; onClose: () => void; onSent: () => void }) {
  const [audience, setAudience] = useState(target === 'broadcast' ? 'all' : 'org');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [level, setLevel] = useState('info');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try { await apiPost('/api/superadmin/notices', { title, body, level, audience, organizationId: target === 'broadcast' ? undefined : target.id }); onSent(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo enviar'); setBusy(false); }
  }
  return (
    <Modal title={target === 'broadcast' ? 'Enviar aviso a clientes' : `Aviso para ${target.name}`} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        {target === 'broadcast' && <label className="field"><span>Destinatarios</span><select className="input" value={audience} onChange={(e) => setAudience(e.target.value)}>{['all', 'trial', 'active', 'expired'].map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}</select></label>}
        <label className="field"><span>Título</span><input className="input" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Mantenimiento programado" /></label>
        <label className="field"><span>Mensaje</span><textarea className="input" required rows={4} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        <label className="field"><span>Tipo</span><select className="input" value={level} onChange={(e) => setLevel(e.target.value)}><option value="info">Información</option><option value="warning">Advertencia</option><option value="success">Novedad</option></select></label>
        {error && <div className="campaign-alert error">{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn secondary" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy}>{busy ? 'Enviando…' : 'Enviar aviso'}</button></div>
      </form>
    </Modal>
  );
}
