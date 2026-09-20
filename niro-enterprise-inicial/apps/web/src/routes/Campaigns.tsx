import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost, apiUpload, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { Modal } from '../components/Modal';
import { EmojiPicker } from '../components/EmojiPicker';
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

const CAMPAIGN_VARIABLES = [
  { token: '{{nombre}}', label: 'Nombre', description: 'Primer nombre del contacto' },
  { token: '{{nombre_completo}}', label: 'Nombre completo', description: 'Nombre completo del contacto' },
  { token: '{{telefono}}', label: 'Teléfono', description: 'Número del contacto' },
  { token: '{{email}}', label: 'Email', description: 'Correo del contacto' }
];

const CAMPAIGN_WIZARD_STEPS = [
  { number: 1, label: 'Datos básicos', shortLabel: 'Datos', description: 'Nombrá la campaña y elegí la línea de WhatsApp.' },
  { number: 2, label: 'Mensaje y contenido', shortLabel: 'Mensaje', description: 'Escribí el mensaje y agregá un archivo opcional.' },
  { number: 3, label: 'Personalización', shortLabel: 'Personalizar', description: 'Prepará un mensaje distinto para cada contacto.' },
  { number: 4, label: 'Audiencia', shortLabel: 'Contactos', description: 'Seleccioná etiquetas, contactos o sincronizá el teléfono.' },
  { number: 5, label: 'Programación', shortLabel: 'Programar', description: 'Definí si se envía al iniciar o en una fecha.' },
  { number: 6, label: 'Velocidad', shortLabel: 'Velocidad', description: 'Elegí el ritmo de entrega por hora.' },
  { number: 7, label: 'Revisión', shortLabel: 'Revisar', description: 'Verificá todo antes de guardar la campaña.' }
];

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function getCounts(campaign: Campaign) {
  return { ...EMPTY_COUNTS, ...(campaign.counts || {}) };
}

interface WaGroup { id: string; name: string; size: number; announce: boolean; canSend: boolean }

function formatPhone(phone: string | null) {
  if (!phone) return 'Sin teléfono';
  return /^\d{8,}$/.test(phone) ? `+${phone}` : phone;
}

function contactHasSelectedTag(contact: Contact, selectedTags: string[]) {
  return contact.tags.some((tag) => selectedTags.includes(tag)) || (contact.crmTags || []).some((tag) => selectedTags.includes(tag));
}

function initials(contact: { name: string | null; phone: string | null }) {
  return (contact.name || contact.phone || '?').slice(0, 2).toUpperCase();
}

function personalizeCampaignMessage(template: string, contact: Contact | null) {
  const fullName = contact?.name?.trim() || 'cliente';
  const firstName = fullName.split(/\s+/)[0] || 'cliente';
  const phone = contact?.phone || '—';
  const email = contact?.email || '—';
  const values: Record<string, string> = {
    nombre: firstName,
    name: firstName,
    nombre_completo: fullName,
    'nombre completo': fullName,
    telefono: phone,
    'teléfono': phone,
    phone,
    email
  };

  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/gi, (match, key: string) => values[key.trim().toLowerCase()] ?? match);
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
  return <CreateCampaignWizardModal onClose={onClose} onCreated={onCreated} />;
}

function CreateCampaignWizardModal({ onClose, onCreated }: { onClose: () => void; onCreated: (campaign: Campaign) => void }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [sessions, setSessions] = useState<WhatsAppSession[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [contactSearch, setContactSearch] = useState('');
  const [onlyNamed, setOnlyNamed] = useState(false);
  const [audienceTab, setAudienceTab] = useState<'contacts' | 'groups'>('contacts');
  const [groups, setGroups] = useState<WaGroup[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [groupSearch, setGroupSearch] = useState('');
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const messageRef = useRef<HTMLTextAreaElement | null>(null);
  const [previewContactId, setPreviewContactId] = useState('');
  const [speedProfile, setSpeedProfile] = useState<CampaignSpeedProfile>('BALANCED');
  const [campaignType, setCampaignType] = useState<'DIRECT' | 'SCHEDULED'>('DIRECT');
  const [scheduledAt, setScheduledAt] = useState('');
  const [sendLine, setSendLine] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [loadingAudience, setLoadingAudience] = useState(true);
  const [refreshingSessions, setRefreshingSessions] = useState(false);
  const [syncingContacts, setSyncingContacts] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiGet<{ contacts: Contact[] }>('/api/org/campaigns/audience'),
      apiGet<{ sessions: WhatsAppSession[] }>('/api/org/whatsapp/sessions')
    ]).then(([contactData, sessionData]) => {
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

  async function loadGroups(force = false) {
    setLoadingGroups(true);
    setGroupsError(null);
    try {
      const data = await apiGet<{ groups: WaGroup[] }>(`/api/org/campaigns/groups${force ? '?refresh=1' : ''}`);
      setGroups(data.groups);
      setGroupsLoaded(true);
    } catch (err) {
      setGroupsError(err instanceof ApiError ? err.message : 'No se pudieron cargar los grupos');
    } finally {
      setLoadingGroups(false);
    }
  }

  useEffect(() => {
    if (audienceTab === 'groups' && !groupsLoaded && !loadingGroups) loadGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audienceTab]);

  const visibleGroups = useMemo(() => {
    const query = groupSearch.trim().toLowerCase();
    return groups.filter((group) => !query || group.name.toLowerCase().includes(query));
  }, [groups, groupSearch]);

  function toggleGroup(id: string) {
    setSelectedGroups((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]);
  }

  function toggleVisibleGroups() {
    const ids = visibleGroups.map((group) => group.id);
    const allSelected = ids.length > 0 && ids.every((id) => selectedGroups.includes(id));
    setSelectedGroups((prev) => allSelected ? prev.filter((id) => !ids.includes(id)) : Array.from(new Set([...prev, ...ids])));
  }

  async function syncPhoneContacts() {
    setSyncingContacts(true);
    setError(null);
    setSyncMessage(null);
    try {
      const result = await apiPost<{ imported: number; updated: number; total: number }>('/api/org/whatsapp/sync-contacts', {});
      const data = await apiGet<{ contacts: Contact[] }>('/api/org/campaigns/audience');
      setContacts(data.contacts);
      setSyncMessage(`${result.imported} contactos importados · ${result.updated} actualizados`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron sincronizar los contactos del teléfono');
    } finally {
      setSyncingContacts(false);
    }
  }

  const crmTagList = useMemo(() => {
    const counts = new Map<string, number>();
    contacts.forEach((contact) => (contact.crmTags || []).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
    return Array.from(counts, ([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
  }, [contacts]);
  const contactTagList = useMemo(() => {
    const counts = new Map<string, number>();
    contacts.forEach((contact) => contact.tags.forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
    return Array.from(counts, ([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
  }, [contacts]);
  const namedCount = useMemo(() => contacts.filter((contact) => contact.name?.trim()).length, [contacts]);
  const visibleContacts = useMemo(() => {
    const query = contactSearch.trim().toLowerCase();
    return contacts
      .filter((contact) => (!onlyNamed || contact.name?.trim()) && (!query || `${contact.name || ''} ${contact.phone || ''} ${contact.tags.join(' ')} ${(contact.crmTags || []).join(' ')}`.toLowerCase().includes(query)))
      .sort((a, b) => Number(Boolean(b.name?.trim())) - Number(Boolean(a.name?.trim())) || (a.name || '').localeCompare(b.name || ''))
      .slice(0, 300);
  }, [contacts, contactSearch, onlyNamed]);
  const audience = useMemo(() => contacts.filter((contact) => contact.phone && (selectedContactIds.includes(contact.id) || contactHasSelectedTag(contact, selectedTags))), [contacts, selectedContactIds, selectedTags]);
  const previewContacts = useMemo(() => audience.length > 0 ? audience : contacts.filter((contact) => contact.phone).slice(0, 100), [audience, contacts]);
  const selectedSpeed = SPEED_OPTIONS.find((option) => option.key === speedProfile) || SPEED_OPTIONS[1];
  const previewContact = previewContacts.find((contact) => contact.id === previewContactId) || previewContacts[0] || null;
  const currentStep = CAMPAIGN_WIZARD_STEPS[step - 1];
  const selectedSession = sessions.find((session) => session.id === sendLine);
  const scheduleMinimum = useMemo(() => {
    const minimum = new Date(Date.now() + 60_000);
    const offset = minimum.getTimezoneOffset();
    return new Date(minimum.getTime() - offset * 60_000).toISOString().slice(0, 16);
  }, []);

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

  function insertAtCursor(text: string) {
    const input = messageRef.current;
    if (!input) {
      setMessage((current) => `${current}${text}`);
      return;
    }
    const start = input.selectionStart ?? message.length;
    const end = input.selectionEnd ?? message.length;
    setMessage(`${message.slice(0, start)}${text}${message.slice(end)}`);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + text.length, start + text.length);
    });
  }

  function insertVariable(token: string) {
    insertAtCursor(token);
  }

  function validateStep(targetStep: number) {
    if (targetStep === 1) {
      if (!name.trim()) {
        setError('Escribí un nombre para identificar la campaña.');
        return false;
      }
      if (sessions.length > 0 && !sendLine) {
        setError('Seleccioná la línea de WhatsApp que va a enviar la campaña.');
        return false;
      }
    }
    if (targetStep === 2 && !message.trim()) {
      setError('Escribí el mensaje que recibirán tus contactos.');
      return false;
    }
    if (targetStep === 4 && audience.length === 0 && selectedGroups.length === 0) {
      setError('Seleccioná al menos una etiqueta, un contacto con teléfono o un grupo.');
      return false;
    }
    if (targetStep === 5 && campaignType === 'SCHEDULED') {
      const timestamp = scheduledAt ? new Date(scheduledAt).getTime() : NaN;
      if (!scheduledAt || Number.isNaN(timestamp) || timestamp <= Date.now()) {
        setError('Elegí una fecha y hora futura para programar el envío.');
        return false;
      }
    }
    if (targetStep === 7 && !reviewConfirmed) {
      setError('Confirmá que revisaste el resumen antes de crear la campaña.');
      return false;
    }
    return true;
  }

  function goNext() {
    setError(null);
    if (!validateStep(step)) return;
    setStep((current) => Math.min(CAMPAIGN_WIZARD_STEPS.length, current + 1));
  }

  function goBack() {
    setError(null);
    setStep((current) => Math.max(1, current - 1));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (step < CAMPAIGN_WIZARD_STEPS.length) {
      goNext();
      return;
    }
    const requiredSteps = [1, 2, 4, 5, 7];
    const invalidStep = requiredSteps.find((targetStep) => !validateStep(targetStep));
    if (invalidStep) {
      setStep(invalidStep);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await apiPost<{ campaign: Campaign }>('/api/org/campaigns', {
        name: name.trim(),
        message: message.trim(),
        tagFilter: selectedTags,
        contactIds: selectedContactIds,
        groupJids: selectedGroups,
        sendLine: sendLine || undefined,
        campaignType,
        speedProfile,
        messagesPerHour: selectedSpeed.rate,
        scheduledAt: campaignType === 'SCHEDULED' ? new Date(scheduledAt).toISOString() : undefined
      });
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
      <form onSubmit={handleSubmit} className="campaign-wizard">
        <div className="campaign-wizard-intro">
          <span className="campaign-wizard-intro-icon">✦</span>
          <div><strong>Diseñá un envío controlado</strong><p>Completá cada etapa y revisá la campaña antes de dejarla lista para ejecutar.</p></div>
          <span className="campaign-wizard-draft-badge">Se guarda como pendiente</span>
        </div>

        <nav className="campaign-wizard-progress" aria-label="Pasos de creación de campaña">
          {CAMPAIGN_WIZARD_STEPS.map((wizardStep) => {
            const completed = wizardStep.number < step;
            const active = wizardStep.number === step;
            return <div key={wizardStep.number} className={`campaign-wizard-step ${active ? 'active' : ''} ${completed ? 'completed' : ''}`}><span>{completed ? '✓' : wizardStep.number}</span><small>{wizardStep.shortLabel}</small></div>;
          })}
        </nav>

        <div className="campaign-wizard-heading"><span>PASO {step} DE {CAMPAIGN_WIZARD_STEPS.length}</span><h2>{currentStep.label}</h2><p>{currentStep.description}</p></div>

        {step === 1 && <section className="campaign-wizard-panel"><div className="campaign-wizard-panel-heading"><span className="campaign-wizard-panel-icon">01</span><div><h3>Identificá tu campaña</h3><p>Este nombre se mostrará en el historial y en los reportes.</p></div></div><div className="campaign-form-grid"><div className="field"><label htmlFor="campaign-name">Nombre de la campaña</label><input id="campaign-name" className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Promo fin de mes" autoFocus /></div><div className="field"><label htmlFor="campaign-line">Línea de envío</label><select id="campaign-line" className="input" value={sendLine} onChange={(event) => setSendLine(event.target.value)}><option value="">Usar sesión disponible</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.label} · {session.status === 'connected' ? 'Conectada' : session.status}</option>)}</select><div className="campaign-session-tools"><button type="button" className="campaign-inline-button" onClick={refreshSessions} disabled={refreshingSessions}>{refreshingSessions ? 'Actualizando…' : '↻ Actualizar sesiones'}</button>{sessions.length > 0 && <span>{sessions.filter((session) => session.status === 'connected').length} activas</span>}</div>{sessions.length === 0 && <small className="campaign-field-hint warning">No hay una sesión conectada. Podés guardar la campaña y conectar la línea antes de iniciarla.</small>}</div></div><div className="campaign-wizard-info-card"><span>✓</span><div><strong>{selectedSession ? selectedSession.label : sessions.length > 0 ? 'Elegí una línea para continuar' : 'Campaña preparada para conectar después'}</strong><small>{sessions.length > 0 ? 'La campaña usará esta sesión al momento de iniciar el envío.' : 'La campaña quedará pendiente hasta que haya una sesión de WhatsApp disponible.'}</small></div></div></section>}

        {step === 2 && <section className="campaign-wizard-panel"><div className="campaign-wizard-panel-heading"><span className="campaign-wizard-panel-icon">02</span><div><h3>Construí el contenido</h3><p>Podés usar emojis y un archivo multimedia por campaña.</p></div></div><div className="field"><label htmlFor="campaign-message">Mensaje para tus contactos</label><textarea id="campaign-message" ref={messageRef} className="input campaign-message-input" rows={8} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Escribí el mensaje que va a recibir cada cliente…" autoFocus /><div className="campaign-emoji-toolbar"><div className="campaign-emoji-anchor"><button type="button" className="campaign-emoji-toggle" onClick={() => setShowEmoji((value) => !value)} aria-expanded={showEmoji}>😊 Emojis</button>{showEmoji && <EmojiPicker onPick={(emoji) => insertAtCursor(emoji)} onClose={() => setShowEmoji(false)} />}</div><span className="campaign-emoji-quick">{['👋', '✨', '🎉', '📣', '✅', '💬'].map((emoji) => <button type="button" key={emoji} onClick={() => insertAtCursor(emoji)}>{emoji}</button>)}</span><span className="campaign-char-count">{message.length} / 4000</span></div></div><div className="campaign-wizard-attachment"><div><strong>Adjuntar contenido (opcional)</strong><small>Imágenes, videos, audio, PDF, documentos de Office o texto.</small></div><input id="campaign-file" type="file" className="campaign-file-input" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" onChange={(event) => setFile(event.target.files?.[0] || null)} />{file && <div className="campaign-selected-file"><span>◫</span><div><b>{file.name}</b><small>{file.type || 'Archivo'} · {(file.size / 1024 / 1024).toFixed(2)} MB</small></div><button type="button" onClick={() => setFile(null)} aria-label="Quitar archivo">×</button></div>}</div></section>}

        {step === 3 && <section className="campaign-wizard-panel"><div className="campaign-wizard-panel-heading"><span className="campaign-wizard-panel-icon">03</span><div><h3>Personalizá cada mensaje</h3><p>Insertá variables y comprobá cómo lo verá una persona real.</p></div></div><div className="campaign-personalization campaign-personalization-large"><div className="campaign-personalization-heading"><div><strong>Variables disponibles</strong><small>Al enviar, cada variable se reemplaza con los datos guardados en el CRM.</small></div>{previewContacts.length > 0 && <label className="campaign-preview-selector">Vista previa<select value={previewContact?.id || ''} onChange={(event) => setPreviewContactId(event.target.value)}><option value="">Primer contacto disponible</option>{previewContacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name || contact.phone || 'Sin nombre'}</option>)}</select></label>}</div><div className="campaign-variable-row">{CAMPAIGN_VARIABLES.map((variable) => <button type="button" key={variable.token} className="campaign-variable-chip" onClick={() => insertVariable(variable.token)} title={variable.description}>{variable.label} <code>{variable.token}</code></button>)}</div><div className="campaign-preview-bubble"><span>Vista previa para {previewContact?.name || previewContact?.phone || 'tu contacto'}</span><p>{personalizeCampaignMessage(message || 'Hola {{nombre}}, tenemos una novedad para vos.', previewContact)}</p></div></div><div className="campaign-wizard-tip"><span>💡</span><p>Ejemplo: <b>Hola {'{{nombre}}'}, tenemos una novedad para vos.</b> se transforma automáticamente en “Hola María, tenemos una novedad para vos.”</p></div></section>}

        {step === 4 && <section className="campaign-wizard-panel"><div className="campaign-wizard-panel-heading"><span className="campaign-wizard-panel-icon">04</span><div><h3>Elegí la audiencia</h3><p>Combiná etiquetas del CRM, etiquetas de contactos y contactos puntuales. Los destinatarios no se repiten.</p></div><span className="campaign-audience-count">{audience.length} contactos{selectedGroups.length > 0 ? ` · ${selectedGroups.length} grupos` : ''}</span></div>
          <div className="campaign-audience-tabs" role="tablist"><button type="button" role="tab" aria-selected={audienceTab === 'contacts'} className={audienceTab === 'contacts' ? 'active' : ''} onClick={() => setAudienceTab('contacts')}>👥 CRM y contactos{audience.length > 0 ? ` (${audience.length})` : ''}</button><button type="button" role="tab" aria-selected={audienceTab === 'groups'} className={audienceTab === 'groups' ? 'active' : ''} onClick={() => setAudienceTab('groups')}>💬 Grupos de WhatsApp{selectedGroups.length > 0 ? ` (${selectedGroups.length})` : ''}</button></div>
          {audienceTab === 'contacts' ? <><input className="input campaign-audience-search" value={contactSearch} onChange={(event) => setContactSearch(event.target.value)} placeholder="🔎 Buscar por nombre, teléfono o etiqueta…" autoFocus />
          <div className="campaign-audience-tools"><button type="button" className="btn secondary small" onClick={toggleVisibleContacts} disabled={visibleContacts.length === 0}>{visibleContacts.length > 0 && visibleContacts.filter((contact) => contact.phone).every((contact) => selectedContactIds.includes(contact.id)) ? 'Quitar visibles' : `Seleccionar visibles (${visibleContacts.length})`}</button><label className="campaign-only-named"><input type="checkbox" checked={onlyNamed} onChange={(event) => setOnlyNamed(event.target.checked)} /> Solo con nombre ({namedCount})</label><button type="button" className="btn secondary small campaign-sync-button" onClick={syncPhoneContacts} disabled={syncingContacts}>{syncingContacts ? 'Sincronizando…' : '↻ Sincronizar teléfono'}</button></div>
          {syncMessage && <div className="campaign-sync-success">✓ {syncMessage}</div>}
          <div className="campaign-tag-group"><span className="campaign-tag-group-label">Etiquetas CRM</span><div className="campaign-tags">{crmTagList.map(({ tag, count }) => <button type="button" key={`crm-${tag}`} className={`campaign-tag crm ${selectedTags.includes(tag) ? 'active' : ''}`} onClick={() => toggleTag(tag)}>◈ {tag} <em>{count}</em></button>)}{crmTagList.length === 0 && !loadingAudience && <span className="campaign-field-hint">Todavía no hay conversaciones con etiquetas en el CRM.</span>}</div></div>
          {contactTagList.length > 0 && <div className="campaign-tag-group"><span className="campaign-tag-group-label">Etiquetas de contactos</span><div className="campaign-tags">{contactTagList.map(({ tag, count }) => <button type="button" key={`contact-${tag}`} className={`campaign-tag ${selectedTags.includes(tag) ? 'active' : ''}`} onClick={() => toggleTag(tag)}># {tag} <em>{count}</em></button>)}</div></div>}
          <div className="campaign-contact-picker">{loadingAudience ? <div className="campaign-picker-loading">Cargando contactos…</div> : visibleContacts.length === 0 ? <div className="campaign-picker-loading">No encontramos contactos con esa búsqueda.</div> : visibleContacts.map((contact) => { const selectedContact = selectedContactIds.includes(contact.id) || contactHasSelectedTag(contact, selectedTags); const labels = [...(contact.crmTags || []), ...contact.tags].slice(0, 3); return <button type="button" key={contact.id} className={`campaign-contact-row ${selectedContact ? 'selected' : ''}`} onClick={() => toggleContact(contact.id)} disabled={!contact.phone}><span className="campaign-check">{selectedContact ? '✓' : ''}</span><span className="campaign-avatar">{initials(contact)}</span><span className="campaign-contact-name"><b>{contact.name?.trim() || formatPhone(contact.phone)}</b><small>{contact.name?.trim() ? formatPhone(contact.phone) : 'Sin nombre guardado'}{labels.length ? ` · ${labels.join(', ')}` : ''}</small></span></button>; })}</div></> : <>
          <input className="input campaign-audience-search" value={groupSearch} onChange={(event) => setGroupSearch(event.target.value)} placeholder="🔎 Buscar grupo por nombre…" autoFocus />
          <div className="campaign-audience-tools"><button type="button" className="btn secondary small" onClick={toggleVisibleGroups} disabled={visibleGroups.length === 0}>{visibleGroups.length > 0 && visibleGroups.every((group) => selectedGroups.includes(group.id)) ? 'Quitar visibles' : `Seleccionar visibles (${visibleGroups.length})`}</button><span className="campaign-only-named">{groups.length} grupos en tu WhatsApp</span><button type="button" className="btn secondary small campaign-sync-button" onClick={() => loadGroups(true)} disabled={loadingGroups}>{loadingGroups ? 'Actualizando…' : '↻ Actualizar grupos'}</button></div>
          {groupsError && <div className="campaign-alert error" style={{ marginBottom: 10 }}>{groupsError}</div>}
          <div className="campaign-contact-picker">{loadingGroups && groups.length === 0 ? <div className="campaign-picker-loading">Cargando grupos…</div> : visibleGroups.length === 0 ? <div className="campaign-picker-loading">{groups.length === 0 ? 'No encontramos grupos en esta cuenta de WhatsApp.' : 'No hay grupos con esa búsqueda.'}</div> : visibleGroups.map((group) => { const picked = selectedGroups.includes(group.id); return <button type="button" key={group.id} className={`campaign-contact-row ${picked ? 'selected' : ''}`} onClick={() => toggleGroup(group.id)}><span className="campaign-check">{picked ? '✓' : ''}</span><span className="campaign-avatar">👥</span><span className="campaign-contact-name"><b>{group.name}</b><small>{group.size} participantes{group.announce && !group.canSend ? ' · solo admins pueden escribir' : ''}</small></span></button>; })}</div>
          <div className="campaign-wizard-tip"><span>💡</span><p>Los mensajes a grupos se envían con la misma velocidad elegida. Usá el ritmo <b>Conservador</b> si tenés muchos grupos, para cuidar tu número.</p></div>
        </>}
        </section>}

        {step === 5 && <section className="campaign-wizard-panel"><div className="campaign-wizard-panel-heading"><span className="campaign-wizard-panel-icon">05</span><div><h3>Definí cuándo enviar</h3><p>La campaña se crea sin comenzar. Solo se ejecutará desde su acción de inicio.</p></div></div><div className="campaign-campaign-type-grid"><button type="button" className={`campaign-campaign-type ${campaignType === 'DIRECT' ? 'selected' : ''}`} onClick={() => setCampaignType('DIRECT')}><span>▶</span><div><strong>Directa</strong><small>Queda pendiente y se envía cuando hagas clic en “Iniciar”.</small></div></button><button type="button" className={`campaign-campaign-type ${campaignType === 'SCHEDULED' ? 'selected' : ''}`} onClick={() => setCampaignType('SCHEDULED')}><span>◷</span><div><strong>Programada</strong><small>Queda agendada y comienza automáticamente en la fecha elegida.</small></div></button></div>{campaignType === 'SCHEDULED' && <div className="field campaign-schedule-field"><label htmlFor="campaign-schedule">Fecha y hora de inicio</label><input id="campaign-schedule" type="datetime-local" min={scheduleMinimum} className="input" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} /><small className="campaign-field-hint">Usá la zona horaria configurada en tu navegador.</small></div>}<div className="campaign-safety-note"><span>🛡️</span><p><b>Envío responsable.</b> Usá contactos con consentimiento, mantené una opción de baja y evitá mensajes repetitivos o listas compradas.</p></div></section>}

        {step === 6 && <section className="campaign-wizard-panel"><div className="campaign-wizard-panel-heading"><span className="campaign-wizard-panel-icon">06</span><div><h3>Elegí la velocidad</h3><p>Distribuí los mensajes por hora según el tamaño y el nivel de control que necesitás.</p></div><span className="campaign-rate-summary">{selectedSpeed.rate} mensajes/hora</span></div><div className="campaign-speed-grid">{SPEED_OPTIONS.map((option) => <button type="button" key={option.key} className={`campaign-speed-option ${speedProfile === option.key ? 'selected' : ''}`} onClick={() => setSpeedProfile(option.key)}><span className="campaign-radio">{speedProfile === option.key ? '●' : ''}</span><span className="campaign-speed-icon">{option.icon}</span><span className="campaign-speed-copy"><b>{option.label}</b>{option.recommended && <em>Recomendado</em>}<small>Hasta {option.rate} mensajes por hora · {option.description}.</small></span></button>)}</div><div className="campaign-wizard-tip"><span>🛡️</span><p>La velocidad elegida ayuda a distribuir el tráfico. Siempre respetá el consentimiento de tus contactos y las políticas de WhatsApp.</p></div></section>}

        {step === 7 && <section className="campaign-wizard-panel campaign-review-panel"><div className="campaign-wizard-panel-heading"><span className="campaign-wizard-panel-icon">✓</span><div><h3>Revisá antes de crear</h3><p>La campaña quedará guardada, pero no se enviará desde este botón.</p></div></div><div className="campaign-review-status"><span>◷</span><div><strong>{campaignType === 'SCHEDULED' ? 'Quedará programada' : 'Quedará pendiente'}</strong><small>{campaignType === 'SCHEDULED' ? `Inicio: ${formatDate(new Date(scheduledAt).toISOString())}` : 'Podrás ejecutarla desde “Iniciar envío” cuando estés listo.'}</small></div></div><div className="campaign-review-grid"><div><span>CAMPAÑA</span><strong>{name || 'Sin nombre'}</strong></div><div><span>LÍNEA</span><strong>{selectedSession?.label || 'Sesión disponible'}</strong></div><div><span>AUDIENCIA</span><strong>{audience.length} contactos{selectedGroups.length > 0 ? ` + ${selectedGroups.length} grupos` : ''}</strong><small>{selectedTags.length > 0 ? selectedTags.map((tag) => `#${tag}`).join(' · ') : selectedGroups.length > 0 && audience.length === 0 ? 'Solo grupos' : 'Selección manual'}</small></div><div><span>VELOCIDAD</span><strong>{selectedSpeed.icon} {selectedSpeed.label}</strong><small>Hasta {selectedSpeed.rate} mensajes/hora</small></div><div><span>CONTENIDO</span><strong>{file ? 'Texto + adjunto' : 'Solo texto'}</strong><small>{file?.name || 'Sin archivo adjunto'}</small></div></div><div className="campaign-review-message"><span>VISTA PREVIA DEL MENSAJE</span><p>{personalizeCampaignMessage(message, previewContact)}</p></div><label className="campaign-review-confirm"><input type="checkbox" checked={reviewConfirmed} onChange={(event) => setReviewConfirmed(event.target.checked)} /> <span>Revisé el mensaje, los destinatarios, la programación y la velocidad. Quiero crear esta campaña.</span></label></section>}

        {error && <div className="campaign-alert error campaign-wizard-error">{error}</div>}
        <div className="campaign-wizard-footer"><button type="button" className="btn secondary" onClick={onClose}>Cancelar</button><div className="campaign-wizard-actions">{step > 1 && <button type="button" className="btn secondary" onClick={goBack} disabled={submitting}>← Atrás</button>}{step < CAMPAIGN_WIZARD_STEPS.length ? <button type="button" className="btn" onClick={goNext} disabled={submitting || (step === 4 && loadingAudience)}>Siguiente <span>→</span></button> : <button type="submit" className="btn" disabled={submitting || loadingAudience}>{submitting ? 'Creando…' : campaignType === 'SCHEDULED' ? 'Crear campaña programada' : 'Crear campaña pendiente'}</button>}</div></div>
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
        <section className="campaign-history-section"><div className="campaign-section-heading"><div><h3>Historial de destinatarios</h3><p>Cada contacto conserva su estado y marca de tiempo.</p></div><select className="input campaign-history-filter" value={recipientFilter} onChange={(event) => setRecipientFilter(event.target.value as typeof recipientFilter)}><option value="ALL">Todos ({recipients.length})</option><option value="PENDING">Pendientes ({counts.pending})</option><option value="SENT">Enviados ({counts.sent})</option><option value="DELIVERED">Entregados ({counts.delivered})</option><option value="READ">Vistos ({counts.read})</option><option value="FAILED">Fallidos ({counts.failed})</option></select></div>{loading ? <div className="campaign-picker-loading">Cargando historial…</div> : <div className="campaign-recipient-table">{filteredRecipients.map((recipient) => <div className="campaign-recipient-row" key={recipient.id}><span className="campaign-avatar">{initials(recipient.contact)}</span><span className="campaign-recipient-person"><b>{recipient.contact.name || 'Sin nombre'}</b><small>{recipient.contact.isGroup ? 'Grupo de WhatsApp' : recipient.contact.phone || 'Sin teléfono'}</small></span><span className={`campaign-recipient-status ${recipient.status.toLowerCase()}`}>{recipient.status === 'PENDING' ? 'Pendiente' : recipient.status === 'SENT' ? 'Enviado' : recipient.status === 'DELIVERED' ? 'Entregado' : recipient.status === 'READ' ? 'Visto' : 'Fallido'}</span><span className="campaign-recipient-time">{formatDate(recipient.readAt || recipient.deliveredAt || recipient.sentAt)}{recipient.errorMessage && <small title={recipient.errorMessage}> · Error</small>}</span></div>)}{filteredRecipients.length === 0 && <div className="campaign-picker-loading">No hay destinatarios en este estado.</div>}</div>}</section>
      </div><aside className="campaign-detail-aside"><div className="campaign-aside-card"><span className="campaign-aside-label">AUDIENCIA</span><strong>{counts.total} contactos</strong><p>{current.tagFilter.length ? current.tagFilter.map((tag) => `#${tag}`).join(' · ') : 'Selección manual'}</p><div className="campaign-aside-divider" /><span className="campaign-aside-label">LÍNEA DE ENVÍO</span><strong>{current.sendLine || 'Sesión disponible'}</strong><div className="campaign-aside-divider" /><span className="campaign-aside-label">PROGRAMACIÓN</span><strong>{current.scheduledAt ? formatDate(current.scheduledAt) : 'Al iniciar manualmente'}</strong></div><div className="campaign-aside-actions">{['DRAFT', 'SCHEDULED', 'PAUSED'].includes(current.status) && <button type="button" className="btn" onClick={() => onAction(current, 'start')}>▶ Iniciar envío</button>}{current.status === 'SENDING' && <button type="button" className="btn secondary" onClick={() => onAction(current, 'pause')}>Ⅱ Pausar campaña</button>}{counts.failed > 0 && ['COMPLETED', 'PAUSED'].includes(current.status) && <button type="button" className="btn secondary" onClick={() => onAction(current, 'retry-failed')}>↻ Reintentar fallidos</button>}{['COMPLETED', 'CANCELLED'].includes(current.status) && <button type="button" className="btn secondary" onClick={() => onAction(current, 'resend')}>↗ Reenviar campaña</button>}{['DRAFT', 'SCHEDULED', 'SENDING', 'PAUSED'].includes(current.status) && <button type="button" className="campaign-danger-link" onClick={() => onAction(current, 'cancel')}>Cancelar campaña</button>}</div></aside></div>
    </Modal>
  );
}

function DetailKpi({ label, value, tone = '' }: { label: string; value: number; tone?: string }) {
  return <div className={`campaign-detail-kpi ${tone}`}><span>{label}</span><strong>{value.toLocaleString('es')}</strong></div>;
}
