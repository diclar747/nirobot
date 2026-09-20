import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { apiDelete, apiGet, apiPost, apiUpload, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { useAlerts } from '../context/AlertContext';
import { EmptyState, PageHeader, PageShell, Panel, Pill, StatCard, StatGrid, type Tone } from '../components/PageKit';
import { StatusCampaigns } from '../components/StatusCampaigns';
import type { Contact } from '../types';
import '../styles/status-posts.css';

type PostStatus = 'draft' | 'scheduled' | 'processing' | 'published' | 'failed' | 'cancelled' | 'deleted' | 'expired';

type StatusPost = {
  id: string;
  contentType: 'text' | 'image' | 'video';
  textContent: string | null;
  caption: string | null;
  mediaUrl: string | null;
  backgroundColor: string | null;
  audienceType: 'ALL' | 'TAG' | 'CUSTOM';
  audienceTags: string[];
  audienceCount: number;
  publicationMode: 'NOW' | 'SCHEDULED';
  scheduledAt: string | null;
  publishedAt: string | null;
  expiresAt: string | null;
  status: PostStatus;
  errorMessage: string | null;
  retryCount: number;
  createdAt: string;
};

type Metrics = {
  metrics: { publishedToday: number; scheduled: number; failed: number; nextScheduledAt: string | null };
  connected: boolean;
  maxAudience: number;
};

const STATUS_LABEL: Record<PostStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Borrador', tone: 'neutral' },
  scheduled: { label: 'Programado', tone: 'primary' },
  processing: { label: 'Publicando…', tone: 'warning' },
  published: { label: 'Publicado', tone: 'success' },
  failed: { label: 'Con error', tone: 'danger' },
  cancelled: { label: 'Cancelado', tone: 'neutral' },
  deleted: { label: 'Eliminado', tone: 'neutral' },
  expired: { label: 'Vencido', tone: 'neutral' }
};

const MAX_VIDEO_SECONDS = 60;
const MAX_VIDEO_MB = 100;

// Reads the duration in the browser so a too-long clip is flagged before uploading tens of MB.
function readVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = (value: number | null) => { URL.revokeObjectURL(url); resolve(value); };
    video.preload = 'metadata';
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => done(null);
    video.src = url;
  });
}

const COLORS = ['#075E54', '#128C7E', '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#0f172a'];

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-PY', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function StatusPosts() {
  const { notify, confirm } = useAlerts();
  const [posts, setPosts] = useState<StatusPost[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'posts' | 'campaigns'>('posts');

  const [contentType, setContentType] = useState<'text' | 'image' | 'video'>('text');
  const [text, setText] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [videoSeconds, setVideoSeconds] = useState<number | null>(null);
  const [audienceType, setAudienceType] = useState<'ALL' | 'TAG' | 'CUSTOM'>('ALL');
  const [tags, setTags] = useState<string[]>([]);
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [contactQuery, setContactQuery] = useState('');
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [mode, setMode] = useState<'NOW' | 'SCHEDULED' | 'DRAFT'>('NOW');
  const [scheduledAt, setScheduledAt] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60 * 1000)));

  const load = useCallback(() => {
    Promise.all([
      apiGet<{ posts: StatusPost[] }>('/api/org/status-posts'),
      apiGet<Metrics>('/api/org/status-posts/metrics')
    ])
      .then(([list, summary]) => { setPosts(list.posts); setMetrics(summary); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    apiGet<{ contacts: Contact[] }>('/api/org/contacts?limit=500').then((data) => setContacts(data.contacts)).catch(() => {});
    const socket = getSocket();
    const onUpdate = ({ post }: { post: StatusPost }) => {
      setPosts((current) => (current.some((p) => p.id === post.id) ? current.map((p) => (p.id === post.id ? post : p)) : [post, ...current]));
      apiGet<Metrics>('/api/org/status-posts/metrics').then(setMetrics).catch(() => {});
    };
    socket.on('status-post:updated', onUpdate);
    return () => { socket.off('status-post:updated', onUpdate); };
  }, [load]);

  useEffect(() => {
    setVideoSeconds(null);
    if (file && contentType === 'video') readVideoDuration(file).then(setVideoSeconds);
  }, [file, contentType]);

  useEffect(() => {
    if (!file) { setFilePreview(null); return; }
    const url = URL.createObjectURL(file);
    setFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const allTags = useMemo(() => [...new Set(contacts.flatMap((c) => c.tags || []))].sort(), [contacts]);
  const pickable = useMemo(() => {
    const query = contactQuery.trim().toLowerCase();
    return contacts.filter((c) => c.phone && (!query || `${c.name || ''} ${c.phone}`.toLowerCase().includes(query))).slice(0, 60);
  }, [contacts, contactQuery]);

  // Live audience size, so nobody publishes to an empty or oversized list by surprise.
  useEffect(() => {
    const params = new URLSearchParams({ audienceType, audienceTags: tags.join(','), audienceContactIds: contactIds.join(',') });
    const timer = window.setTimeout(() => {
      apiGet<{ count: number }>(`/api/org/status-posts/audience-preview?${params}`).then((r) => setAudienceCount(r.count)).catch(() => setAudienceCount(null));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [audienceType, tags, contactIds]);

  const tooLarge = metrics && audienceCount !== null && audienceCount > metrics.maxAudience;
  const videoTooLong = contentType === 'video' && videoSeconds !== null && videoSeconds > MAX_VIDEO_SECONDS + 0.5;
  const videoTooBig = contentType === 'video' && Boolean(file) && (file as File).size > MAX_VIDEO_MB * 1024 * 1024;
  const canSubmit = !busy && audienceCount !== 0 && !tooLarge && !videoTooLong && !videoTooBig && (contentType === 'text' ? text.trim().length > 0 : Boolean(file));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      const fields: Record<string, string> = {
        contentType, audienceType, mode,
        audienceTags: JSON.stringify(tags), audienceContactIds: JSON.stringify(contactIds)
      };
      if (contentType === 'text') { fields.textContent = text.trim(); fields.backgroundColor = color; }
      else if (caption.trim()) fields.caption = caption.trim();
      if (mode === 'SCHEDULED') fields.scheduledAt = new Date(scheduledAt).toISOString();
      const form = new FormData();
      Object.entries(fields).forEach(([key, value]) => form.append(key, value));
      if (contentType !== 'text' && file) form.append('file', file);
      await apiUpload('/api/org/status-posts', form);
      notify(mode === 'NOW' ? 'Publicando tu estado…' : mode === 'SCHEDULED' ? 'Estado programado.' : 'Borrador guardado.', { tone: 'success', title: 'Listo' });
      setText(''); setCaption(''); setFile(null); setVideoSeconds(null);
      load();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'No se pudo crear el estado.', { tone: 'error', title: 'Error' });
    } finally {
      setBusy(false);
    }
  }

  async function act(post: StatusPost, action: 'publish' | 'duplicate' | 'cancel' | 'delete') {
    try {
      if (action === 'delete') {
        const message = post.status === 'published'
          ? 'Se intentará retirar el estado de WhatsApp. ¿Continuar?'
          : '¿Eliminar esta publicación?';
        if (!(await confirm({ title: 'Eliminar estado', message, confirmLabel: 'Eliminar', tone: 'danger' }))) return;
        await apiDelete(`/api/org/status-posts/${post.id}`);
      } else {
        await apiPost(`/api/org/status-posts/${post.id}/${action}`, {});
      }
      load();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'No se pudo completar la acción.', { tone: 'error', title: 'Error' });
    }
  }

  const previewBg = contentType === 'text' ? color : '#0b1220';

  return (
    <PageShell>
      <PageHeader
        icon="✦"
        title="Estados de WhatsApp"
        subtitle="Publicá historias de 24 horas desde Nirobot: ahora, programadas o en campañas que cambian solas cada N horas."
        actions={<Pill tone={metrics?.connected ? 'success' : 'danger'} dot>{metrics?.connected ? 'WhatsApp conectado' : 'WhatsApp desconectado'}</Pill>}
      />

      <div className="sp-seg sp-tabs" role="tablist">
        <button type="button" className={view === 'posts' ? 'on' : ''} onClick={() => setView('posts')}>Publicaciones</button>
        <button type="button" className={view === 'campaigns' ? 'on' : ''} onClick={() => setView('campaigns')}>Campañas automáticas</button>
      </div>

      {view === 'campaigns' && <StatusCampaigns contacts={contacts} />}

      {view === 'posts' && <>
      <StatGrid>
        <StatCard label="Publicados hoy" value={metrics?.metrics.publishedToday ?? '—'} tone="success" />
        <StatCard label="Programados" value={metrics?.metrics.scheduled ?? '—'} hint={metrics?.metrics.nextScheduledAt ? `Próximo: ${formatDateTime(metrics.metrics.nextScheduledAt)}` : undefined} tone="primary" />
        <StatCard label="Con error" value={metrics?.metrics.failed ?? '—'} tone="danger" />
      </StatGrid>

      <Panel title="Crear estado">
        <form className="sp-composer" onSubmit={submit}>
          <div className="sp-form">
            <div className="sp-seg" role="tablist">
              <button type="button" className={contentType === 'text' ? 'on' : ''} onClick={() => { setContentType('text'); setFile(null); }}>Aa Texto</button>
              <button type="button" className={contentType === 'image' ? 'on' : ''} onClick={() => { setContentType('image'); setFile(null); }}>🖼 Imagen</button>
              <button type="button" className={contentType === 'video' ? 'on' : ''} onClick={() => { setContentType('video'); setFile(null); }}>🎬 Video</button>
            </div>

            {contentType === 'text' ? (
              <>
                <label className="field">
                  <span>Texto ({text.length}/700)</span>
                  <textarea className="input" rows={4} maxLength={700} value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribí lo que querés publicar…" />
                </label>
                <div className="sp-colors" aria-label="Color de fondo">
                  {COLORS.map((c) => (
                    <button type="button" key={c} className={c === color ? 'on' : ''} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Color ${c}`} />
                  ))}
                </div>
              </>
            ) : (
              <>
                <label className="field">
                  <span>{contentType === 'video' ? `Video (MP4 o MOV, máx. ${MAX_VIDEO_SECONDS} s)` : 'Imagen (JPG, PNG o WebP)'}</span>
                  <input className="input" type="file" accept={contentType === 'video' ? 'video/mp4,video/quicktime,video/webm' : 'image/jpeg,image/png,image/webp'} onChange={(e) => setFile(e.target.files?.[0] || null)} />
                </label>
                {contentType === 'video' && file && videoSeconds !== null && !videoTooLong && <small>Duración: {Math.round(videoSeconds)} s · {(file.size / 1024 / 1024).toFixed(1)} MB. Se optimiza automáticamente para WhatsApp.</small>}
                {videoTooLong && <small className="sp-warn">El video dura {Math.round(videoSeconds as number)} s; el máximo es {MAX_VIDEO_SECONDS} s. Recortalo antes de subirlo.</small>}
                {videoTooBig && <small className="sp-warn">El archivo pesa más de {MAX_VIDEO_MB} MB.</small>}
                <label className="field">
                  <span>Descripción (opcional)</span>
                  <input className="input" maxLength={700} value={caption} onChange={(e) => setCaption(e.target.value)} />
                </label>
              </>
            )}

            <fieldset className="sp-group">
              <legend>Audiencia</legend>
              <div className="sp-seg small">
                <button type="button" className={audienceType === 'ALL' ? 'on' : ''} onClick={() => setAudienceType('ALL')}>Todos</button>
                <button type="button" className={audienceType === 'TAG' ? 'on' : ''} onClick={() => setAudienceType('TAG')}>Por etiqueta</button>
                <button type="button" className={audienceType === 'CUSTOM' ? 'on' : ''} onClick={() => setAudienceType('CUSTOM')}>Lista</button>
              </div>
              {audienceType === 'TAG' && (
                <div className="sp-tags">
                  {allTags.length === 0 && <small>Todavía no hay etiquetas en tus contactos.</small>}
                  {allTags.map((tag) => (
                    <button type="button" key={tag} className={tags.includes(tag) ? 'on' : ''} onClick={() => setTags((cur) => (cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]))}>{tag}</button>
                  ))}
                </div>
              )}
              {audienceType === 'CUSTOM' && (
                <div className="sp-picker">
                  <input className="input" placeholder="Buscar contacto…" value={contactQuery} onChange={(e) => setContactQuery(e.target.value)} />
                  <div className="sp-picker-list">
                    {pickable.map((c) => (
                      <label key={c.id}>
                        <input type="checkbox" checked={contactIds.includes(c.id)} onChange={() => setContactIds((cur) => (cur.includes(c.id) ? cur.filter((id) => id !== c.id) : [...cur, c.id]))} />
                        <span>{c.name || 'Sin nombre'} <small>{c.phone}</small></span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <p className={`sp-count ${audienceCount === 0 || tooLarge ? 'bad' : ''}`}>
                {audienceCount === null ? 'Calculando audiencia…' : tooLarge ? `${audienceCount} contactos: supera el máximo de ${metrics?.maxAudience}. Elegí una etiqueta o una lista.` : audienceCount === 0 ? 'Sin contactos con número válido en esta audiencia.' : `${audienceCount} contactos verán este estado.`}
              </p>
            </fieldset>

            <fieldset className="sp-group">
              <legend>Cuándo</legend>
              <div className="sp-seg small">
                <button type="button" className={mode === 'NOW' ? 'on' : ''} onClick={() => setMode('NOW')}>Ahora</button>
                <button type="button" className={mode === 'SCHEDULED' ? 'on' : ''} onClick={() => setMode('SCHEDULED')}>Programar</button>
                <button type="button" className={mode === 'DRAFT' ? 'on' : ''} onClick={() => setMode('DRAFT')}>Borrador</button>
              </div>
              {mode === 'SCHEDULED' && <input className="input" type="datetime-local" value={scheduledAt} min={toLocalInput(new Date())} onChange={(e) => setScheduledAt(e.target.value)} />}
            </fieldset>

            <button className="btn" disabled={!canSubmit}>
              {busy ? (contentType === 'video' ? 'Subiendo y procesando video…' : 'Enviando…') : mode === 'NOW' ? 'Publicar ahora' : mode === 'SCHEDULED' ? 'Programar estado' : 'Guardar borrador'}
            </button>
            {mode === 'NOW' && metrics && !metrics.connected && <small className="sp-warn">WhatsApp está desconectado: reconectá la línea para publicar ahora.</small>}
          </div>

          <div className="sp-phone" aria-label="Vista previa">
            <div className="sp-phone-screen" style={{ background: previewBg }}>
              {contentType === 'text' && <p className="sp-phone-text">{text || 'Tu texto aparecerá aquí'}</p>}
              {contentType === 'image' && (filePreview ? <img src={filePreview} alt="Vista previa" /> : <span className="sp-phone-hint">Elegí una imagen</span>)}
              {contentType === 'video' && (filePreview ? <video src={filePreview} controls muted playsInline /> : <span className="sp-phone-hint">Elegí un video</span>)}
              {contentType !== 'text' && caption && <p className="sp-phone-caption">{caption}</p>}
            </div>
          </div>
        </form>
      </Panel>

      <Panel title="Historial" flush>
        {loading ? (
          <p className="sp-loading">Cargando…</p>
        ) : posts.length === 0 ? (
          <EmptyState icon="✦" title="Todavía no publicaste estados" text="Creá el primero arriba. Se mantiene visible 24 horas." />
        ) : (
          <ul className="sp-history">
            {posts.map((post) => {
              const meta = STATUS_LABEL[post.status];
              return (
                <li key={post.id}>
                  <span className="sp-thumb" style={post.contentType === 'text' ? { background: post.backgroundColor || '#075E54' } : undefined}>
                    {post.contentType === 'image' && post.mediaUrl ? <img src={post.mediaUrl} alt="" /> : post.contentType === 'video' && post.mediaUrl ? <video src={post.mediaUrl} muted preload="metadata" /> : <em>{(post.textContent || '').slice(0, 24)}</em>}
                  </span>
                  <span className="sp-info">
                    <strong>{post.contentType === 'text' ? post.textContent : post.caption || (post.contentType === 'video' ? 'Video' : 'Imagen')}</strong>
                    <small>
                      {post.publishedAt ? `Publicado ${formatDateTime(post.publishedAt)} · vence ${formatDateTime(post.expiresAt)}` : post.scheduledAt ? `Programado ${formatDateTime(post.scheduledAt)}` : `Creado ${formatDateTime(post.createdAt)}`}
                      {' · '}{post.audienceCount} contactos
                    </small>
                    {post.errorMessage && <small className="sp-error">{post.errorMessage}{post.status === 'scheduled' ? ` (reintento ${post.retryCount}/3)` : ''}</small>}
                  </span>
                  <Pill tone={meta.tone}>{meta.label}</Pill>
                  <span className="sp-actions">
                    {['draft', 'failed'].includes(post.status) && <button type="button" onClick={() => act(post, 'publish')}>{post.status === 'failed' ? 'Reintentar' : 'Publicar'}</button>}
                    {post.status !== 'deleted' && post.status !== 'processing' && <button type="button" onClick={() => act(post, 'duplicate')}>Duplicar</button>}
                    {['scheduled', 'draft', 'failed'].includes(post.status) && <button type="button" onClick={() => act(post, 'cancel')}>Cancelar</button>}
                    {['published'].includes(post.status) && <button type="button" className="danger" onClick={() => act(post, 'delete')}>Eliminar</button>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      </>}
    </PageShell>
  );
}
