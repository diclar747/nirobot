import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { useAuth } from '../context/AuthContext';
import { useAlerts } from '../context/AlertContext';
import { EmptyState, LoadingRows, PageHeader, PageShell, Panel, Pill, StatCard, StatGrid, type Tone } from '../components/PageKit';
import { Modal } from '../components/Modal';
import { Ui } from '../components/Ui';
import { ColumnChart } from '../components/ManagementCharts';
import { BulkBar, EMPTY_FILTERS, ListFilters, filtersActive, inDateRange, type ListFilterState } from '../components/ListFilters';
import { SmsBuyModal } from '../components/SmsBuyModal';
import { SmsListInput } from '../components/SmsListInput';
import { SmsCampaignWizard, type NeedBalance, type WizardSource } from '../components/SmsCampaignWizard';
import { analyzeText, formatPhone, gs, num, type ParsedList, type SmsCampaign, type SmsCampaignStatus, type SmsMessage, type SmsMessageStatus, type SmsOverview, type SmsPurchase, type SmsTransaction } from '../lib/sms';
import '../styles/sms.css';

type Tab = 'overview' | 'campaigns' | 'quick' | 'history' | 'balance';
type Preset = '7d' | '30d' | 'month';

const CAMPAIGN_LABEL: Record<SmsCampaignStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Borrador', tone: 'neutral' }, SCHEDULED: { label: 'Programada', tone: 'primary' }, SENDING: { label: 'Enviando', tone: 'warning' },
  PAUSED: { label: 'Pausada', tone: 'warning' }, COMPLETED: { label: 'Completada', tone: 'success' }, CANCELLED: { label: 'Cancelada', tone: 'neutral' }
};
const MESSAGE_LABEL: Record<SmsMessageStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pendiente', tone: 'neutral' }, SENDING: { label: 'Enviando', tone: 'warning' }, SENT: { label: 'Enviado', tone: 'success' },
  DELIVERED: { label: 'Entregado', tone: 'success' }, FAILED: { label: 'Fallido', tone: 'danger' }, CANCELLED: { label: 'Cancelado', tone: 'neutral' }
};
const TX_LABEL: Record<SmsTransaction['type'], string> = { PURCHASE: 'Recarga', CONSUMPTION: 'Envío', REFUND: 'Devolución', ADJUSTMENT: 'Ajuste' };
const GROUPS: { key: string; label: string; match: (s: SmsCampaignStatus) => boolean }[] = [
  { key: 'all', label: 'Todas', match: () => true },
  { key: 'pending', label: 'Pendientes', match: (s) => s === 'DRAFT' || s === 'SCHEDULED' },
  { key: 'sending', label: 'Enviando', match: (s) => s === 'SENDING' },
  { key: 'paused', label: 'Pausadas', match: (s) => s === 'PAUSED' },
  { key: 'completed', label: 'Completadas', match: (s) => s === 'COMPLETED' },
  { key: 'cancelled', label: 'Canceladas', match: (s) => s === 'CANCELLED' }
];
const DAY_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Asuncion', year: 'numeric', month: '2-digit', day: '2-digit' });
const dateTime = (v: string | null) => (v ? new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v)) : '—');
const PAGE = 25;

function presetRange(preset: Preset) {
  const now = new Date();
  const start = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  if (preset === '7d') return { from: start(new Date(now.getTime() - 6 * 86400000)), to: now };
  if (preset === 'month') return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
  return { from: start(new Date(now.getTime() - 29 * 86400000)), to: now };
}

export function Sms() {
  const { user } = useAuth();
  const { confirm, notify } = useAlerts();
  const canBuy = Boolean(user && ['OWNER', 'ADMIN'].includes(user.role));
  const [tab, setTab] = useState<Tab>('overview');
  const [preset, setPreset] = useState<Preset>('30d');
  const [overview, setOverview] = useState<SmsOverview | null>(null);
  const [campaigns, setCampaigns] = useState<SmsCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wizard, setWizard] = useState<{ mode: 'create' | 'edit' | 'duplicate'; source?: WizardSource } | null>(null);
  const [buy, setBuy] = useState<{ suggested?: number } | null>(null);
  const [detail, setDetail] = useState<SmsCampaign | null>(null);
  const [editText, setEditText] = useState<SmsCampaign | null>(null);

  const range = useMemo(() => presetRange(preset), [preset]);
  const load = useCallback(async () => {
    setError(null);
    try {
      const [ov, list] = await Promise.all([
        apiGet<SmsOverview>(`/api/org/sms/overview?from=${encodeURIComponent(range.from.toISOString())}&to=${encodeURIComponent(range.to.toISOString())}`),
        apiGet<{ campaigns: SmsCampaign[] }>('/api/org/sms/campaigns')
      ]);
      setOverview(ov); setCampaigns(list.campaigns);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo cargar el módulo de SMS'); }
    finally { setLoading(false); }
  }, [range]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const socket = getSocket();
    const onUpdated = ({ campaign, balance }: { campaign: SmsCampaign; balance: number }) => {
      setCampaigns((cur) => (cur.some((c) => c.id === campaign.id) ? cur.map((c) => (c.id === campaign.id ? campaign : c)) : [campaign, ...cur]));
      setOverview((o) => (o ? { ...o, balance } : o));
      setDetail((d) => (d?.id === campaign.id ? campaign : d));
    };
    const onBalance = ({ balance }: { balance: number }) => setOverview((o) => (o ? { ...o, balance } : o));
    socket.on('sms:updated', onUpdated); socket.on('sms:balance', onBalance);
    return () => { socket.off('sms:updated', onUpdated); socket.off('sms:balance', onBalance); };
  }, []);

  // Volver del pago (?paid=1): consulta a Winsap por si el aviso demoró.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('paid') === '1' && canBuy) {
      apiPost<{ credited: number; balance: number }>('/api/org/sms/purchases/verify', {}).then((r) => { if (r.credited > 0) { notify('Tu saldo de SMS ya está acreditado.', { tone: 'success' }); load(); } }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openBuy = (suggested?: number) => { if (!canBuy) { notify('Solo el propietario o un administrador puede comprar saldo.', { tone: 'error' }); return; } setBuy({ suggested }); };
  const needBalance = (need: NeedBalance) => {
    setWizard(null); load();
    notify(need.campaignId ? 'La campaña quedó guardada como borrador: no alcanza el saldo para enviarla.' : 'No tenés saldo suficiente para enviar.', { tone: 'error' });
    openBuy(need.missing);
  };

  async function campaignAction(campaign: SmsCampaign, action: 'start' | 'pause' | 'resume' | 'cancel' | 'retry-failed') {
    const c = campaign.counts;
    const toSend = action === 'retry-failed' ? (c?.failed ?? 0) + (c?.pending ?? 0) : (c?.pending ?? 0);
    if (action === 'cancel' && !(await confirm({ title: 'Cancelar campaña', message: 'Los SMS que todavía no salieron se cancelan y no se cobran. Los ya enviados no se pueden deshacer.', confirmLabel: 'Cancelar campaña', tone: 'danger' }))) return;
    if (['start', 'resume', 'retry-failed'].includes(action) && !(await confirm({
      title: action === 'retry-failed' ? 'Reenviar los fallidos' : action === 'resume' ? 'Reanudar el envío' : 'Enviar la campaña',
      message: `Se van a enviar ${num(toSend)} SMS y se descuentan de tu saldo (${num(balance)} disponibles). Podés detener el envío cuando quieras.`,
      confirmLabel: action === 'retry-failed' ? 'Reenviar' : action === 'resume' ? 'Reanudar' : 'Enviar ahora', tone: 'warning'
    }))) return;
    try {
      await apiPost(`/api/org/sms/campaigns/${campaign.id}/${action}`, {});
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SMS_INSUFFICIENT_BALANCE') { openBuy((err.details as { missing?: number } | undefined)?.missing); return; }
      notify(err instanceof ApiError ? err.message : 'No se pudo actualizar la campaña', { tone: 'error' });
    }
  }
  async function openWizard(mode: 'edit' | 'duplicate', campaign: SmsCampaign) {
    try {
      const cfg = await apiGet<{ campaign: SmsCampaign; recipients: { name: string | null; phone: string }[] }>(`/api/org/sms/campaigns/${campaign.id}/config`);
      setWizard({ mode, source: cfg });
    } catch (err) { notify(err instanceof ApiError ? err.message : 'No se pudo cargar la campaña', { tone: 'error' }); }
  }
  async function deleteCampaigns(list: SmsCampaign[]) {
    const deletable = list.filter((c) => c.status !== 'SENDING');
    if (!deletable.length) { notify('Las campañas que están enviando no se pueden eliminar.', { tone: 'error' }); return false; }
    if (!(await confirm({ title: deletable.length > 1 ? `Eliminar ${deletable.length} campañas` : 'Eliminar campaña', message: 'Se borra también su historial de envíos. Los SMS ya enviados no se devuelven. Esta acción no se puede deshacer.', confirmLabel: 'Eliminar', tone: 'danger' }))) return false;
    try {
      const res = await apiPost<{ deleted: string[] }>('/api/org/sms/campaigns/bulk-delete', { ids: deletable.map((c) => c.id) });
      notify(`${res.deleted.length} campaña${res.deleted.length === 1 ? '' : 's'} eliminada${res.deleted.length === 1 ? '' : 's'}.`, { tone: 'success' });
      await load(); return true;
    } catch (err) { notify(err instanceof ApiError ? err.message : 'No se pudo eliminar', { tone: 'error' }); return false; }
  }
  const afterWizard = (info: { edited: boolean; scheduled: boolean; recipients: number; name: string }) => {
    setWizard(null); load();
    notify(info.edited ? `Guardaste los cambios de “${info.name}”.` : info.scheduled ? `“${info.name}” quedó programada (${num(info.recipients)} SMS).` : `“${info.name}” quedó lista con ${num(info.recipients)} SMS. Tocá “Enviar” en su tarjeta cuando quieras empezar.`, { tone: 'success' });
    setTab('campaigns');
  };
  // Editar: antes de salir se edita todo; detenida, solo el texto de lo que falta enviar.
  const editCampaign = (c: SmsCampaign) => (c.status === 'PAUSED' ? setEditText(c) : openWizard('edit', c));

  const balance = overview?.balance ?? 0;
  const low = overview ? overview.balance < 50 : false;

  return (
    <PageShell>
      <PageHeader tone="rose" hero={{ eyebrow: 'Mensajería SMS', title: 'Llegá incluso sin WhatsApp.', text: 'Enviá SMS masivos, seguí cada entrega y recargá saldo cuando lo necesites.', features: [{ icon: 'smartphone', label: 'Celulares de Paraguay' }, { icon: 'check-circle', label: 'Estado de entrega' }, { icon: 'zap', label: 'Recarga al instante' }], art: ['smartphone', 'send', 'mail'] }} icon={<Ui name="smartphone" size={22} />} title="SMS" subtitle="Enviá SMS masivos a tus contactos, seguí cada envío y recargá saldo cuando lo necesites."
        actions={<><button type="button" className="btn secondary" onClick={() => openBuy()} disabled={!canBuy}><Ui name="plus" size={15} /> Comprar saldo</button><button type="button" className="btn" onClick={() => setWizard({ mode: 'create' })}>＋ Nueva campaña</button></>} />

      {overview && !overview.providerReady && <div className="alert error">El envío de SMS todavía no está configurado en el servidor. Avisale al administrador de la plataforma.</div>}
      {error && <div className="alert error">{error}</div>}

      <section className="sms-hero">
        <div>
          <span className="sms-eyebrow">TU SALDO DE SMS</span>
          <div className="sms-balance"><b>{loading ? '—' : num(balance)}</b><span>SMS</span></div>
          <small>{overview ? `Cada SMS cuesta ${gs(overview.priceGs)} · alcanza para ${num(balance)} mensajes de hasta 160 caracteres` : ' '}</small>
        </div>
        <div className="sms-hero-actions">
          <button type="button" className="btn sms-hero-buy" onClick={() => openBuy()} disabled={!canBuy}><Ui name="cart" size={16} /> Comprar saldo</button>
          {low && <span className="sms-low"><Ui name="alert" size={14} /> {balance === 0 ? 'Sin saldo' : 'Saldo bajo'}</span>}
        </div>
      </section>

      <nav className="mgmt-tabs" aria-label="Secciones de SMS">
        {([['overview', 'Resumen'], ['campaigns', 'Campañas'], ['quick', 'Envío rápido'], ['history', 'Historial'], ['balance', 'Saldo y compras']] as [Tab, string][]).map(([key, label]) => (
          <button type="button" key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </nav>

      {tab === 'overview' && <OverviewTab overview={overview} loading={loading} preset={preset} setPreset={setPreset} onOpen={(c) => setDetail(c)} onNew={() => setWizard({ mode: 'create' })} />}
      {tab === 'campaigns' && <CampaignsTab campaigns={campaigns} loading={loading} onAction={campaignAction} onEdit={editCampaign} onDuplicate={(c) => openWizard('duplicate', c)} onDelete={deleteCampaigns} onOpen={setDetail} onNew={() => setWizard({ mode: 'create' })} />}
      {tab === 'quick' && <QuickSend balance={balance} priceGs={overview?.priceGs || 130} onSent={() => { load(); }} onNeedBalance={(missing) => openBuy(missing)} />}
      {tab === 'history' && <HistoryTab />}
      {tab === 'balance' && <BalanceTab balance={balance} canBuy={canBuy} onBuy={() => openBuy()} refreshKey={overview?.balance ?? 0} />}

      {wizard && overview && <SmsCampaignWizard mode={wizard.mode} source={wizard.source} balance={balance} priceGs={overview.priceGs} onClose={() => setWizard(null)} onDone={afterWizard} onNeedBalance={needBalance} />}
      {buy && overview && <SmsBuyModal priceGs={overview.priceGs} packages={overview.packages} min={overview.minPurchase} max={overview.maxPurchase} suggested={buy.suggested} onClose={() => setBuy(null)} onCredited={(b) => { setBuy(null); notify(`¡Listo! Ya tenés ${num(b ?? 0)} SMS de saldo.`, { tone: 'success' }); load(); }} />}
      {detail && <CampaignDetail campaign={detail} onClose={() => setDetail(null)} />}
      {editText && <EditTextModal campaign={editText} onClose={() => setEditText(null)} onSaved={() => { setEditText(null); load(); notify('Guardado. Lo que falta enviar usa el texto nuevo.', { tone: 'success' }); }} />}
    </PageShell>
  );
}

// ---------------------------------------------------------------- Resumen
function OverviewTab({ overview, loading, preset, setPreset, onOpen, onNew }: { overview: SmsOverview | null; loading: boolean; preset: Preset; setPreset: (p: Preset) => void; onOpen: (c: SmsCampaign) => void; onNew: () => void }) {
  const daily = useMemo(() => {
    if (!overview) return [];
    const byDay = new Map(overview.daily.map((d) => [d.day, d]));
    const keys: string[] = []; const seen = new Set<string>();
    for (let t = new Date(overview.range.from).getTime(); t <= new Date(overview.range.to).getTime() + 86400000 && keys.length < 100; t += 86400000) { const k = DAY_KEY.format(new Date(t)); if (!seen.has(k)) { seen.add(k); keys.push(k); } }
    const last = DAY_KEY.format(new Date(overview.range.to));
    return keys.filter((k) => k <= last).map((key) => { const d = byDay.get(key); return { key, label: `${key.slice(8)}/${key.slice(5, 7)}`, value: d?.ok || 0, detail: d ? `${d.failed} fallidos` : 'Sin envíos' }; });
  }, [overview]);
  const t = overview?.totals;
  const rate = t && t.ok + t.failed > 0 ? Math.round((t.ok / (t.ok + t.failed)) * 1000) / 10 : null;
  return (
    <>
      <div className="list-filters"><div className="list-filter-chips" role="tablist" aria-label="Período">
        {([['7d', '7 días'], ['30d', '30 días'], ['month', 'Este mes']] as [Preset, string][]).map(([k, l]) => <button type="button" key={k} role="tab" aria-selected={preset === k} className={`list-chip ${preset === k ? 'active' : ''}`} onClick={() => setPreset(k)}>{l}</button>)}
      </div></div>
      <div className="mgmt-kpis"><StatGrid>
        <StatCard label="SMS enviados" value={loading ? '—' : num(t?.ok ?? 0)} hint={rate !== null ? `${rate.toLocaleString('es')} % de éxito` : 'en el período'} tone="success" />
        <StatCard label="Fallidos" value={loading ? '—' : num(t?.failed ?? 0)} hint="no se cobran" tone="danger" />
        <StatCard label="Saldo usado" value={loading ? '—' : num(overview?.creditsUsed ?? 0)} hint={overview ? gs((overview.creditsUsed || 0) * overview.priceGs) : undefined} tone="primary" />
        <StatCard label="Entregados" value={loading ? '—' : num(t?.delivered ?? 0)} hint="confirmados por el operador" tone="violet" />
        <StatCard label="En cola" value={loading ? '—' : num(t?.pending ?? 0)} hint="pendientes de envío" tone="warning" />
        <StatCard label="Campañas activas" value={loading ? '—' : num(overview?.activeCampaigns ?? 0)} hint="enviando o programadas" tone="neutral" />
      </StatGrid></div>
      {loading ? <LoadingRows /> : overview && t && t.total === 0 ? (
        <Panel><EmptyState icon={<Ui name="smartphone" size={24} />} title="Todavía no enviaste SMS en este período" text="Creá tu primera campaña: elegí contactos de tu CRM o pegá una lista de números." action={<button type="button" className="btn" onClick={onNew}>＋ Nueva campaña</button>} /></Panel>
      ) : overview && (
        <>
          <Panel title="SMS enviados por día"><ColumnChart data={daily} valueLabel={(n) => `${num(n)} SMS`} /></Panel>
          <Panel title="Campañas recientes" flush>
            <div className="page-table-wrap"><table className="mgmt-table">
              <thead><tr><th>Campaña</th><th>Estado</th><th className="num">Enviados</th><th className="num">Fallidos</th><th>Fecha</th><th /></tr></thead>
              <tbody>{overview.recentCampaigns.map((c) => (
                <tr key={c.id}><td><b>{c.name}</b></td><td><Pill tone={CAMPAIGN_LABEL[c.status].tone} dot>{CAMPAIGN_LABEL[c.status].label}</Pill></td>
                  <td className="num">{num(c.counts?.ok ?? 0)} / {num(c.counts?.total ?? 0)}</td><td className="num">{num(c.counts?.failed ?? 0)}</td><td>{dateTime(c.createdAt)}</td>
                  <td><button type="button" className="btn secondary small" onClick={() => onOpen(c)}>Ver</button></td></tr>))}</tbody>
            </table></div>
          </Panel>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Campañas
function CampaignsTab({ campaigns, loading, onAction, onEdit, onDuplicate, onDelete, onOpen, onNew }: {
  campaigns: SmsCampaign[]; loading: boolean; onAction: (c: SmsCampaign, a: 'start' | 'pause' | 'resume' | 'cancel' | 'retry-failed') => void; onEdit: (c: SmsCampaign) => void;
  onDuplicate: (c: SmsCampaign) => void; onDelete: (list: SmsCampaign[]) => Promise<boolean>; onOpen: (c: SmsCampaign) => void; onNew: () => void;
}) {
  const [filters, setFilters] = useState<ListFilterState>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<string[]>([]);
  const groups = GROUPS.map((g) => ({ key: g.key, label: g.label, count: campaigns.filter((c) => g.match(c.status)).length }));
  const visible = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const group = GROUPS.find((g) => g.key === filters.group) || GROUPS[0];
    return campaigns.filter((c) => group.match(c.status) && inDateRange(c.createdAt, filters.from, filters.to) && (!q || `${c.name} ${c.message}`.toLowerCase().includes(q)));
  }, [campaigns, filters]);
  const selectable = visible.filter((c) => c.status !== 'SENDING');
  const chosen = campaigns.filter((c) => selected.includes(c.id));
  useEffect(() => { setSelected((cur) => cur.filter((id) => campaigns.some((c) => c.id === id && c.status !== 'SENDING'))); }, [campaigns]);
  const toggleAll = () => setSelected(selectable.every((c) => selected.includes(c.id)) ? [] : selectable.map((c) => c.id));
  if (loading) return <LoadingRows />;
  if (campaigns.length === 0) return <Panel><EmptyState icon={<Ui name="smartphone" size={24} />} title="Todavía no hay campañas de SMS" text="Creá una y enviala a tus contactos en minutos." action={<button type="button" className="btn" onClick={onNew}>＋ Nueva campaña</button>} /></Panel>;
  return (
    <>
      <ListFilters state={filters} onChange={setFilters} groups={groups} searchPlaceholder="Buscar campaña o mensaje…" />
      {chosen.length > 0 && <BulkBar selected={chosen.length} visible={selectable.length} onToggleAll={toggleAll} onClear={() => setSelected([])} onDelete={async () => { if (await onDelete(chosen)) setSelected([]); }} />}
      {visible.length === 0 ? <div className="list-empty-filtered">Ninguna campaña coincide con los filtros. {filtersActive(filters) && <button type="button" className="btn secondary small" onClick={() => setFilters(EMPTY_FILTERS)}>Limpiar filtros</button>}</div> : (
        <div className="sms-campaign-grid">
          {visible.map((c) => {
            const counts = c.counts; const done = counts ? counts.ok + counts.failed + counts.cancelled : 0; const pct = counts && counts.total ? Math.round((done / counts.total) * 100) : 0;
            const meta = CAMPAIGN_LABEL[c.status];
            return (
              <article key={c.id} className={`sms-campaign ${selected.includes(c.id) ? 'selected' : ''}`}>
                <span className="list-select sms-campaign-check"><input type="checkbox" checked={selected.includes(c.id)} disabled={c.status === 'SENDING'} onChange={() => setSelected((cur) => (cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id]))} aria-label={`Elegir ${c.name}`} /></span>
                <button type="button" className="sms-campaign-main" onClick={() => onOpen(c)}>
                  <div className="sms-campaign-top"><strong>{c.name}</strong><Pill tone={meta.tone} dot>{meta.label}</Pill></div>
                  <p>{c.message}</p>
                  <div className={`sms-progress ${c.status === 'SENDING' ? 'live' : ''}`}><span style={{ width: `${pct}%` }} /></div>
                  {c.status === 'SENDING' ? (
                    <div className="sms-live"><i aria-hidden="true" /> Enviando… <b>{num(done)}</b> de <b>{num(counts?.total ?? 0)}</b> · {pct} %</div>
                  ) : null}
                  <div className="sms-campaign-counts"><span><b>{num(counts?.ok ?? 0)}</b> enviados</span><span><b>{num(counts?.failed ?? 0)}</b> fallidos</span><span><b>{num(counts?.pending ?? 0)}</b> pendientes</span><small>{c.status === 'SCHEDULED' && c.scheduledAt ? `Sale ${dateTime(c.scheduledAt)}` : dateTime(c.createdAt)}</small></div>
                  {c.pauseReason && c.status === 'PAUSED' && <div className="sms-pause-reason">{c.pauseReason}</div>}
                </button>
                <div className="sms-campaign-actions">
                  {['DRAFT', 'SCHEDULED'].includes(c.status) && <button type="button" className="btn small" onClick={() => onAction(c, 'start')}><Ui name="play" size={13} /> {c.status === 'SCHEDULED' ? 'Enviar ahora' : 'Enviar'}</button>}
                  {c.status === 'PAUSED' && <button type="button" className="btn small" onClick={() => onAction(c, 'resume')}><Ui name="play" size={13} /> Reanudar</button>}
                  {c.status === 'SENDING' && <button type="button" className="btn danger small" onClick={() => onAction(c, 'pause')} title="Detiene el envío. Podés reanudarlo, editar el texto o cancelarlo"><Ui name="stop" size={13} /> Detener</button>}
                  {['DRAFT', 'SCHEDULED', 'PAUSED'].includes(c.status) && <button type="button" className="btn secondary small" onClick={() => onEdit(c)} title={c.status === 'PAUSED' ? 'Cambiar el texto de lo que falta enviar' : 'Editar la campaña'}><Ui name="edit" size={13} /> Editar</button>}
                  {['COMPLETED', 'PAUSED', 'CANCELLED'].includes(c.status) && (counts?.failed ?? 0) > 0 && <button type="button" className="btn secondary small" onClick={() => onAction(c, 'retry-failed')} title="Vuelve a intentar los SMS que fallaron"><Ui name="refresh" size={13} /> Reenviar fallidos ({num(counts?.failed ?? 0)})</button>}
                  <button type="button" className="btn secondary small" onClick={() => onDuplicate(c)} title="Crear una campaña nueva a partir de esta (para reenviarla a todos)"><Ui name="copy" size={13} /> Duplicar</button>
                  {['SCHEDULED', 'SENDING', 'PAUSED'].includes(c.status) && <button type="button" className="btn secondary small" onClick={() => onAction(c, 'cancel')}>× Cancelar</button>}
                  {c.status !== 'SENDING' && <button type="button" className="btn secondary small" onClick={() => onDelete([c])} aria-label={`Eliminar ${c.name}`}><Ui name="trash" size={14} /></button>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

function EditTextModal({ campaign, onClose, onSaved }: { campaign: SmsCampaign; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(campaign.name);
  const [message, setMessage] = useState(campaign.message);
  const [stripAccents, setStripAccents] = useState(campaign.stripAccents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = analyzeText(message, stripAccents);
  async function save() {
    if (name.trim().length < 2) { setError('Escribí un nombre.'); return; }
    if (!a.fits) { setError(message.trim() ? `El mensaje supera el límite de ${a.limit} caracteres.` : 'Escribí el mensaje.'); return; }
    setBusy(true); setError(null);
    try { await apiPatch(`/api/org/sms/campaigns/${campaign.id}`, { name: name.trim(), message, stripAccents }); onSaved(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo guardar'); setBusy(false); }
  }
  return (
    <Modal title="Editar el texto de lo que falta enviar" onClose={onClose}>
      <div className="outcome-form">
        <p className="outcome-lead">La campaña está detenida. Los SMS que <b>ya salieron</b> no cambian; los que <b>faltan</b> (<b>{num(campaign.counts?.pending ?? 0)}</b>) van a salir con el texto nuevo.</p>
        <div className="field"><label htmlFor="sms-edit-name">Nombre</label><input id="sms-edit-name" className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor="sms-edit-msg">Mensaje</label><textarea id="sms-edit-msg" className="input sms-message-input" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} />
          <div className="sms-counter" aria-live="polite"><div className="sms-counter-bar"><span className={a.fits || !message ? '' : 'over'} style={{ width: `${Math.min(100, Math.round((a.length / a.limit) * 100))}%` }} /></div><span className={a.length > a.limit ? 'over' : ''}><b>{a.length}</b> / {a.limit} caracteres</span></div></div>
        <label className="auto-chat-option"><input type="checkbox" checked={stripAccents} onChange={(e) => setStripAccents(e.target.checked)} /><span><b>Quitar tildes y ñ (recomendado)</b><small>Así entran los 160 caracteres.</small></span></label>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="outcome-actions"><button type="button" className="btn secondary" onClick={onClose}>Cancelar</button><button type="button" className="btn" onClick={save} disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button></div>
      </div>
    </Modal>
  );
}

function CampaignDetail({ campaign, onClose }: { campaign: SmsCampaign; onClose: () => void }) {
  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    apiGet<{ messages: SmsMessage[]; total: number }>(`/api/org/sms/campaigns/${campaign.id}?limit=${PAGE}&offset=${page * PAGE}${status ? `&status=${status}` : ''}`)
      .then((d) => { setMessages(d.messages); setTotal(d.total); }).catch(() => {}).finally(() => setLoading(false));
  }, [campaign.id, campaign.counts?.ok, campaign.counts?.failed, status, page]);
  const c = campaign.counts;
  return (
    <Modal title={campaign.name} onClose={onClose} className="sms-detail-modal">
      <div className="sms-detail-head">
        <Pill tone={CAMPAIGN_LABEL[campaign.status].tone} dot>{CAMPAIGN_LABEL[campaign.status].label}</Pill>
        <div className="sms-bubble">{campaign.message}</div>
        <div className="sms-detail-stats"><span><b>{num(c?.total ?? 0)}</b> destinatarios</span><span className="ok"><b>{num(c?.ok ?? 0)}</b> enviados</span><span className="bad"><b>{num(c?.failed ?? 0)}</b> fallidos</span><span><b>{num(c?.pending ?? 0)}</b> pendientes</span></div>
        {campaign.pauseReason && campaign.status === 'PAUSED' && <div className="sms-pause-reason">{campaign.pauseReason}</div>}
      </div>
      <div className="list-filter-row" style={{ marginBottom: 8 }}>
        <label className="list-filter-field"><span>Estado</span><select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}><option value="">Todos</option>{(Object.keys(MESSAGE_LABEL) as SmsMessageStatus[]).map((s) => <option key={s} value={s}>{MESSAGE_LABEL[s].label}</option>)}</select></label>
      </div>
      {loading ? <LoadingRows rows={3} /> : (
        <ul className="sms-detail-list">
          {messages.map((m) => <li key={m.id}><span className="sms-detail-person"><b>{m.name || formatPhone(m.phone)}</b><small>{m.name ? formatPhone(m.phone) : ''}{m.error ? ` · ${m.error}` : ''}</small></span><Pill tone={MESSAGE_LABEL[m.status].tone}>{MESSAGE_LABEL[m.status].label}</Pill></li>)}
          {messages.length === 0 && <li className="sms-empty">Sin mensajes en este estado.</li>}
        </ul>
      )}
      <div className="mgmt-pager"><span>{num(total)} en total</span>
        <button type="button" className="btn secondary small" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Anterior</button>
        <button type="button" className="btn secondary small" disabled={(page + 1) * PAGE >= total} onClick={() => setPage((p) => p + 1)}>Siguiente</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Envío rápido
function QuickSend({ balance, priceGs, onSent, onNeedBalance }: { balance: number; priceGs: number; onSent: () => void; onNeedBalance: (missing?: number) => void }) {
  const { notify } = useAlerts();
  const [listText, setListText] = useState('');
  const [parsed, setParsed] = useState<ParsedList | null>(null);
  const [message, setMessage] = useState('');
  const [stripAccents, setStripAccents] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = parsed?.summary.valid ?? 0;
  const a = analyzeText(message, stripAccents);
  const missing = Math.max(0, count - balance);

  async function submit() {
    setError(null);
    if (!count) { setError('Pegá al menos un número válido.'); return; }
    if (!a.fits) { setError(message.trim() ? `El mensaje supera el límite de ${a.limit} caracteres.` : 'Escribí el mensaje.'); return; }
    setBusy(true);
    try {
      await apiPost('/api/org/sms/send', { message, stripAccents, recipients: parsed?.recipients || [] });
      notify(`Enviando ${num(count)} SMS…`, { tone: 'success' });
      setListText(''); setMessage(''); setParsed(null); onSent();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SMS_INSUFFICIENT_BALANCE') onNeedBalance((err.details as { missing?: number } | undefined)?.missing);
      setError(err instanceof ApiError ? err.message : 'No se pudo enviar');
    } finally { setBusy(false); }
  }
  return (
    <div className="sms-quick">
      <Panel title="Para quién">
        <SmsListInput value={listText} onChange={setListText} onParsed={setParsed} placeholder={'Pegá uno o varios números, uno por línea:\n0985 768 793\n0981 222 333'} />
      </Panel>
      <Panel title="Mensaje">
        <textarea className="input sms-message-input" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Escribí el SMS (hasta 160 caracteres)…" aria-label="Mensaje" />
        <div className="sms-counter" aria-live="polite">
          <div className="sms-counter-bar"><span className={a.fits || !message ? '' : 'over'} style={{ width: `${Math.min(100, Math.round((a.length / a.limit) * 100))}%` }} /></div>
          <span className={a.length > a.limit ? 'over' : ''}><b>{a.length}</b> / {a.limit} caracteres</span>
        </div>
        <label className="auto-chat-option" style={{ marginTop: 12 }}><input type="checkbox" checked={stripAccents} onChange={(e) => setStripAccents(e.target.checked)} /><span><b>Quitar tildes y ñ (recomendado)</b><small>Así entran los 160 caracteres.</small></span></label>
        <div className="sms-cost">
          <div><span>Destinatarios</span><b>{num(count)}</b></div>
          <div><span>Costo</span><b>{gs(count * priceGs)}</b><small>{num(count)} × {gs(priceGs)}</small></div>
          <div><span>Tu saldo</span><b className={missing > 0 ? 'bad' : 'ok'}>{num(balance)} SMS</b></div>
        </div>
        {missing > 0 && <div className="alert error" role="alert"><span>Te faltan <b>{num(missing)}</b> SMS de saldo. <button type="button" className="btn small" onClick={() => onNeedBalance(missing)}>Comprar saldo</button></span></div>}
        {error && <div className="alert error" role="alert">{error}</div>}
        <button type="button" className="btn" style={{ marginTop: 12 }} onClick={submit} disabled={busy}>{busy ? 'Enviando…' : <><Ui name="send" size={15} /> Enviar ahora</>}</button>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- Historial
function HistoryTab() {
  const [preset, setPreset] = useState<'today' | '7d' | '30d' | 'custom'>('30d');
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [status, setStatus] = useState(''); const [q, setQ] = useState(''); const [debounced, setDebounced] = useState('');
  const [rows, setRows] = useState<SmsMessage[]>([]); const [total, setTotal] = useState(0); const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 300); return () => clearTimeout(t); }, [q]);
  const query = useMemo(() => {
    const now = new Date(); const sod = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
    let f = sod(new Date(now.getTime() - 29 * 86400000)); let t = now;
    if (preset === 'today') f = sod(now); else if (preset === '7d') f = sod(new Date(now.getTime() - 6 * 86400000));
    else if (preset === 'custom') { f = from ? sod(new Date(`${from}T00:00:00`)) : f; t = to ? new Date(`${to}T23:59:59`) : now; }
    const p = new URLSearchParams({ from: f.toISOString(), to: t.toISOString() });
    if (status) p.set('status', status); if (debounced.trim()) p.set('q', debounced.trim());
    return p;
  }, [preset, from, to, status, debounced]);
  useEffect(() => { setPage(0); }, [query]);
  useEffect(() => {
    setLoading(true);
    apiGet<{ messages: SmsMessage[]; total: number }>(`/api/org/sms/messages?${query}&limit=${PAGE}&offset=${page * PAGE}`).then((d) => { setRows(d.messages); setTotal(d.total); }).catch(() => {}).finally(() => setLoading(false));
  }, [query, page]);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  return (
    <>
      <div className="list-filters">
        <div className="list-filter-chips" role="tablist" aria-label="Período">
          {([['today', 'Hoy'], ['7d', '7 días'], ['30d', '30 días'], ['custom', 'Fechas']] as ['today' | '7d' | '30d' | 'custom', string][]).map(([k, l]) => <button type="button" key={k} role="tab" aria-selected={preset === k} className={`list-chip ${preset === k ? 'active' : ''}`} onClick={() => setPreset(k)}>{l}</button>)}
        </div>
        <div className="list-filter-row">
          {preset === 'custom' && <><label className="list-filter-field"><span>Desde</span><input className="input" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="list-filter-field"><span>Hasta</span><input className="input" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label></>}
          <label className="list-filter-field"><span>Estado</span><select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todos</option><option value="ok">Enviados</option><option value="failed">Fallidos</option><option value="pending">Pendientes</option><option value="cancelled">Cancelados</option></select></label>
          <label className="list-filter-search"><Ui name="search" size={14} /><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar número, nombre o texto…" aria-label="Buscar" /></label>
          <a className="btn secondary small" href={`/api/org/sms/messages?${query}&format=csv`}><Ui name="download" size={14} /> Exportar CSV</a>
        </div>
      </div>
      <Panel flush title={`Historial de envíos (${num(total)})`}>
        {loading && rows.length === 0 ? <LoadingRows /> : rows.length === 0 ? <EmptyState icon={<Ui name="smartphone" size={24} />} title="Sin envíos" text="No hay SMS que coincidan con los filtros." /> : (
          <>
            <div className="page-table-wrap"><table className="mgmt-table">
              <thead><tr><th>Fecha</th><th>Número</th><th>Destinatario</th><th>Mensaje</th><th>Campaña</th><th>Estado</th></tr></thead>
              <tbody>{rows.map((m) => (
                <tr key={m.id}><td>{dateTime(m.sentAt || m.createdAt)}</td><td>{formatPhone(m.phone)}</td><td>{m.name || '—'}</td><td className="mgmt-note" title={m.body}>{m.body}</td><td>{m.campaignName || '—'}</td>
                  <td><Pill tone={MESSAGE_LABEL[m.status].tone}>{MESSAGE_LABEL[m.status].label}</Pill>{m.error && <small className="mgmt-sub" title={m.error}>{m.error.slice(0, 40)}</small>}</td></tr>))}</tbody>
            </table></div>
            <div className="mgmt-pager"><span>Página {page + 1} de {pages}</span><button type="button" className="btn secondary small" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Anterior</button><button type="button" className="btn secondary small" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Siguiente</button></div>
          </>
        )}
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Saldo y compras
function BalanceTab({ balance, canBuy, onBuy, refreshKey }: { balance: number; canBuy: boolean; onBuy: () => void; refreshKey: number }) {
  const [purchases, setPurchases] = useState<SmsPurchase[]>([]);
  const [txs, setTxs] = useState<SmsTransaction[]>([]);
  const [txTotal, setTxTotal] = useState(0); const [txPage, setTxPage] = useState(0); const [type, setType] = useState('');
  const load = useCallback(() => {
    apiGet<{ purchases: SmsPurchase[] }>('/api/org/sms/purchases?limit=50').then((d) => setPurchases(d.purchases)).catch(() => {});
    apiGet<{ transactions: SmsTransaction[]; total: number }>(`/api/org/sms/transactions?limit=${PAGE}&offset=${txPage * PAGE}${type ? `&type=${type}` : ''}`).then((d) => { setTxs(d.transactions); setTxTotal(d.total); }).catch(() => {});
  }, [txPage, type]);
  useEffect(() => { load(); }, [load, refreshKey]);
  return (
    <>
      <Panel title="Tu saldo"><div className="sms-balance-card"><div><span className="sms-eyebrow">DISPONIBLE</span><div className="sms-balance"><b>{num(balance)}</b><span>SMS</span></div></div>{canBuy && <button type="button" className="btn" onClick={onBuy}><Ui name="cart" size={15} /> Comprar saldo</button>}</div></Panel>
      <Panel flush title="Recargas">
        {purchases.length === 0 ? <EmptyState icon={<Ui name="cart" size={24} />} title="Todavía no compraste saldo" text="Cuando recargues, las compras aparecen acá." /> : (
          <div className="page-table-wrap"><table className="mgmt-table"><thead><tr><th>Fecha</th><th className="num">SMS</th><th className="num">Monto</th><th>Origen</th><th>Estado</th><th /></tr></thead>
            <tbody>{purchases.map((p) => (<tr key={p.id}><td>{dateTime(p.paidAt || p.createdAt)}</td><td className="num strong">{num(p.credits)}</td><td className="num">{gs(p.amount)}</td><td>{p.source === 'ADMIN' ? `Asignado por el administrador${p.note ? ` · ${p.note}` : ''}` : p.paymentMethod ? `Pago en línea (${p.paymentMethod})` : 'Pago en línea'}</td>
              <td><Pill tone={p.status === 'paid' ? 'success' : p.status === 'pending' ? 'warning' : 'neutral'} dot>{p.status === 'paid' ? 'Acreditada' : p.status === 'pending' ? 'Pendiente de pago' : 'No completada'}</Pill></td>
              <td>{p.status === 'pending' && p.paymentUrl && <a className="btn secondary small" href={p.paymentUrl} target="_blank" rel="noopener noreferrer">Pagar</a>}</td></tr>))}</tbody></table></div>)}
      </Panel>
      <Panel flush title="Movimientos de saldo" actions={<select className="input" style={{ width: 'auto' }} value={type} onChange={(e) => { setType(e.target.value); setTxPage(0); }} aria-label="Tipo de movimiento"><option value="">Todos</option>{(Object.keys(TX_LABEL) as SmsTransaction['type'][]).map((t) => <option key={t} value={t}>{TX_LABEL[t]}</option>)}</select>}>
        {txs.length === 0 ? <EmptyState icon={<Ui name="clock" size={24} />} title="Sin movimientos" text="Cada recarga y cada SMS enviado queda registrado acá." /> : (
          <>
            <div className="page-table-wrap"><table className="mgmt-table"><thead><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th className="num">SMS</th><th className="num">Saldo</th></tr></thead>
              <tbody>{txs.map((t) => (<tr key={t.id}><td>{dateTime(t.createdAt)}</td><td>{TX_LABEL[t.type]}</td><td className="mgmt-note">{t.note || '—'}</td><td className={`num strong ${t.amount < 0 ? 'sms-neg' : 'sms-pos'}`}>{t.amount > 0 ? '+' : ''}{num(t.amount)}</td><td className="num">{num(t.balanceAfter)}</td></tr>))}</tbody></table></div>
            <div className="mgmt-pager"><span>{num(txTotal)} movimientos</span><button type="button" className="btn secondary small" disabled={txPage === 0} onClick={() => setTxPage((p) => p - 1)}>Anterior</button><button type="button" className="btn secondary small" disabled={(txPage + 1) * PAGE >= txTotal} onClick={() => setTxPage((p) => p + 1)}>Siguiente</button></div>
          </>)}
      </Panel>
    </>
  );
}
