import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../components/PageKit';
import { apiDelete, apiGet, apiPost, apiUpload, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { Modal } from '../components/Modal';
import { useAlerts } from '../context/AlertContext';
import type { CallAccount, CallAudio, CallCampaign, CallCampaignCounts, CallDashboardStats, CallProviderInfo } from '../types';
import '../styles/call-campaigns.css';
import { Glyph, Ui } from '../components/Ui';
import { CALL_CAMPAIGN_TYPES, CallCampaignWizard, type WizardMode, type WizardSource } from '../components/CallCampaignWizard';
import { BulkBar, EMPTY_FILTERS, ListFilters, filtersActive, inDateRange, type ListFilterState } from '../components/ListFilters';

type Tab = 'dashboard' | 'campaigns' | 'history' | 'audios' | 'accounts';
type CampaignAction = 'start' | 'pause' | 'resume' | 'cancel';
interface CardActions {
  onAction: (campaign: CallCampaign, action: CampaignAction) => void;
  onEdit: (campaign: CallCampaign) => void;
  onRelaunch: (campaign: CallCampaign) => void;
  onDelete: (campaign: CallCampaign) => void;
}

// Agrupaciones de estado para filtrar: "pendientes" junta borrador y programada.
const STATUS_GROUPS: { key: string; label: string; match: (status: CallCampaign['status']) => boolean }[] = [
  { key: 'all', label: 'Todas', match: () => true },
  { key: 'pending', label: 'Pendientes', match: (s) => s === 'DRAFT' || s === 'SCHEDULED' },
  { key: 'running', label: 'En proceso', match: (s) => s === 'RUNNING' },
  { key: 'paused', label: 'Pausadas', match: (s) => s === 'PAUSED' },
  { key: 'completed', label: 'Finalizadas', match: (s) => s === 'COMPLETED' },
  { key: 'cancelled', label: 'Canceladas', match: (s) => s === 'CANCELLED' }
];

const STATUS_LABEL: Record<CallCampaign['status'], string> = {
  DRAFT: 'Borrador', SCHEDULED: 'Programada', RUNNING: 'En curso', PAUSED: 'Pausada', COMPLETED: 'Finalizada', CANCELLED: 'Cancelada'
};

const CALL_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendiente', QUEUED: 'En cola', STARTING: 'Iniciando', RINGING: 'Sonando', CONNECTED: 'Conectada', PLAYING: 'Reproduciendo', COMPLETED: 'Finalizada', NO_ANSWER: 'No contestada', FAILED: 'Fallida', CANCELLED: 'Cancelada', RETRY_PENDING: 'Reintento pendiente'
};
const ACCOUNT_STATUS_LABEL: Record<string, string> = { CONNECTED: 'Conectada', RECONNECTING: 'Reconectando', WAITING_AUTH: 'Esperando QR', DISCONNECTED: 'Desconectada' };

const EMPTY_STATS: CallDashboardStats = { scheduled: 0, queued: 0, inProgress: 0, connected: 0, completed: 0, noAnswer: 0, failed: 0, pendingSurvey: 0, surveyResponses: 0, totalCalls: 0, totalMinutes: 0, attendedCalls: 0, directCalls: 0 };

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function counts(campaign: CallCampaign): CallCampaignCounts {
  return campaign.counts || { total: 0, pending: 0, queued: 0, inProgress: 0, connected: 0, completed: 0, noAnswer: 0, failed: 0, cancelled: 0, retryPending: 0, attempts: 0, surveyPending: 0, surveyResponses: 0 };
}

export function CallCampaigns() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [campaigns, setCampaigns] = useState<CallCampaign[]>([]);
  const [stats, setStats] = useState<CallDashboardStats>(EMPTY_STATS);
  const [accounts, setAccounts] = useState<CallAccount[]>([]);
  const [audios, setAudios] = useState<CallAudio[]>([]);
  const [provider, setProvider] = useState<CallProviderInfo | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wizard, setWizard] = useState<{ mode: WizardMode; source?: WizardSource } | null>(null);
  const { confirm, notify } = useAlerts();
  const [showConnect, setShowConnect] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [dashboard, campaignData, accountData, audioData] = await Promise.all([
        apiGet<{ stats: CallDashboardStats; campaigns: CallCampaign[]; accounts: CallAccount[]; provider: CallProviderInfo }>('/api/org/wa-calls/dashboard'),
        apiGet<{ campaigns: CallCampaign[] }>('/api/org/wa-calls/campaigns'),
        apiGet<{ accounts: CallAccount[]; provider: CallProviderInfo }>('/api/org/wa-calls/accounts'),
        apiGet<{ audios: CallAudio[] }>('/api/org/wa-calls/audios'),
      ]);
      setStats(dashboard.stats || EMPTY_STATS);
      setCampaigns(campaignData.campaigns || []);
      setAccounts(accountData.accounts || dashboard.accounts || []);
      setAudios(audioData.audios || []);
      setProvider(accountData.provider || dashboard.provider || null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar el módulo de llamadas');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const socket = getSocket();
    const onUpdate = ({ campaign, provider: nextProvider }: { campaign: CallCampaign; provider?: CallProviderInfo }) => {
      setCampaigns((current) => current.some((item) => item.id === campaign.id) ? current.map((item) => item.id === campaign.id ? campaign : item) : [campaign, ...current]);
      if (nextProvider) setProvider(nextProvider);
      if (tab === 'dashboard') apiGet<{ stats: CallDashboardStats }>('/api/org/wa-calls/dashboard').then((data) => setStats(data.stats || EMPTY_STATS)).catch(() => {});
    };
    socket.on('wa-call:updated', onUpdate);
    return () => { socket.off('wa-call:updated', onUpdate); };
  }, [tab]);

  async function openWizard(mode: WizardMode, campaignId: string, onlyContactIds?: string[]) {
    try {
      const config = await apiGet<{ campaign: CallCampaign; survey: WizardSource['survey']; recipients: WizardSource['recipients'] }>(`/api/org/wa-calls/campaigns/${campaignId}/config`);
      setWizard({ mode, source: { ...config, onlyContactIds } });
    } catch (err) { notify(err instanceof ApiError ? err.message : 'No se pudo cargar la campaña', { tone: 'error' }); }
  }

  async function deleteCampaigns(list: CallCampaign[]) {
    const running = list.filter((c) => c.status === 'RUNNING');
    const deletable = list.filter((c) => c.status !== 'RUNNING');
    if (!deletable.length) { notify('Las campañas en curso no se pueden eliminar: cancelalas o pausalas primero.', { tone: 'error' }); return false; }
    const many = deletable.length > 1;
    const ok = await confirm({
      title: many ? `Eliminar ${deletable.length} campañas` : 'Eliminar campaña',
      message: many
        ? `¿Eliminar ${deletable.length} campañas? Se borra también su historial de llamadas y respuestas de encuesta. Esta acción no se puede deshacer.${running.length ? ` (${running.length} en curso se omiten.)` : ''}`
        : `¿Eliminar “${deletable[0].name}”? Se borra también su historial de llamadas y respuestas de encuesta. Esta acción no se puede deshacer.`,
      confirmLabel: 'Eliminar',
      tone: 'danger'
    });
    if (!ok) return false;
    try {
      const result = await apiPost<{ deleted: string[]; skipped: { name: string; reason: string }[] }>('/api/org/wa-calls/campaigns/bulk-delete', { ids: deletable.map((c) => c.id) });
      notify(`${result.deleted.length} campaña${result.deleted.length === 1 ? '' : 's'} eliminada${result.deleted.length === 1 ? '' : 's'}${result.skipped.length ? ` · ${result.skipped.length} omitida${result.skipped.length === 1 ? '' : 's'}` : ''}.`, { tone: result.skipped.length ? 'warning' : 'success' });
      await load();
      if (tab === 'history') loadHistory();
      return true;
    } catch (err) { notify(err instanceof ApiError ? err.message : 'No se pudieron eliminar las campañas', { tone: 'error' }); return false; }
  }

  const cardActions: CardActions = {
    onAction: (campaign, action) => performAction(campaign, action),
    onEdit: (campaign) => openWizard('edit', campaign.id),
    onRelaunch: (campaign) => openWizard('relaunch', campaign.id),
    onDelete: (campaign) => { deleteCampaigns([campaign]); }
  };

  async function performAction(campaign: CallCampaign, action: CampaignAction) {
    try {
      const result = await apiPost<{ campaign: CallCampaign }>(`/api/org/wa-calls/campaigns/${campaign.id}/${action}`, {});
      setCampaigns((current) => current.map((item) => item.id === campaign.id ? result.campaign : item));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo actualizar la campaña');
    }
  }

  async function loadHistory() {
    try {
      const result = await apiGet<{ attempts: any[] }>('/api/org/wa-calls/history?limit=1000');
      setHistory(result.attempts || []);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo cargar el historial'); }
  }

  useEffect(() => { if (tab === 'history') loadHistory(); }, [tab]);

  return (
    <div className="page-shell call-page">
      <PageHeader
        tone="sky"
        className="call-page-header"
        icon={<Ui name="phone" size={22} />}
        title="Campañas de llamadas"
        subtitle="Programá llamadas autorizadas, reproducí un audio y seguí cada resultado desde un solo lugar."
        actions={<>
          <button type="button" className="btn secondary" onClick={load} disabled={loading}><Glyph c="↻" size={15} /> Actualizar</button>
          <button type="button" className="btn secondary" onClick={() => setShowConnect(true)}><Glyph c="◉" size={15} /> Cuenta WhatsApp</button>
          <button type="button" className="btn" onClick={() => setWizard({ mode: 'create' })}>＋ Nueva campaña</button>
        </>}
        hero={{
          eyebrow: 'WhatsApp Voice Center',
          title: 'Gestioná tus llamadas desde un solo lugar.',
          text: 'Prepará campañas, supervisá cada resultado y mantené todo el historial de voz organizado.',
          features: [{ icon: 'volume', label: 'Llamadas con audio' }, { icon: 'calendar', label: 'Campañas programadas' }, { icon: 'zap', label: 'Resultados en tiempo real' }],
          art: ['volume', 'phone', 'clock']
        }}
      />

      {provider && !provider.available && <div className="call-provider-warning"><strong>Proveedor de llamadas pendiente</strong><span>{provider.reason}</span></div>}
      {provider?.mode === 'mock' && <div className="call-provider-note"><strong>Modo simulador local activo</strong><span>Permite probar estados, pausa, reanudación, encuesta e historial sin llamar a personas reales.</span></div>}
      {error && <div className="call-alert">{error}<button type="button" onClick={() => setError(null)}>×</button></div>}

      <nav className="call-tabs" aria-label="Secciones de llamadas">
        {([['dashboard', 'Panel general', '⌂'], ['campaigns', 'Campañas', '◈'], ['history', 'Historial', '☷'], ['audios', 'Biblioteca de audios', '♫'], ['accounts', 'Cuentas WhatsApp', '◉']] as const).map(([key, label, icon]) => (
          <button type="button" key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}><span><Glyph c={icon} size={18} /></span>{label}</button>
        ))}
      </nav>

      {loading ? <div className="call-loading">Cargando centro de llamadas…</div> : (
        <div className="call-page-content">
          {tab === 'dashboard' && <Dashboard stats={stats} campaigns={campaigns.slice(0, 6)} actions={cardActions} onOpenCampaign={(campaign) => { setTab('campaigns'); setCampaigns((current) => current.map((item) => item.id === campaign.id ? campaign : item)); }} />}
          {tab === 'campaigns' && <CampaignList campaigns={campaigns} actions={cardActions} onBulkDelete={deleteCampaigns} />}
          {tab === 'history' && <HistoryTable attempts={history} onChanged={loadHistory} onRedial={(attempt) => openWizard('relaunch', attempt.campaignId, [attempt.campaignContact?.contactId].filter(Boolean))} />}
          {tab === 'audios' && <AudioLibrary audios={audios} onChange={load} />}
          {tab === 'accounts' && <AccountPanel accounts={accounts} provider={provider} onConnect={() => setShowConnect(true)} onChange={load} />}
        </div>
      )}

      {wizard && <CallCampaignWizard mode={wizard.mode} source={wizard.source} accounts={accounts} audios={audios} onClose={() => setWizard(null)} onCreated={() => { setWizard(null); load(); }} />}
      {showConnect && <ConnectAccountModal onClose={() => setShowConnect(false)} onConnected={() => { setShowConnect(false); load(); }} />}
    </div>
  );
}

function Dashboard({ stats, campaigns, actions, onOpenCampaign }: { stats: CallDashboardStats; campaigns: CallCampaign[]; actions: CardActions; onOpenCampaign: (campaign: CallCampaign) => void }) {
  const cards = [['Llamadas totales', stats.totalCalls, '☎', 'blue'], ['Minutos hablados', stats.totalMinutes, '◷', 'purple'], ['Atendidas', stats.attendedCalls, '✓', 'green'], ['Llamadas directas', stats.directCalls, '↗', 'cyan'], ['Programadas', stats.scheduled, '◷', 'blue'], ['En cola', stats.queued, '≋', 'purple'], ['En proceso', stats.inProgress, '◉', 'cyan'], ['Conectadas', stats.connected, '✓', 'green'], ['No contestadas', stats.noAnswer, '↯', 'orange'], ['Fallidas', stats.failed, '!', 'red'], ['Pendientes de encuesta', stats.pendingSurvey, '?', 'pink'], ['Respuestas recibidas', stats.surveyResponses, '↩', 'indigo']];
  return <>
    <section className="call-stat-grid">{cards.map(([label, value, icon, tone]) => <div className={`call-stat tone-${tone}`} key={label}><div><span>{label}</span><b><Glyph c={String(icon)} size={18} /></b></div><strong>{Number(value).toLocaleString('es')}</strong><small>actualizado en tiempo real</small></div>)}</section>
    <section className="call-section-heading"><div><h2>Campañas recientes</h2><p>Supervisá el avance y actuá sobre las campañas sin salir del panel.</p></div><span className="call-live-badge"><i /> Tiempo real</span></section>
    <div className="call-campaign-grid">{campaigns.length ? campaigns.map((campaign) => <CallCampaignCard key={campaign.id} campaign={campaign} actions={actions} onOpen={() => onOpenCampaign(campaign)} />) : <EmptyState text="Todavía no hay campañas de llamadas" />}</div>
  </>;
}

function CampaignList({ campaigns, actions, onBulkDelete }: { campaigns: CallCampaign[]; actions: CardActions; onBulkDelete: (list: CallCampaign[]) => Promise<boolean> }) {
  const [filters, setFilters] = useState<ListFilterState>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<string[]>([]);
  const groups = STATUS_GROUPS.map((g) => ({ key: g.key, label: g.label, count: campaigns.filter((c) => g.match(c.status)).length }));
  const visible = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const group = STATUS_GROUPS.find((g) => g.key === filters.group) || STATUS_GROUPS[0];
    return campaigns.filter((c) => group.match(c.status)
      && (!filters.type || c.campaignType === filters.type)
      && inDateRange(c.createdAt, filters.from, filters.to)
      && (!q || `${c.name} ${c.description || ''} ${c.audio?.name || ''}`.toLowerCase().includes(q)));
  }, [campaigns, filters]);
  // Solo se puede elegir lo que se puede borrar (las campañas en curso no).
  const selectable = visible.filter((c) => c.status !== 'RUNNING');
  const chosen = campaigns.filter((c) => selected.includes(c.id));
  useEffect(() => { setSelected((cur) => cur.filter((id) => campaigns.some((c) => c.id === id && c.status !== 'RUNNING'))); }, [campaigns]);
  const toggle = (id: string) => setSelected((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  const toggleAll = () => setSelected(selectable.every((c) => selected.includes(c.id)) ? selected.filter((id) => !selectable.some((c) => c.id === id)) : Array.from(new Set([...selected, ...selectable.map((c) => c.id)])));
  return <section className="call-table-card">
    <div className="call-section-heading"><div><h2>Historial de campañas</h2><p>Filtrá por estado, categoría o fecha; editá, relanzá o limpiá las que ya no necesitás.</p></div>
      {selectable.length > 0 && <button type="button" className="btn secondary small" onClick={toggleAll}>{selectable.every((c) => selected.includes(c.id)) ? 'Deseleccionar' : 'Seleccionar'} {selectable.length} visible{selectable.length === 1 ? '' : 's'}</button>}</div>
    <ListFilters state={filters} onChange={setFilters} groups={groups} types={CALL_CAMPAIGN_TYPES} typeLabel="Categoría" searchPlaceholder="Buscar campaña o audio…" />
    {chosen.length > 0 && <BulkBar selected={chosen.length} visible={selectable.length} onToggleAll={toggleAll} onClear={() => setSelected([])} onDelete={async () => { if (await onBulkDelete(chosen)) setSelected([]); }} />}
    {visible.length ? <div className="call-campaign-grid">{visible.map((campaign) => <CallCampaignCard key={campaign.id} campaign={campaign} actions={actions} selected={selected.includes(campaign.id)} onToggle={() => toggle(campaign.id)} />)}</div>
      : campaigns.length && filtersActive(filters) ? <div className="list-empty-filtered">Ninguna campaña coincide con los filtros. <button type="button" className="btn secondary small" onClick={() => setFilters(EMPTY_FILTERS)}>Limpiar filtros</button></div>
      : <EmptyState text="No hay campañas creadas" />}
  </section>;
}

function CallCampaignCard({ campaign, actions, onOpen, selected, onToggle }: { campaign: CallCampaign; actions: CardActions; onOpen?: () => void; selected?: boolean; onToggle?: () => void }) {
  const data = counts(campaign);
  const progress = data.total ? Math.round(((data.completed + data.noAnswer + data.failed + data.cancelled) / data.total) * 100) : 0;
  const editable = ['DRAFT', 'SCHEDULED'].includes(campaign.status);
  const finished = ['COMPLETED', 'CANCELLED'].includes(campaign.status);
  const typeLabel = CALL_CAMPAIGN_TYPES.find((t) => t.key === campaign.campaignType)?.label;
  return <article className={`call-campaign-card ${selected ? 'selected' : ''} ${onToggle ? 'has-select' : ''}`}>
    {onToggle && <span className="list-select call-card-check"><input type="checkbox" checked={Boolean(selected)} disabled={campaign.status === 'RUNNING'} onChange={onToggle} aria-label={`Elegir ${campaign.name}`} title={campaign.status === 'RUNNING' ? 'En curso: cancelala o pausala para poder eliminarla' : undefined} /></span>}
    <button type="button" className="call-card-main" onClick={onOpen}>
      <div className="call-card-top">
        <span className="call-card-icon"><Glyph c={campaign.status === 'RUNNING' ? '◉' : '☎'} size={20} /></span><div><strong>{campaign.name}</strong><small>{formatDate(campaign.createdAt)}{typeLabel ? ` · ${typeLabel}` : ''}</small></div><span className={`call-status status-${campaign.status.toLowerCase()}`}>{STATUS_LABEL[campaign.status]}</span></div>
      <p>{campaign.description || `${campaign.audio?.name || 'Audio'} · ${campaign.account?.name || 'Cuenta WhatsApp'}`}</p>
      {campaign.status === 'SCHEDULED' && campaign.scheduledAt && <p className="call-card-schedule">Programada para {formatDate(campaign.scheduledAt)}</p>}
      <div className="call-progress"><span style={{ width: `${progress}%` }} /></div><div className="call-progress-label"><span>{progress}% procesado</span><b>{data.total} destinatarios</b></div>
      <div className="call-count-row"><span><b>{data.connected}</b> conectadas</span><span><b>{data.noAnswer}</b> no contestadas</span><span><b>{data.failed}</b> fallidas</span></div>
    </button>
    <div className="call-card-footer"><span><Glyph c="♫" size={13} /> {campaign.audio?.name || 'Sin audio'}</span><div>
      {['DRAFT', 'PAUSED'].includes(campaign.status) && <button type="button" className="btn small" onClick={() => actions.onAction(campaign, campaign.status === 'PAUSED' ? 'resume' : 'start')}><Glyph c="▶" size={13} /> {campaign.status === 'PAUSED' ? 'Reanudar' : 'Iniciar'}</button>}
      {campaign.status === 'RUNNING' && <button type="button" className="btn secondary small" onClick={() => actions.onAction(campaign, 'pause')}>Ⅱ Pausar</button>}
      {editable && <button type="button" className="btn secondary small" onClick={() => actions.onEdit(campaign)}><Ui name="edit" size={13} /> Editar</button>}
      {(finished || campaign.status === 'PAUSED') && <button type="button" className="btn secondary small" onClick={() => actions.onRelaunch(campaign)} title="Crea una campaña nueva a partir de esta, para editarla y volver a lanzarla"><Glyph c="↻" size={13} /> Relanzar</button>}
      {!finished && <button type="button" className="btn danger small" onClick={() => actions.onAction(campaign, 'cancel')}>× Cancelar</button>}
      {campaign.status !== 'RUNNING' && <button type="button" className="btn secondary small" onClick={() => actions.onDelete(campaign)} aria-label={`Eliminar ${campaign.name}`} title="Eliminar campaña y su historial"><Ui name="trash" size={14} /></button>}
    </div></div>
  </article>;
}

const HISTORY_GROUPS: { key: string; label: string; match: (status: string) => boolean }[] = [
  { key: 'all', label: 'Todas', match: () => true },
  { key: 'answered', label: 'Atendidas', match: (s) => ['COMPLETED', 'CONNECTED', 'PLAYING'].includes(s) },
  { key: 'noanswer', label: 'No contestadas', match: (s) => s === 'NO_ANSWER' },
  { key: 'failed', label: 'Fallidas', match: (s) => s === 'FAILED' },
  { key: 'cancelled', label: 'Canceladas', match: (s) => s === 'CANCELLED' }
];

function HistoryTable({ attempts, onRedial, onChanged }: { attempts: any[]; onRedial: (attempt: any) => void; onChanged: () => void }) {
  const { confirm, notify } = useAlerts();
  const [filters, setFilters] = useState<ListFilterState>(EMPTY_FILTERS);
  const [kind, setKind] = useState<'' | 'DIRECT' | 'CAMPAIGN'>('');
  const rows = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const group = HISTORY_GROUPS.find((g) => g.key === filters.group) || HISTORY_GROUPS[0];
    return attempts.filter((a) => {
      const direct = a.recordType === 'DIRECT';
      if (kind && (kind === 'DIRECT') !== direct) return false;
      if (!group.match(String(a.status))) return false;
      if (!direct && filters.type && a.campaign?.campaignType !== filters.type) return false;
      if (filters.type && direct) return false;
      if (!inDateRange(a.createdAt, filters.from, filters.to)) return false;
      if (!q) return true;
      const name = direct ? a.contact?.name : a.campaignContact?.contact?.name;
      const phone = direct ? a.phoneNumber : a.campaignContact?.phoneNumber;
      return `${name || ''} ${phone || ''} ${direct ? '' : a.campaign?.name || ''}`.toLowerCase().includes(q);
    });
  }, [attempts, filters, kind]);
  const finishedDirect = rows.filter((a) => a.recordType === 'DIRECT' && !['STARTING', 'RINGING', 'CONNECTED', 'PLAYING'].includes(String(a.status)));
  async function clearDirect(list: any[]) {
    const ok = await confirm({ title: 'Eliminar llamadas del historial', message: `¿Eliminar ${list.length} llamada${list.length === 1 ? '' : 's'} directa${list.length === 1 ? '' : 's'} del historial? Esta acción no se puede deshacer.`, confirmLabel: 'Eliminar', tone: 'danger' });
    if (!ok) return;
    try {
      const result = await apiPost<{ deleted: number }>('/api/org/wa-calls/history/direct/bulk-delete', { ids: list.map((a) => a.id) });
      notify(`${result.deleted} llamada${result.deleted === 1 ? '' : 's'} eliminada${result.deleted === 1 ? '' : 's'} del historial.`, { tone: 'success' });
      onChanged();
    } catch (err) { notify(err instanceof ApiError ? err.message : 'No se pudo eliminar el historial', { tone: 'error' }); }
  }
  const groups = HISTORY_GROUPS.map((g) => ({ key: g.key, label: g.label, count: attempts.filter((a) => g.match(String(a.status))).length }));
  const csvHref = '/api/org/wa-calls/history?format=csv';
  return <section className="call-table-card">
    <div className="call-section-heading"><div><h2>Historial completo de llamadas</h2><p>Incluye campañas y llamadas individuales realizadas desde el chat, con duración y resultado. Para limpiar el historial de una campaña, eliminá la campaña desde “Campañas”.</p></div><a className="btn secondary small" href={csvHref}><Glyph c="↓" size={15} /> Exportar CSV</a></div>
    <ListFilters state={filters} onChange={setFilters} groups={groups} types={CALL_CAMPAIGN_TYPES} typeLabel="Categoría de campaña" searchPlaceholder="Buscar contacto, número o campaña…" />
    <div className="list-filter-row" style={{ marginBottom: 12 }}>
      <label className="list-filter-field"><span>Tipo de llamada</span><select className="input" value={kind} onChange={(e) => setKind(e.target.value as '' | 'DIRECT' | 'CAMPAIGN')}><option value="">Todas</option><option value="CAMPAIGN">De campaña</option><option value="DIRECT">Directas (desde el chat)</option></select></label>
      <small style={{ color: 'var(--text-dim)', alignSelf: 'center' }}>{rows.length} de {attempts.length} llamadas</small>
      {finishedDirect.length > 0 && <button type="button" className="btn secondary small" style={{ marginLeft: 'auto' }} onClick={() => clearDirect(finishedDirect)}><Ui name="trash" size={14} /> Eliminar las {finishedDirect.length} directas visibles</button>}
    </div>
    {rows.length ? <div className="call-history-table-wrap"><table className="call-history-table"><thead><tr><th>Fecha</th><th>Tipo</th><th>Contacto</th><th>Campaña / origen</th><th>Cuenta</th><th>Resultado</th><th>Duración</th><th>Detalle</th><th></th></tr></thead><tbody>{rows.map((attempt) => { const direct = attempt.recordType === 'DIRECT'; const duration = Number(attempt.durationSeconds || 0); const canRedial = !direct && attempt.campaignId && attempt.campaignContact?.contactId && !['PENDING', 'QUEUED', 'STARTING', 'RINGING', 'CONNECTED', 'PLAYING'].includes(String(attempt.status)); return <tr key={`${attempt.recordType || 'CAMPAIGN'}-${attempt.id}`}><td>{formatDate(attempt.createdAt)}</td><td><span className="call-history-kind">{direct ? 'Directa' : 'Campaña'}</span></td><td><strong>{direct ? attempt.contact?.name || 'Sin nombre' : attempt.campaignContact?.contact?.name || 'Sin nombre'}</strong><small>{direct ? attempt.phoneNumber : attempt.campaignContact?.phoneNumber}</small></td><td>{direct ? 'Llamada desde el chat' : attempt.campaign?.name}</td><td>{attempt.account?.name || '—'}</td><td><span className={`call-status status-${String(attempt.status).toLowerCase()}`}>{CALL_STATUS_LABEL[attempt.status] || attempt.status}</span></td><td>{duration ? `${Math.floor(duration / 60)}m ${duration % 60}s` : '—'}</td><td>{attempt.errorMessage || attempt.endedReason || '—'}</td><td>{direct && !['STARTING', 'RINGING', 'CONNECTED', 'PLAYING'].includes(String(attempt.status)) && <button type="button" className="btn secondary small" onClick={() => clearDirect([attempt])} aria-label="Eliminar del historial" title="Eliminar del historial"><Ui name="trash" size={14} /></button>}{canRedial && <button type="button" className="btn secondary small" onClick={() => onRedial(attempt)} title="Crear una campaña para volver a llamar a este contacto"><Glyph c="↻" size={13} /> Rellamar</button>}</td></tr>; })}</tbody></table></div>
      : attempts.length ? <div className="list-empty-filtered">Ninguna llamada coincide con los filtros. <button type="button" className="btn secondary small" onClick={() => { setFilters(EMPTY_FILTERS); setKind(''); }}>Limpiar filtros</button></div>
      : <EmptyState text="Todavía no hay llamadas registradas" />}
  </section>;
}

function AudioLibrary({ audios, onChange }: { audios: CallAudio[]; onChange: () => void }) {
  const { confirm, notify } = useAlerts();
  const [file, setFile] = useState<File | null>(null); const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const MAX_AUDIO_SECONDS = 60;
  // Se avisa al elegir el archivo, sin esperar a subirlo: igual que un mensaje de voz de WhatsApp, hasta 1 minuto.
  function pickFile(picked: File | null) {
    setError(null);
    if (!picked) { setFile(null); return; }
    const el = document.createElement('audio');
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      URL.revokeObjectURL(el.src);
      if (Number.isFinite(el.duration) && el.duration > MAX_AUDIO_SECONDS + 0.5) {
        setError(`Este audio dura ${Math.round(el.duration)} s; el máximo para una llamada es ${MAX_AUDIO_SECONDS} s (1 minuto). Recortalo y volvé a intentar.`);
        setFile(null);
      } else {
        setFile(picked);
      }
    };
    el.onerror = () => setFile(picked); // no se pudo medir en el navegador: se valida igual al subir
    el.src = URL.createObjectURL(picked);
  }
  async function upload(e: FormEvent) { e.preventDefault(); if (!file) return; setBusy(true); setError(null); try { const form = new FormData(); form.append('file', file); form.append('name', name || file.name.replace(/\.[^.]+$/, '')); await apiUpload('/api/org/wa-calls/audios', form); setFile(null); setName(''); notify('Audio cargado', { tone: 'success' }); onChange(); } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo cargar el audio'); } finally { setBusy(false); } }
  async function remove(audio: CallAudio) { const ok = await confirm({ title: 'Eliminar audio', message: `¿Eliminar “${audio.name}”? Si lo usa una campaña, el sistema no lo va a permitir.`, confirmLabel: 'Eliminar', tone: 'danger' }); if (!ok) return; try { await apiDelete(`/api/org/wa-calls/audios/${audio.id}`); notify('Audio eliminado', { tone: 'success' }); onChange(); } catch (err) { notify(err instanceof ApiError ? err.message : 'No se pudo eliminar el audio', { tone: 'error' }); } }
  return <section className="call-library-grid"><div className="call-table-card"><div className="call-section-heading"><div><h2>Biblioteca de audios</h2><p>Los audios que subís se reproducen en las llamadas de tus campañas.</p></div></div>{audios.length ? <div className="call-audio-list">{audios.map((audio) => <div className="call-audio-row" key={audio.id}><span className="call-audio-icon"><Ui name="volume" size={18} /></span><div><strong>{audio.name}</strong><small>Audio subido · {formatBytes(audio.size)}{audio.durationSeconds ? ` · ${audio.durationSeconds}s` : ''}</small></div><audio controls preload="none" src={audio.fileUrl} /><button type="button" className="btn secondary small" onClick={() => remove(audio)} aria-label={`Eliminar ${audio.name}`}><Ui name="trash" size={14} /></button></div>)}</div> : <EmptyState text="Subí tu primer audio para empezar" />}</div><div className="call-upload-card"><form onSubmit={upload}><span className="call-form-kicker">NUEVO AUDIO</span><h2>Subir audio</h2><p>Elegí un archivo de tu computadora o teléfono. Acepta MP3, WAV, M4A, OGG, OPUS, AAC y AMR; si hace falta, se convierte solo a MP3. <b>Máximo 60 segundos</b> (como un audio de WhatsApp).</p><input className="input" placeholder="Nombre del audio (opcional)" value={name} onChange={(e) => setName(e.target.value)} /><label className="call-file-picker"><input type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.opus,.amr" onChange={(e) => pickFile(e.target.files?.[0] || null)} />{file ? <><Ui name="volume" size={16} /> {file.name} · {formatBytes(file.size)}</> : <><Ui name="download" size={16} style={{ transform: 'rotate(180deg)' }} /> Elegir un audio</>}</label>{error && <div className="call-inline-error">{error}</div>}<button className="btn" disabled={!file || busy}>{busy ? 'Cargando…' : 'Subir audio'}</button></form></div></section>;
}

function AccountPanel({ accounts, provider, onConnect, onChange }: { accounts: CallAccount[]; provider: CallProviderInfo | null; onConnect: () => void; onChange: () => void }) {
  const { confirm, notify } = useAlerts();
  async function disconnect(account: CallAccount) {
    const accepted = await confirm({ title: 'Desconectar cuenta', message: '¿Querés desconectar esta cuenta de WhatsApp?', confirmLabel: 'Desconectar', tone: 'danger' });
    if (!accepted) return;
    try {
      await apiPost(`/api/org/wa-calls/accounts/${account.id}/disconnect`, {});
      onChange();
      notify('La cuenta de WhatsApp fue desconectada.', { tone: 'success' });
    } catch {
      notify('No se pudo desconectar la cuenta.', { tone: 'error' });
    }
  }
  return <section className="call-table-card"><div className="call-section-heading"><div><h2>Cuentas WhatsApp</h2><p>La cuenta seleccionada es la identidad que origina las llamadas.</p></div><button className="btn small" onClick={onConnect}>＋ Conectar cuenta</button></div><div className="call-account-list">{accounts.length ? accounts.map((account) => <div className="call-account-row" key={account.id}><span className={`call-account-dot ${account.status.toLowerCase()}`} /><div><strong>{account.name}</strong><small>{account.phoneNumber || 'Sin número identificado'} · {ACCOUNT_STATUS_LABEL[account.status] || account.status}</small>{account.status === 'RECONNECTING' && <small className="call-account-warning">La sesión sigue vinculada; esperando que el servidor recupere la conexión.</small>}</div><span className="call-account-provider">{provider?.label || 'Proveedor pendiente'}</span><button className="btn secondary small" onClick={() => disconnect(account)}>Desconectar</button></div>) : <EmptyState text="No hay una cuenta registrada" />}</div></section>;
}

function ConnectAccountModal({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) {
  const [status, setStatus] = useState<any>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function connect() { setBusy(true); setError(null); try { const result = await apiPost<any>('/api/org/wa-calls/accounts/connect', { name: 'WhatsApp principal' }); setStatus(result.status); if (result.status?.status === 'connected') onConnected(); } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo iniciar la conexión'); } finally { setBusy(false); } }
  useEffect(() => { connect(); }, []);
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const next = await apiGet<any>('/api/org/whatsapp/status');
        if (!active) return;
        setStatus(next);
        if (next?.status === 'connected') onConnected();
      } catch {
        // La conexión puede estar reiniciándose mientras Baileys abre el socket.
      }
    };
    const timer = window.setInterval(poll, 1000);
    poll();
    return () => { active = false; window.clearInterval(timer); };
  }, [onConnected]);
  return <Modal title="Conectar cuenta para llamadas" onClose={onClose}><div className="call-connect-modal"><p>Escaneá el QR desde WhatsApp → Dispositivos vinculados. La sesión queda en el servidor y se reutiliza después de reinicios.</p>{status?.qr ? <img className="call-qr" src={status.qr} alt="Código QR para conectar WhatsApp" /> : <div className="call-qr-placeholder">{busy ? 'Generando QR…' : status?.status === 'connected' ? 'Cuenta conectada' : 'Esperando QR…'}</div>}{error && <div className="call-inline-error">{error}</div>}<button className="btn" onClick={connect} disabled={busy}>{busy ? 'Conectando…' : 'Actualizar QR'}</button></div></Modal>;
}


function EmptyState({ text }: { text: string }) { return <div className="call-empty"><span><Glyph c="☎" size={28} /></span><strong>{text}</strong><small>Los datos aparecerán acá cuando el módulo tenga actividad.</small></div>; }
