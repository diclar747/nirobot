import { FormEvent, useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPost, apiUpload, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { Modal } from '../components/Modal';
import { useAlerts } from '../context/AlertContext';
import type { CallAccount, CallAudio, CallCampaign, CallCampaignCounts, CallDashboardStats, CallProviderInfo } from '../types';
import '../styles/call-campaigns.css';
import { Glyph, Ui } from '../components/Ui';
import { CallCampaignWizard } from '../components/CallCampaignWizard';

type Tab = 'dashboard' | 'campaigns' | 'history' | 'audios' | 'accounts';

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
  const [showCreate, setShowCreate] = useState(false);
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

  async function performAction(campaign: CallCampaign, action: 'start' | 'pause' | 'resume' | 'cancel') {
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
      const result = await apiGet<{ attempts: any[] }>('/api/org/wa-calls/history?limit=200');
      setHistory(result.attempts || []);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo cargar el historial'); }
  }

  useEffect(() => { if (tab === 'history') loadHistory(); }, [tab]);

  return (
    <div className="page-shell call-page">
      <header className="page-header call-page-header">
        <div className="page-header-main">
          <div className="page-header-icon call-header-icon"><Glyph c="☎" size={22} /></div>
          <div className="page-header-text">
            <h1 className="page-title">Campañas de llamadas</h1>
            <p className="page-subtitle">Programá llamadas autorizadas, reproducí un audio y seguí cada resultado desde un solo lugar.</p>
          </div>
        </div>
        <div className="page-header-actions call-header-actions">
          <button type="button" className="btn secondary" onClick={load} disabled={loading}><Glyph c="↻" size={15} /> Actualizar</button>
          <button type="button" className="btn secondary" onClick={() => setShowConnect(true)}><Glyph c="◉" size={15} /> Cuenta WhatsApp</button>
          <button type="button" className="btn" onClick={() => setShowCreate(true)}>＋ Nueva campaña</button>
        </div>
      </header>

      <section className="call-hero">
        <div>
          <span className="call-eyebrow">WHATSAPP VOICE CENTER</span>
          <h2>Gestioná tus llamadas desde un solo lugar.</h2>
          <p>Prepará campañas, supervisá cada resultado y mantené todo el historial de voz organizado.</p>
        </div>
        <div className="call-hero-badge"><span className="call-live-dot" /> Seguimiento en tiempo real</div>
      </section>

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
          {tab === 'dashboard' && <Dashboard stats={stats} campaigns={campaigns.slice(0, 6)} onAction={performAction} onOpenCampaign={(campaign) => { setTab('campaigns'); setCampaigns((current) => current.map((item) => item.id === campaign.id ? campaign : item)); }} />}
          {tab === 'campaigns' && <CampaignList campaigns={campaigns} onAction={performAction} />}
          {tab === 'history' && <HistoryTable attempts={history} />}
          {tab === 'audios' && <AudioLibrary audios={audios} onChange={load} />}
          {tab === 'accounts' && <AccountPanel accounts={accounts} provider={provider} onConnect={() => setShowConnect(true)} onChange={load} />}
        </div>
      )}

      {showCreate && <CallCampaignWizard accounts={accounts} audios={audios} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {showConnect && <ConnectAccountModal onClose={() => setShowConnect(false)} onConnected={() => { setShowConnect(false); load(); }} />}
    </div>
  );
}

function Dashboard({ stats, campaigns, onAction, onOpenCampaign }: { stats: CallDashboardStats; campaigns: CallCampaign[]; onAction: (campaign: CallCampaign, action: 'start' | 'pause' | 'resume' | 'cancel') => void; onOpenCampaign: (campaign: CallCampaign) => void }) {
  const cards = [['Llamadas totales', stats.totalCalls, '☎', 'blue'], ['Minutos hablados', stats.totalMinutes, '◷', 'purple'], ['Atendidas', stats.attendedCalls, '✓', 'green'], ['Llamadas directas', stats.directCalls, '↗', 'cyan'], ['Programadas', stats.scheduled, '◷', 'blue'], ['En cola', stats.queued, '≋', 'purple'], ['En proceso', stats.inProgress, '◉', 'cyan'], ['Conectadas', stats.connected, '✓', 'green'], ['No contestadas', stats.noAnswer, '↯', 'orange'], ['Fallidas', stats.failed, '!', 'red'], ['Pendientes de encuesta', stats.pendingSurvey, '?', 'pink'], ['Respuestas recibidas', stats.surveyResponses, '↩', 'indigo']];
  return <>
    <section className="call-stat-grid">{cards.map(([label, value, icon, tone]) => <div className={`call-stat tone-${tone}`} key={label}><div><span>{label}</span><b><Glyph c={String(icon)} size={18} /></b></div><strong>{Number(value).toLocaleString('es')}</strong><small>actualizado en tiempo real</small></div>)}</section>
    <section className="call-section-heading"><div><h2>Campañas recientes</h2><p>Supervisá el avance y actuá sobre las campañas sin salir del panel.</p></div><span className="call-live-badge"><i /> Tiempo real</span></section>
    <div className="call-campaign-grid">{campaigns.length ? campaigns.map((campaign) => <CallCampaignCard key={campaign.id} campaign={campaign} onAction={onAction} onOpen={() => onOpenCampaign(campaign)} />) : <EmptyState text="Todavía no hay campañas de llamadas" />}</div>
  </>;
}

function CampaignList({ campaigns, onAction }: { campaigns: CallCampaign[]; onAction: (campaign: CallCampaign, action: 'start' | 'pause' | 'resume' | 'cancel') => void }) {
  return <section className="call-table-card"><div className="call-section-heading"><div><h2>Historial de campañas</h2><p>Estados persistidos, progreso y acciones de cada campaña.</p></div></div>{campaigns.length ? <div className="call-campaign-grid">{campaigns.map((campaign) => <CallCampaignCard key={campaign.id} campaign={campaign} onAction={onAction} />)}</div> : <EmptyState text="No hay campañas creadas" />}</section>;
}

function CallCampaignCard({ campaign, onAction, onOpen }: { campaign: CallCampaign; onAction: (campaign: CallCampaign, action: 'start' | 'pause' | 'resume' | 'cancel') => void; onOpen?: () => void }) {
  const data = counts(campaign);
  const progress = data.total ? Math.round(((data.completed + data.noAnswer + data.failed + data.cancelled) / data.total) * 100) : 0;
  return <article className="call-campaign-card">
    <button type="button" className="call-card-main" onClick={onOpen}>
      <div className="call-card-top"><span className="call-card-icon"><Glyph c={campaign.status === 'RUNNING' ? '◉' : '☎'} size={20} /></span><div><strong>{campaign.name}</strong><small>{formatDate(campaign.createdAt)}</small></div><span className={`call-status status-${campaign.status.toLowerCase()}`}>{STATUS_LABEL[campaign.status]}</span></div>
      <p>{campaign.description || `${campaign.audio?.name || 'Audio'} · ${campaign.account?.name || 'Cuenta WhatsApp'}`}</p>
      <div className="call-progress"><span style={{ width: `${progress}%` }} /></div><div className="call-progress-label"><span>{progress}% procesado</span><b>{data.total} destinatarios</b></div>
      <div className="call-count-row"><span><b>{data.connected}</b> conectadas</span><span><b>{data.noAnswer}</b> no contestadas</span><span><b>{data.failed}</b> fallidas</span></div>
    </button>
    <div className="call-card-footer"><span><Glyph c="♫" size={13} /> {campaign.audio?.name || 'Sin audio'}</span><div>{['DRAFT', 'PAUSED'].includes(campaign.status) && <button type="button" className="btn small" onClick={() => onAction(campaign, campaign.status === 'PAUSED' ? 'resume' : 'start')}>{campaign.status === 'PAUSED' ? <><Glyph c="▶" size={13} /> Reanudar</> : <><Glyph c="▶" size={13} /> Iniciar</>}</button>}{campaign.status === 'RUNNING' && <button type="button" className="btn secondary small" onClick={() => onAction(campaign, 'pause')}>Ⅱ Pausar</button>}{!['COMPLETED', 'CANCELLED'].includes(campaign.status) && <button type="button" className="btn danger small" onClick={() => onAction(campaign, 'cancel')}>× Cancelar</button>}</div></div>
  </article>;
}

function HistoryTable({ attempts }: { attempts: any[] }) {
  return <section className="call-table-card"><div className="call-section-heading"><div><h2>Historial completo de llamadas</h2><p>Incluye campañas y llamadas individuales realizadas desde el chat, con duración y resultado.</p></div><a className="btn secondary small" href="/api/org/wa-calls/history?format=csv"><Glyph c="↓" size={15} /> Exportar CSV</a></div>{attempts.length ? <div className="call-history-table-wrap"><table className="call-history-table"><thead><tr><th>Fecha</th><th>Tipo</th><th>Contacto</th><th>Campaña / origen</th><th>Cuenta</th><th>Resultado</th><th>Duración</th><th>Detalle</th></tr></thead><tbody>{attempts.map((attempt) => { const direct = attempt.recordType === 'DIRECT'; const duration = Number(attempt.durationSeconds || 0); return <tr key={`${attempt.recordType || 'CAMPAIGN'}-${attempt.id}`}><td>{formatDate(attempt.createdAt)}</td><td><span className="call-history-kind">{direct ? 'Directa' : 'Campaña'}</span></td><td><strong>{direct ? attempt.contact?.name || 'Sin nombre' : attempt.campaignContact?.contact?.name || 'Sin nombre'}</strong><small>{direct ? attempt.phoneNumber : attempt.campaignContact?.phoneNumber}</small></td><td>{direct ? 'Llamada desde el chat' : attempt.campaign?.name}</td><td>{attempt.account?.name || '—'}</td><td><span className={`call-status status-${String(attempt.status).toLowerCase()}`}>{CALL_STATUS_LABEL[attempt.status] || attempt.status}</span></td><td>{duration ? `${Math.floor(duration / 60)}m ${duration % 60}s` : '—'}</td><td>{attempt.errorMessage || attempt.endedReason || '—'}</td></tr>; })}</tbody></table></div> : <EmptyState text="Todavía no hay llamadas registradas" />}</section>;
}

function AudioLibrary({ audios, onChange }: { audios: CallAudio[]; onChange: () => void }) {
  const { confirm, notify } = useAlerts();
  const [file, setFile] = useState<File | null>(null); const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function upload(e: FormEvent) { e.preventDefault(); if (!file) return; setBusy(true); setError(null); try { const form = new FormData(); form.append('file', file); form.append('name', name || file.name.replace(/\.[^.]+$/, '')); await apiUpload('/api/org/wa-calls/audios', form); setFile(null); setName(''); notify('Audio cargado', { tone: 'success' }); onChange(); } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo cargar el audio'); } finally { setBusy(false); } }
  async function remove(audio: CallAudio) { const ok = await confirm({ title: 'Eliminar audio', message: `¿Eliminar “${audio.name}”? Si lo usa una campaña, el sistema no lo va a permitir.`, confirmLabel: 'Eliminar', tone: 'danger' }); if (!ok) return; try { await apiDelete(`/api/org/wa-calls/audios/${audio.id}`); notify('Audio eliminado', { tone: 'success' }); onChange(); } catch (err) { notify(err instanceof ApiError ? err.message : 'No se pudo eliminar el audio', { tone: 'error' }); } }
  return <section className="call-library-grid"><div className="call-table-card"><div className="call-section-heading"><div><h2>Biblioteca de audios</h2><p>Los audios que subís se reproducen en las llamadas de tus campañas.</p></div></div>{audios.length ? <div className="call-audio-list">{audios.map((audio) => <div className="call-audio-row" key={audio.id}><span className="call-audio-icon"><Ui name="volume" size={18} /></span><div><strong>{audio.name}</strong><small>Audio subido · {formatBytes(audio.size)}{audio.durationSeconds ? ` · ${audio.durationSeconds}s` : ''}</small></div><audio controls preload="none" src={audio.fileUrl} /><button type="button" className="btn secondary small" onClick={() => remove(audio)} aria-label={`Eliminar ${audio.name}`}><Ui name="trash" size={14} /></button></div>)}</div> : <EmptyState text="Subí tu primer audio para empezar" />}</div><div className="call-upload-card"><form onSubmit={upload}><span className="call-form-kicker">NUEVO AUDIO</span><h2>Subir audio</h2><p>Elegí un archivo de tu computadora o teléfono. Acepta MP3, WAV, M4A, OGG, OPUS, AAC y AMR; si hace falta, se convierte solo a MP3.</p><input className="input" placeholder="Nombre del audio (opcional)" value={name} onChange={(e) => setName(e.target.value)} /><label className="call-file-picker"><input type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.opus,.amr" onChange={(e) => setFile(e.target.files?.[0] || null)} />{file ? <><Ui name="volume" size={16} /> {file.name} · {formatBytes(file.size)}</> : <><Ui name="download" size={16} style={{ transform: 'rotate(180deg)' }} /> Elegir un audio</>}</label>{error && <div className="call-inline-error">{error}</div>}<button className="btn" disabled={!file || busy}>{busy ? 'Cargando…' : 'Subir audio'}</button></form></div></section>;
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
