import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost, apiUpload, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { Modal } from '../components/Modal';
import type {
  Campaign,
  CampaignRecipientInfo,
  CampaignSpeedProfile,
  CampaignStatus,
  Contact,
  WhatsAppSession
} from '../types';
import '../styles/campaigns.css';

const STATUS_LABEL: Record<CampaignStatus, string> = {
  DRAFT: 'Borrador',
  SCHEDULED: 'Programada',
  SENDING: 'Enviando',
  PAUSED: 'Pausada',
  COMPLETED: 'Completada',
  CANCELLED: 'Cancelada'
};

const STATUS_COLOR: Record<CampaignStatus, string> = {
  DRAFT: '#64748b',
  SCHEDULED: '#8b5cf6',
  SENDING: '#0284c7',
  PAUSED: '#f59e0b',
  COMPLETED: '#10b981',
  CANCELLED: '#ef4444'
};

const SPEED_OPTIONS: { key: CampaignSpeedProfile; icon: string; label: string; rate: number; description: string; recommended?: boolean }[] = [
  { key: 'CONSERVATIVE', icon: '🛡️', label: 'Conservador', rate: 10, description: 'Envío gradual y controlado' },
  { key: 'BALANCED', icon: '⚖️', label: 'Equilibrado', rate: 40, description: 'Buen equilibrio entre velocidad y distribución', recommended: true },
  { key: 'PERFORMANCE', icon: '⚡', label: 'Mejor rendimiento', rate: 60, description: 'Ritmo ágil para listas medianas' },
  { key: 'HIGH_PERFORMANCE', icon: '🚀', label: 'Alto rendimiento', rate: 100, description: 'Mayor velocidad para listas de mayor volumen' }
];

const EMPTY_COUNTS = { total: 0, pending: 0, sent: 0, delivered: 0, read: 0, failed: 0, replies: 0 };

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function getCounts(campaign: Campaign) {
  return { ...EMPTY_COUNTS, ...(campaign.counts || {}) };
}

function initials(contact: { name: string | null; phone: string | null }) {
  return (contact.name || contact.phone || '?').slice(0, 2).toUpperCase();
}

export function Campaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [statusFilter, setStatusFilter] = useState<CampaignStatus | 'ALL'>('ALL');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ campaigns: Campaign[] }>('/api/org/campaigns');
      setCampaigns(data.campaigns);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron cargar las campañas');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const socket = getSocket();
    const onUpdated = ({ campaign }: { campaign: Campaign }) => {
      setCampaigns((prev) => {
        const index = prev.findIndex((item) => item.id === campaign.id);
        return index === -1 ? [campaign, ...prev] : prev.map((item) => (item.id === campaign.id ? campaign : item));
      });
      setSelected((prev) => (prev?.id === campaign.id ? campaign : prev));
    };
    socket.on('campaign:updated', onUpdated);
    return () => { socket.off('campaign:updated', onUpdated); };
  }, []);

  async function handleAction(campaign: Campaign, action: 'start' | 'pause' | 'cancel' | 'retry-failed' | 'resend') {
    setActionError(null);
    try {
      const res = await apiPost<{ campaign: Campaign }>(`/api/org/campaigns/${campaign.id}/${action}`, {});
      setCampaigns((prev) => prev.map((item) => (item.id === campaign.id ? res.campaign : item)));
      setSelected((prev) => (prev?.id === campaign.id ? res.campaign : prev));
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'No se pudo actualizar la campaña');
    }
  }

  const summary = useMemo(() => campaigns.reduce((acc, campaign) => {
    const counts = getCounts(campaign);
    acc.recipients += counts.total;
    acc.sent += counts.sent + counts.delivered + counts.read;
    acc.delivered += counts.delivered + counts.read;
    acc.replies += counts.replies;
    return acc;
  }, { recipients: 0, sent: 0, delivered: 0, replies: 0 }), [campaigns]);

  const visibleCampaigns = statusFilter === 'ALL' ? campaigns : campaigns.filter((campaign) => campaign.status === statusFilter);

  return (
    <div className="page-shell campaign-page">
      <header className="page-header campaign-page-header">
        <div className="page-header-main">
          <div className="page-header-icon campaign-header-icon">◈</div>
          <div className="page-header-text">
            <h1 className="page-title">Campañas de WhatsApp</h1>
            <p className="page-subtitle">Creá, programá y medí envíos segmentados desde tu CRM.</p>
          </div>
        </div>
        <div className="page-header-actions">
          <button type="button" className="btn secondary" onClick={load} disabled={loading}>↻ Actualizar</button>
          <button type="button" className="btn" onClick={() => setShowCreate(true)}>＋ Nueva campaña</button>
        </div>
      </header>

      <section className="campaign-hero">
        <div>
          <span className="campaign-eyebrow">CENTRO DE DIFUSIÓN</span>
          <h2>Tu próxima conversación empieza acá.</h2>
          <p>Elegí a quién hablarle, prepará un mensaje rico en contenido y controlá cada entrega con trazabilidad.</p>
        </div>
        <div className="campaign-hero-badge"><span className="campaign-live-dot" /> Seguimiento en tiempo real</div>
      </section>

      <section className="campaign-stat-grid" aria-label="Resumen de campañas">
        <CampaignStat icon="▣" label="Campañas" value={campaigns.length} tone="blue" hint="historial completo" />
        <CampaignStat icon="♧" label="Destinatarios" value={summary.recipients} tone="purple" hint="contactos con teléfono" />
        <CampaignStat icon="✓" label="Enviados" value={summary.sent} tone="cyan" hint="incluye entregados y vistos" />
        <CampaignStat icon="◉" label="Entregados" value={summary.delivered} tone="green" hint="confirmados por WhatsApp" />
        <CampaignStat icon="↩" label="Respuestas" value={summary.replies} tone="orange" hint="desde el inicio de campaña" />
      </section>

      {actionError && <div className="campaign-alert error">{actionError}</div>}
      {loading && <div className="campaign-empty"><div className="campaign-spinner" /> Cargando el historial de campañas…</div>}
      {!loading && error && <div className="campaign-alert error">{error}</div>}

      {!loading && !error && (
        <>
          <div className="campaign-toolbar">
            <div>
              <h2>Historial de campañas</h2>
              <p>Consultá el estado, el rendimiento y el detalle de cada envío.</p>
            </div>
            <div className="campaign-filter-tabs" role="tablist" aria-label="Filtrar campañas">
              {(['ALL', 'SENDING', 'SCHEDULED', 'COMPLETED', 'PAUSED'] as const).map((filter) => (
                <button key={filter} type="button" role="tab" aria-selected={statusFilter === filter} className={statusFilter === filter ? 'active' : ''} onClick={() => setStatusFilter(filter)}>
                  {filter === 'ALL' ? 'Todas' : STATUS_LABEL[filter]}
                </button>
              ))}
            </div>
          </div>

          {visibleCampaigns.length === 0 && (
            <div className="campaign-empty campaign-empty-large">
              <div className="campaign-empty-icon">✦</div>
              <strong>{campaigns.length === 0 ? 'Todavía no hay campañas' : 'No hay campañas en este estado'}</strong>
              <span>{campaigns.length === 0 ? 'Creá tu primera campaña para empezar a conversar con tus contactos.' : 'Probá con otro filtro del historial.'}</span>
              {campaigns.length === 0 && <button type="button" className="btn" onClick={() => setShowCreate(true)}>Crear primera campaña</button>}
            </div>
          )}

          <div className="campaign-card-grid">
            {visibleCampaigns.map((campaign) => <CampaignCard key={campaign.id} campaign={campaign} onOpen={() => setSelected(campaign)} onAction={handleAction} />)}
          </div>
        </>
      )}

      {showCreate && <CreateCampaignModal onClose={() => setShowCreate(false)} onCreated={(campaign) => { setCampaigns((prev) => [campaign, ...prev]); setShowCreate(false); }} />}
      {selected && <CampaignDetailModal campaign={selected} onClose={() => setSelected(null)} onAction={handleAction} />}
    </div>
  );
}

function CampaignStat({ icon, label, value, hint, tone }: { icon: string; label: string; value: number; hint: string; tone: string }) {
  return <div className={`campaign-stat tone-${tone}`}><div className="campaign-stat-top"><span>{label}</span><b>{icon}</b></div><strong>{value.toLocaleString('es')}</strong><small>{hint}</small></div>;
}

function CampaignCard({ campaign, onOpen, onAction }: { campaign: Campaign; onOpen: () => void; onAction: (campaign: Campaign, action: 'start' | 'pause' | 'cancel' | 'retry-failed' | 'resend') => void }) {
  const counts = getCounts(campaign);
  const progress = counts.total === 0 ? 0 : Math.round(((counts.sent + counts.delivered + counts.read) / counts.total) * 100);
  const canStart = ['DRAFT', 'SCHEDULED', 'PAUSED'].includes(campaign.status);
  return (
    <article className="campaign-card">
      <button type="button" className="campaign-card-main" onClick={onOpen} aria-label={`Ver detalle de ${campaign.name}`}>
        <div className="campaign-card-heading"><div className="campaign-card-symbol">{campaign.attachment ? '◫' : '✉'}</div><div className="campaign-card-title"><strong>{campaign.name}</strong><span>{formatDate(campaign.createdAt)}</span></div><span className="campaign-status" style={{ background: STATUS_COLOR[campaign.status] }}>{STATUS_LABEL[campaign.status]}</span></div>
        <p className="campaign-card-message">{campaign.message}</p>
        <div className="campaign-card-meta"><span>◌ {campaign.tagFilter.length ? campaign.tagFilter.join(', ') : 'Selección manual'}</span><span>♧ {counts.total} contactos</span></div>
        <div className="campaign-progress"><span style={{ width: `${progress}%` }} /></div>
        <div className="campaign-card-counts"><span><b>{counts.sent + counts.delivered + counts.read}</b> enviados</span><span><b>{counts.delivered + counts.read}</b> entregados</span><span><b>{counts.read}</b> vistos</span><span><b>{counts.replies}</b> respuestas</span></div>
      </button>
      <div className="campaign-card-footer"><span className="campaign-speed-label">{SPEED_OPTIONS.find((option) => option.key === campaign.speedProfile)?.icon || '⚖️'} {campaign.messagesPerHour || 40}/h</span><div className="campaign-card-actions">
        {canStart && <button type="button" className="btn small" onClick={() => onAction(campaign, 'start')}>▶ Iniciar</button>}
        {campaign.status === 'SENDING' && <button type="button" className="btn secondary small" onClick={() => onAction(campaign, 'pause')}>Ⅱ Pausar</button>}
        {counts.failed > 0 && ['COMPLETED', 'PAUSED'].includes(campaign.status) && <button type="button" className="btn secondary small" onClick={() => onAction(campaign, 'retry-failed')}>↻ Fallidos</button>}
        {['COMPLETED', 'CANCELLED'].includes(campaign.status) && <button type="button" className="btn secondary small" onClick={() => onAction(campaign, 'resend')}>↗ Reenviar</button>}
      </div></div>
    </article>
  );
}

function CreateCampaignModal({ onClose, onCreated }: { onClose: () => void; onCreated: (campaign: Campaign) => void }) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [sessions, setSessions] = useState<WhatsAppSession[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [contactSearch, setContactSearch] = useState('');
  const [speedProfile, setSpeedProfile] = useState<CampaignSpeedProfile>('BALANCED');
  const [campaignType, setCampaignType] = useState<'DIRECT' | 'SCHEDULED'>('DIRECT');
  const [scheduledAt, setScheduledAt] = useState('');
  const [sendLine, setSendLine] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [loadingAudience, setLoadingAudience] = useState(true);
  const [refreshingSessions, setRefreshingSessions] = useState(false);
  const [syncingContacts, setSyncingContacts] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([apiGet<{ contacts: Contact[] }>('/api/org/contacts?limit=500'), apiGet<{ sessions: WhatsAppSession[] }>('/api/org/whatsapp/sessions')]).then(([contactData, sessionData]) => {
      setContacts(contactData.contacts);
      setSessions(sessionData.sessions);
      if (sessionData.sessions.length > 0) setSendLine(sessionData.sessions[0].id);
    }).catch((err) => setError(err instanceof ApiError ? err.message : 'No se pudo cargar la audiencia')).finally(() => setLoadingAudience(false));
  }, []);

  async function refreshSessions() {
    setRefreshingSessions(true);
    try {
      const data = await apiGet<{ sessions: WhatsAppSession[] }>('/api/org/whatsapp/sessions');
      setSessions(data.sessions);
      if (!sendLine && data.sessions.length > 0) setSendLine(data.sessions[0].id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron actualizar las sesiones');
    } finally {
      setRefreshingSessions(false);
    }
  }

  async function syncPhoneContacts() {
    setSyncingContacts(true);
    setError(null);
    setSyncMessage(null);
    try {
      const result = await apiPost<{ imported: number; updated: number; total: number }>('/api/org/whatsapp/sync-contacts', {});
      const data = await apiGet<{ contacts: Contact[] }>('/api/org/contacts?limit=500');
      setContacts(data.contacts);
      setSyncMessage(`${result.imported} contactos importados · ${result.updated} actualizados`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron sincronizar los contactos del teléfono');
    } finally {
      setSyncingContacts(false);
    }
  }

  const availableTags = useMemo(() => Array.from(new Set(contacts.flatMap((contact) => contact.tags))).sort((a, b) => a.localeCompare(b)), [contacts]);
  const visibleContacts = useMemo(() => {
    const query = contactSearch.trim().toLowerCase();
    return contacts.filter((contact) => !query || `${contact.name || ''} ${contact.phone || ''}`.toLowerCase().includes(query)).slice(0, 120);
  }, [contacts, contactSearch]);
  const audience = useMemo(() => contacts.filter((contact) => contact.phone && (selectedContactIds.includes(contact.id) || contact.tags.some((tag) => selectedTags.includes(tag)))), [contacts, selectedContactIds, selectedTags]);
  const selectedSpeed = SPEED_OPTIONS.find((option) => option.key === speedProfile) || SPEED_OPTIONS[1];

  function toggleTag(tag: string) {
    setSelectedTags((prev) => prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]);
  }

  function toggleContact(id: string) {
    setSelectedContactIds((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]);
  }

  function toggleVisibleContacts() {
    const visibleIds = visibleContacts.filter((contact) => contact.phone).map((contact) => contact.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedContactIds.includes(id));
    setSelectedContactIds((prev) => allSelected ? prev.filter((id) => !visibleIds.includes(id)) : Array.from(new Set([...prev, ...visibleIds])));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !message.trim()) return setError('Completá el nombre y el mensaje de la campaña.');
    if (audience.length === 0) return setError('Seleccioná al menos una etiqueta o un contacto con teléfono.');
    if (campaignType === 'SCHEDULED' && !scheduledAt) return setError('Elegí fecha y hora para programar el envío.');
    setSubmitting(true);
    setError(null);
    try {
      const response = await apiPost<{ campaign: Campaign }>('/api/org/campaigns', { name: name.trim(), message: message.trim(), tagFilter: selectedTags, contactIds: selectedContactIds, sendLine: sendLine || undefined, campaignType, speedProfile, messagesPerHour: selectedSpeed.rate, scheduledAt: campaignType === 'SCHEDULED' ? new Date(scheduledAt).toISOString() : undefined });
      let campaign = response.campaign;
      if (file) {
        const body = new FormData();
        body.append('file', file);
        campaign = (await apiUpload<{ campaign: Campaign }>(`/api/org/campaigns/${campaign.id}/attachment`, body)).campaign;
      }
      onCreated(campaign);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear la campaña');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Crear nueva campaña" onClose={onClose} className="campaign-modal campaign-create-modal">
      <form onSubmit={handleSubmit}>
        <div className="campaign-modal-intro"><span>✦</span><div><strong>Diseñá un envío controlado</strong><p>La audiencia se toma de tus contactos del CRM y queda registrada en el historial.</p></div></div>
        <div className="campaign-form-grid"><div className="field"><label htmlFor="campaign-name">Nombre de la campaña</label><input id="campaign-name" className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Promo fin de mes" /></div><div className="field"><label htmlFor="campaign-line">Línea de envío</label><select id="campaign-line" className="input" value={sendLine} onChange={(event) => setSendLine(event.target.value)}><option value="">Usar sesión disponible</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.label} · {session.status === 'connected' ? 'Conectada' : session.status}</option>)}</select><div className="campaign-session-tools"><button type="button" className="campaign-inline-button" onClick={refreshSessions} disabled={refreshingSessions}>{refreshingSessions ? 'Actualizando…' : '↻ Actualizar sesiones'}</button>{sessions.length > 0 && <span>Sesiones activas: {sessions.filter((session) => session.status === 'connected').length}</span>}</div>{sessions.length === 0 && <small className="campaign-field-hint warning">No hay una sesión conectada. Podés guardar la campaña y conectarla antes de iniciar.</small>}</div></div>
        <div className="field"><label htmlFor="campaign-message">Mensaje</label><textarea id="campaign-message" className="input campaign-message-input" rows={5} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Escribí el mensaje que va a recibir cada cliente…" /><div className="campaign-emoji-row"><span>Agregar:</span>{['👋', '✨', '🎉', '📣', '✅', '💬'].map((emoji) => <button type="button" key={emoji} onClick={() => setMessage((current) => `${current}${current ? ' ' : ''}${emoji}`)}>{emoji}</button>)}</div></div>
        <div className="campaign-form-section"><div className="campaign-section-heading"><div><h3>Audiencia</h3><p>Combiná etiquetas y contactos puntuales. No se repiten destinatarios.</p></div><span className="campaign-audience-count">{audience.length} con teléfono</span></div><div className="campaign-audience-tools"><input className="input" value={contactSearch} onChange={(event) => setContactSearch(event.target.value)} placeholder="Buscar por nombre o teléfono…" /><button type="button" className="btn secondary small" onClick={toggleVisibleContacts} disabled={visibleContacts.length === 0}>{visibleContacts.length > 0 && visibleContacts.filter((contact) => contact.phone).every((contact) => selectedContactIds.includes(contact.id)) ? 'Quitar visibles' : 'Seleccionar visibles'}</button><button type="button" className="btn secondary small" onClick={syncPhoneContacts} disabled={syncingContacts}>{syncingContacts ? 'Sincronizando…' : '↻ Sincronizar teléfono'}</button></div>{syncMessage && <div className="campaign-sync-success">✓ {syncMessage}</div>}<div className="campaign-tags">{availableTags.map((tag) => <button type="button" key={tag} className={`campaign-tag ${selectedTags.includes(tag) ? 'active' : ''}`} onClick={() => toggleTag(tag)}># {tag}</button>)}{availableTags.length === 0 && !loadingAudience && <span className="campaign-field-hint">Todavía no hay etiquetas creadas en el CRM.</span>}</div><div className="campaign-contact-picker">{loadingAudience ? <div className="campaign-picker-loading">Cargando contactos…</div> : visibleContacts.length === 0 ? <div className="campaign-picker-loading">No encontramos contactos con esa búsqueda.</div> : visibleContacts.map((contact) => { const selectedContact = selectedContactIds.includes(contact.id) || contact.tags.some((tag) => selectedTags.includes(tag)); return <button type="button" key={contact.id} className={`campaign-contact-row ${selectedContact ? 'selected' : ''}`} onClick={() => toggleContact(contact.id)} disabled={!contact.phone}><span className="campaign-check">{selectedContact ? '✓' : ''}</span><span className="campaign-avatar">{initials(contact)}</span><span className="campaign-contact-name"><b>{contact.name || 'Sin nombre'}</b><small>{contact.phone || 'Sin teléfono'}{contact.tags.length ? ` · ${contact.tags.slice(0, 2).join(', ')}` : ''}</small></span></button>; })}</div></div>
        <div className="campaign-form-section"><div className="campaign-section-heading"><div><h3>Velocidad de envío</h3><p>Elegí el ritmo de entrega por hora para distribuir la campaña.</p></div><span className="campaign-rate-summary">{selectedSpeed.rate} mensajes/hora</span></div><div className="campaign-speed-grid">{SPEED_OPTIONS.map((option) => <button type="button" key={option.key} className={`campaign-speed-option ${speedProfile === option.key ? 'selected' : ''}`} onClick={() => setSpeedProfile(option.key)}><span className="campaign-radio">{speedProfile === option.key ? '●' : ''}</span><span className="campaign-speed-icon">{option.icon}</span><span className="campaign-speed-copy"><b>{option.label}</b>{option.recommended && <em>Recomendado</em>}<small>Hasta {option.rate} mensajes por hora · {option.description}.</small></span></button>)}</div></div>
        <div className="campaign-form-grid"><div className="field"><label htmlFor="campaign-type">Tipo de campaña</label><select id="campaign-type" className="input" value={campaignType} onChange={(event) => setCampaignType(event.target.value as 'DIRECT' | 'SCHEDULED')}><option value="DIRECT">Directa · enviar al iniciar</option><option value="SCHEDULED">Programada · enviar en una fecha</option></select></div>{campaignType === 'SCHEDULED' && <div className="field"><label htmlFor="campaign-schedule">Fecha y hora de inicio</label><input id="campaign-schedule" type="datetime-local" className="input" value={scheduledAt} onInput={(event) => setScheduledAt(event.currentTarget.value)} onChange={(event) => setScheduledAt(event.currentTarget.value)} /></div>}</div>
        <div className="field"><label htmlFor="campaign-file">Contenido multimedia (opcional)</label><input id="campaign-file" type="file" className="campaign-file-input" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" onChange={(event) => setFile(event.target.files?.[0] || null)} />{file && <small className="campaign-field-hint">Adjunto seleccionado: {file.name}</small>}</div>
        <div className="campaign-safety-note"><span>🛡️</span><p><b>Envío responsable.</b> Usá contactos con consentimiento, mantené una opción de baja y evitá mensajes repetitivos o listas compradas. Los perfiles de velocidad ayudan a distribuir el tráfico, pero no reemplazan las buenas prácticas de WhatsApp.</p></div>
        {error && <div className="campaign-alert error">{error}</div>}
        <div className="campaign-modal-actions"><button type="button" className="btn secondary" onClick={onClose}>Cancelar</button><button type="submit" className="btn" disabled={submitting || loadingAudience}>{submitting ? 'Creando campaña…' : campaignType === 'SCHEDULED' ? 'Programar campaña' : 'Crear campaña'}</button></div>
      </form>
    </Modal>
  );
}

function CampaignDetailModal({ campaign, onClose, onAction }: { campaign: Campaign; onClose: () => void; onAction: (campaign: Campaign, action: 'start' | 'pause' | 'cancel' | 'retry-failed' | 'resend') => void }) {
  const [detail, setDetail] = useState<{ campaign: Campaign; recipients: CampaignRecipientInfo[] } | null>(null);
  const [recipientFilter, setRecipientFilter] = useState<'ALL' | 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'>('ALL');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    apiGet<{ campaign: Campaign; recipients: CampaignRecipientInfo[] }>(`/api/org/campaigns/${campaign.id}`).then(setDetail).catch(() => {}).finally(() => setLoading(false));
  }, [campaign.id]);

  useEffect(() => {
    setDetail((previous) => previous ? { ...previous, campaign } : previous);
  }, [campaign]);

  const current = detail?.campaign || campaign;
  const counts = getCounts(current);
  const recipients = detail?.recipients || [];
  const filteredRecipients = recipientFilter === 'ALL' ? recipients : recipients.filter((recipient) => recipient.status === recipientFilter);
  const speed = SPEED_OPTIONS.find((option) => option.key === current.speedProfile);

  return (
    <Modal title={current.name} onClose={onClose} className="campaign-modal campaign-detail-modal">
      <div className="campaign-detail-top"><div><span className="campaign-eyebrow">DETALLE E HISTORIAL</span><p className="campaign-detail-subtitle">Creada {formatDate(current.createdAt)} · {current.campaignType === 'SCHEDULED' ? `Programada para ${formatDate(current.scheduledAt)}` : 'Envío directo'}</p></div><span className="campaign-status" style={{ background: STATUS_COLOR[current.status] }}>{STATUS_LABEL[current.status]}</span></div>
      <div className="campaign-detail-kpis"><DetailKpi label="Total" value={counts.total} /><DetailKpi label="Pendientes" value={counts.pending} /><DetailKpi label="Enviados" value={counts.sent + counts.delivered + counts.read} tone="blue" /><DetailKpi label="Entregados" value={counts.delivered + counts.read} tone="green" /><DetailKpi label="Vistos" value={counts.read} tone="purple" /><DetailKpi label="Respuestas" value={counts.replies} tone="orange" /></div>
      <div className="campaign-detail-layout"><div className="campaign-detail-main"><section className="campaign-detail-message"><div className="campaign-section-heading"><div><h3>Mensaje enviado</h3><p>{current.attachment ? `${current.attachment.fileName} · ${current.attachment.mimeType}` : 'Mensaje de texto'}</p></div><span className="campaign-detail-speed">{speed?.icon || '⚖️'} {current.messagesPerHour || 40}/h</span></div><div className="campaign-message-preview">{current.message}</div></section>
        <section className="campaign-history-section"><div className="campaign-section-heading"><div><h3>Historial de destinatarios</h3><p>Cada contacto conserva su estado y marca de tiempo.</p></div><select className="input campaign-history-filter" value={recipientFilter} onChange={(event) => setRecipientFilter(event.target.value as typeof recipientFilter)}><option value="ALL">Todos ({recipients.length})</option><option value="PENDING">Pendientes ({counts.pending})</option><option value="SENT">Enviados ({counts.sent})</option><option value="DELIVERED">Entregados ({counts.delivered})</option><option value="READ">Vistos ({counts.read})</option><option value="FAILED">Fallidos ({counts.failed})</option></select></div>{loading ? <div className="campaign-picker-loading">Cargando historial…</div> : <div className="campaign-recipient-table">{filteredRecipients.map((recipient) => <div className="campaign-recipient-row" key={recipient.id}><span className="campaign-avatar">{initials(recipient.contact)}</span><span className="campaign-recipient-person"><b>{recipient.contact.name || 'Sin nombre'}</b><small>{recipient.contact.phone || 'Sin teléfono'}</small></span><span className={`campaign-recipient-status ${recipient.status.toLowerCase()}`}>{recipient.status === 'PENDING' ? 'Pendiente' : recipient.status === 'SENT' ? 'Enviado' : recipient.status === 'DELIVERED' ? 'Entregado' : recipient.status === 'READ' ? 'Visto' : 'Fallido'}</span><span className="campaign-recipient-time">{formatDate(recipient.readAt || recipient.deliveredAt || recipient.sentAt)}{recipient.errorMessage && <small title={recipient.errorMessage}> · Error</small>}</span></div>)}{filteredRecipients.length === 0 && <div className="campaign-picker-loading">No hay destinatarios en este estado.</div>}</div>}</section>
      </div><aside className="campaign-detail-aside"><div className="campaign-aside-card"><span className="campaign-aside-label">AUDIENCIA</span><strong>{counts.total} contactos</strong><p>{current.tagFilter.length ? current.tagFilter.map((tag) => `#${tag}`).join(' · ') : 'Selección manual'}</p><div className="campaign-aside-divider" /><span className="campaign-aside-label">LÍNEA DE ENVÍO</span><strong>{current.sendLine || 'Sesión disponible'}</strong><div className="campaign-aside-divider" /><span className="campaign-aside-label">PROGRAMACIÓN</span><strong>{current.scheduledAt ? formatDate(current.scheduledAt) : 'Al iniciar manualmente'}</strong></div><div className="campaign-aside-actions">{['DRAFT', 'SCHEDULED', 'PAUSED'].includes(current.status) && <button type="button" className="btn" onClick={() => onAction(current, 'start')}>▶ Iniciar envío</button>}{current.status === 'SENDING' && <button type="button" className="btn secondary" onClick={() => onAction(current, 'pause')}>Ⅱ Pausar campaña</button>}{counts.failed > 0 && ['COMPLETED', 'PAUSED'].includes(current.status) && <button type="button" className="btn secondary" onClick={() => onAction(current, 'retry-failed')}>↻ Reintentar fallidos</button>}{['COMPLETED', 'CANCELLED'].includes(current.status) && <button type="button" className="btn secondary" onClick={() => onAction(current, 'resend')}>↗ Reenviar campaña</button>}{['DRAFT', 'SCHEDULED', 'SENDING', 'PAUSED'].includes(current.status) && <button type="button" className="campaign-danger-link" onClick={() => onAction(current, 'cancel')}>Cancelar campaña</button>}</div></aside></div>
    </Modal>
  );
}

function DetailKpi({ label, value, tone = '' }: { label: string; value: number; tone?: string }) {
  return <div className={`campaign-detail-kpi ${tone}`}><span>{label}</span><strong>{value.toLocaleString('es')}</strong></div>;
}
