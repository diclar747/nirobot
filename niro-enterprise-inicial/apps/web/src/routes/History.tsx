import { useCallback, useEffect, useState } from 'react';
import { apiGet, ApiError } from '../lib/api';
import { formatFileSize, formatPhone } from '../lib/format';
import { PageHeader, PageShell, Panel, StatCard, StatGrid, EmptyState, LoadingRows, Pill, type Tone } from '../components/PageKit';
import { Ui } from '../components/Ui';
import { Modal } from '../components/Modal';
import { PlyrVideo, WaveAudio } from '../components/MediaPlayers';
import type { Department } from '../types';
import '../styles/history.css';

interface HistoryContact { id: string; name: string | null; phone: string | null; avatarUrl: string | null }
interface HistoryRow {
  id: string;
  conversationId: string;
  contact: HistoryContact | null;
  department: { id: string; name: string } | null;
  direction: 'INBOUND' | 'OUTBOUND';
  contentType: string;
  typeLabel: string;
  origin: string;
  content: string;
  preview: string;
  agent: { id: string; name: string } | null;
  campaign: { id: string; name: string } | null;
  status: string;
  attachment: { id: string; fileName: string; mimeType: string; size: number } | null;
  createdAt: string;
}
interface HistoryDetail extends HistoryRow {
  quotedPreview: string | null;
  quotedSender: string | null;
  transcription: string | null;
  reactions: { emoji?: string; from?: string }[];
  imported: boolean;
}
interface MessagesResponse { messages: HistoryRow[]; total: number; page: number; pageSize: number; account: { phone: string | null; name: string | null } }
interface Summary {
  range: { from: string; to: string };
  total: number; outbound: number; inbound: number;
  byStatus: { pending: number; sent: number; delivered: number; read: number; failed: number };
  fromAgents: number; fromCampaigns: number; fromBots: number; statusPosts: number;
  byType: { image: number; audio: number; video: number; document: number; sticker: number };
}
interface OrgUserLite { id: string; name: string; role: string }

const STATUS_META: Record<string, { label: string; glyph: string; tone: Tone }> = {
  pending: { label: 'Pendiente', glyph: '🕐', tone: 'neutral' },
  sent: { label: 'Enviado', glyph: '✓', tone: 'primary' },
  delivered: { label: 'Entregado', glyph: '✓✓', tone: 'success' },
  read: { label: 'Visto', glyph: '✓✓', tone: 'violet' },
  failed: { label: 'Fallido', glyph: '✕', tone: 'danger' }
};

const ORIGIN_META: Record<string, { label: string; tone: Tone }> = {
  contact: { label: 'Contacto', tone: 'neutral' },
  agent: { label: 'Agente', tone: 'primary' },
  bot: { label: 'Chatbot', tone: 'violet' },
  ai: { label: 'Bot con IA', tone: 'violet' },
  campaign: { label: 'Campaña', tone: 'warning' },
  api: { label: 'API', tone: 'success' },
  phone: { label: 'Teléfono', tone: 'neutral' },
  system: { label: 'Sistema', tone: 'neutral' }
};

const TYPE_OPTIONS = [
  { key: 'text', label: 'Texto' }, { key: 'image', label: 'Imagen' }, { key: 'audio', label: 'Audio' },
  { key: 'video', label: 'Video' }, { key: 'document', label: 'Documento' }, { key: 'sticker', label: 'Sticker' },
  { key: 'poll', label: 'Encuesta' }, { key: 'contact', label: 'Contacto' }
];
const ORIGIN_OPTIONS = Object.entries(ORIGIN_META).map(([key, m]) => ({ key, label: m.label }));

function fullDate(iso: string) {
  return new Date(iso).toLocaleString('es-PY', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function StatusPill({ status }: { status: string }) {
  const meta = STATUS_META[status] || { label: status, glyph: '•', tone: 'neutral' as Tone };
  return <Pill tone={meta.tone}>{meta.glyph} {meta.label}</Pill>;
}

function DirectionCell({ direction }: { direction: 'INBOUND' | 'OUTBOUND' }) {
  return direction === 'OUTBOUND' ? <span className="hist-direction out">↗ Enviado</span> : <span className="hist-direction in">↙ Recibido</span>;
}

function ContactCell({ contact }: { contact: HistoryContact | null }) {
  if (!contact) return <span className="hist-muted">—</span>;
  const label = (contact.name || formatPhone(contact.phone) || '?').trim();
  const letters = label.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
  return (
    <div className="hist-contact">
      {contact.avatarUrl ? <img src={contact.avatarUrl} alt="" className="hist-avatar" /> : <span className="hist-avatar fallback">{letters || '?'}</span>}
      <div>
        <div className="hist-contact-name">{contact.name || 'Sin nombre'}</div>
        <div className="hist-contact-phone">{formatPhone(contact.phone) || '—'}</div>
      </div>
    </div>
  );
}

interface Filters { from: string; to: string; direction: string; status: string; type: string; origin: string; agentId: string; departmentId: string }
const EMPTY_FILTERS: Filters = { from: '', to: '', direction: '', status: '', type: '', origin: '', agentId: '', departmentId: '' };

function HistoryFilters({
  filters, onChange, q, onQChange, agents, departments
}: {
  filters: Filters; onChange: (next: Filters) => void; q: string; onQChange: (v: string) => void;
  agents: OrgUserLite[]; departments: Department[];
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const active = Object.values(filters).some(Boolean) || Boolean(q);
  return (
    <div className="list-filters">
      <div className="list-filter-row">
        <label className="list-filter-search">
          <Ui name="search" size={14} />
          <input className="input" value={q} onChange={(e) => onQChange(e.target.value)} placeholder="Buscar contacto, número o contenido…" aria-label="Buscar" />
        </label>
        <label className="list-filter-field"><span>Desde</span><input className="input" type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} /></label>
        <label className="list-filter-field"><span>Hasta</span><input className="input" type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} /></label>
        <label className="list-filter-field"><span>Dirección</span>
          <select className="input" value={filters.direction} onChange={(e) => set({ direction: e.target.value })}>
            <option value="">Todas</option>
            <option value="OUTBOUND">Enviados</option>
            <option value="INBOUND">Recibidos</option>
          </select>
        </label>
        <label className="list-filter-field"><span>Estado</span>
          <select className="input" value={filters.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">Todos</option>
            {Object.entries(STATUS_META).map(([key, m]) => <option key={key} value={key}>{m.label}</option>)}
          </select>
        </label>
        <label className="list-filter-field"><span>Tipo</span>
          <select className="input" value={filters.type} onChange={(e) => set({ type: e.target.value })}>
            <option value="">Todos</option>
            {TYPE_OPTIONS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <label className="list-filter-field"><span>Origen</span>
          <select className="input" value={filters.origin} onChange={(e) => set({ origin: e.target.value })}>
            <option value="">Todos</option>
            {ORIGIN_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
        <label className="list-filter-field"><span>Agente</span>
          <select className="input" value={filters.agentId} onChange={(e) => set({ agentId: e.target.value })}>
            <option value="">Todos</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        {departments.length > 0 && (
          <label className="list-filter-field"><span>Área</span>
            <select className="input" value={filters.departmentId} onChange={(e) => set({ departmentId: e.target.value })}>
              <option value="">Todas</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        )}
        {active && (
          <button type="button" className="btn secondary small list-filter-clear" onClick={() => { onChange(EMPTY_FILTERS); onQChange(''); }}>
            <Ui name="x" size={13} /> Limpiar filtros
          </button>
        )}
      </div>
    </div>
  );
}

function AttachmentPreview({ conversationId, attachment }: { conversationId: string; attachment: { id: string; fileName: string; mimeType: string; size: number } }) {
  const url = `/api/org/conversations/${conversationId}/attachments/${attachment.id}`;
  if (attachment.mimeType.startsWith('image/')) return <img src={url} alt={attachment.fileName} className="hist-preview-media" />;
  if (attachment.mimeType.startsWith('video/')) return <PlyrVideo src={url} />;
  if (attachment.mimeType.startsWith('audio/')) return <WaveAudio src={url} />;
  return (
    <a className="hist-doc-card" href={url} target="_blank" rel="noreferrer">
      <Ui name="paperclip" size={18} />
      <div>
        <div className="hist-doc-name">{attachment.fileName}</div>
        <div className="hist-muted">{formatFileSize(attachment.size)}</div>
      </div>
      <Ui name="download" size={16} />
    </a>
  );
}

function MessageDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ message: HistoryDetail }>(`/api/org/history/messages/${id}`)
      .then((d) => setDetail(d.message))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'No se pudo cargar el mensaje'));
  }, [id]);

  return (
    <Modal title="Detalle del mensaje" onClose={onClose} className="hist-detail-modal">
      {error && <div className="alert error">{error}</div>}
      {!detail && !error ? (
        <LoadingRows rows={3} />
      ) : detail ? (
        <div className="hist-detail">
          <div className="hist-detail-head">
            <ContactCell contact={detail.contact} />
            <div className="hist-detail-meta">
              <DirectionCell direction={detail.direction} />
              <StatusPill status={detail.status} />
              <Pill tone={ORIGIN_META[detail.origin]?.tone || 'neutral'}>{ORIGIN_META[detail.origin]?.label || detail.origin}</Pill>
            </div>
          </div>

          {detail.quotedPreview && (
            <div className="hist-quote">↪ Respondiendo a{detail.quotedSender ? ` ${detail.quotedSender}` : ''}: “{detail.quotedPreview}”</div>
          )}

          {detail.attachment ? (
            <AttachmentPreview conversationId={detail.conversationId} attachment={detail.attachment} />
          ) : (
            <p className="hist-detail-text">{detail.content || <span className="hist-muted">Sin contenido</span>}</p>
          )}

          {detail.transcription && <p className="hist-transcription">📝 {detail.transcription}</p>}

          {detail.reactions.length > 0 && (
            <div className="hist-reactions">{detail.reactions.map((r, i) => <span key={i} className="hist-reaction">{r.emoji}</span>)}</div>
          )}

          <div className="hist-detail-grid">
            <div><span className="hist-muted">Agente</span><div>{detail.agent?.name || '—'}</div></div>
            <div><span className="hist-muted">Área</span><div>{detail.department?.name || '—'}</div></div>
            <div><span className="hist-muted">Campaña</span><div>{detail.campaign?.name || '—'}</div></div>
            <div><span className="hist-muted">Fecha</span><div>{fullDate(detail.createdAt)}</div></div>
          </div>

          <a className="btn secondary small" href={`/inbox?conversation=${detail.conversationId}`}>
            <Ui name="external" size={14} /> Abrir conversación
          </a>
        </div>
      ) : null}
    </Modal>
  );
}

export function History() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [data, setData] = useState<MessagesResponse | null>(null);
  const [agents, setAgents] = useState<OrgUserLite[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);

  useEffect(() => { const t = window.setTimeout(() => { setQ(qInput); setPage(1); }, 350); return () => window.clearTimeout(t); }, [qInput]);
  useEffect(() => { setPage(1); }, [filters]);

  useEffect(() => {
    apiGet<{ users: OrgUserLite[] }>('/api/org/users').then((d) => setAgents(d.users.filter((u) => ['AGENT', 'SUPERVISOR', 'ADMIN', 'OWNER'].includes(u.role)))).catch(() => {});
    apiGet<{ departments: Department[] }>('/api/org/departments').then((d) => setDepartments(d.departments)).catch(() => {});
  }, []);

  const queryString = useCallback((extra?: Record<string, string>) => {
    const params = new URLSearchParams({ page: String(page), pageSize: '30' });
    if (q) params.set('q', q);
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
    if (extra) Object.entries(extra).forEach(([k, v]) => params.set(k, v));
    return params.toString();
  }, [page, q, filters]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [messages, summaryRes] = await Promise.all([
        apiGet<MessagesResponse>(`/api/org/history/messages?${queryString()}`),
        apiGet<Summary>(`/api/org/history/summary?${(() => { const p = new URLSearchParams(); if (filters.from) p.set('from', filters.from); if (filters.to) p.set('to', filters.to); return p.toString(); })()}`)
      ]);
      setData(messages);
      setSummary(summaryRes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar el historial');
    } finally {
      setLoading(false);
    }
  }, [queryString, filters.from, filters.to]);

  useEffect(() => { load(); }, [load]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <PageShell>
      <PageHeader
        icon={<Ui name="clock" size={22} />}
        title="Historial"
        subtitle={data?.account.phone ? `Registro completo de mensajes de la cuenta ${formatPhone(data.account.phone)}` : 'Registro completo de mensajes, campañas y estados de WhatsApp.'}
        actions={<a className="btn secondary" href={`/api/org/history/messages/export.csv?${queryString()}`}><Ui name="download" size={16} /> Exportar CSV</a>}
      />

      {error && <div className="alert error">{error}</div>}

      {summary && (
        <>
          <StatGrid>
            <StatCard label="Total mensajes" value={summary.total} icon={<Ui name="chat" size={16} />} />
            <StatCard label="Enviados" value={summary.outbound} tone="primary" icon={<Ui name="send" size={16} />} />
            <StatCard label="Recibidos" value={summary.inbound} tone="violet" icon={<Ui name="download" size={16} />} />
            <StatCard label="Pendientes" value={summary.byStatus.pending} tone="warning" icon={<Ui name="clock" size={16} />} />
            <StatCard label="Entregados" value={summary.byStatus.delivered} tone="success" icon={<Ui name="check" size={16} />} />
            <StatCard label="Vistos" value={summary.byStatus.read} tone="violet" icon={<Ui name="eye" size={16} />} />
            <StatCard label="Fallidos / no entregados" value={summary.byStatus.failed} tone="danger" icon={<Ui name="alert" size={16} />} />
            <StatCard label="Respondidos por agentes" value={summary.fromAgents} tone="primary" icon={<Ui name="user" size={16} />} />
            <StatCard label="De campañas" value={summary.fromCampaigns} tone="warning" icon={<Ui name="megaphone" size={16} />} />
            <StatCard label="De chatbot / IA" value={summary.fromBots} tone="violet" icon={<Ui name="bot" size={16} />} />
            <StatCard label="Estados publicados" value={summary.statusPosts} icon={<Ui name="globe" size={16} />} />
          </StatGrid>
          <div className="hist-type-row">
            <span><Ui name="image" size={14} /> {summary.byType.image} imágenes</span>
            <span><Ui name="mic" size={14} /> {summary.byType.audio} audios</span>
            <span><Ui name="video" size={14} /> {summary.byType.video} videos</span>
            <span><Ui name="clipboard" size={14} /> {summary.byType.document} documentos</span>
            <span><Ui name="smile" size={14} /> {summary.byType.sticker} stickers</span>
          </div>
        </>
      )}

      <Panel flush title="Todos los mensajes">
        <div style={{ padding: '14px 16px 0' }}>
          <HistoryFilters filters={filters} onChange={setFilters} q={qInput} onQChange={setQInput} agents={agents} departments={departments} />
        </div>
        {loading ? (
          <LoadingRows />
        ) : !data || data.messages.length === 0 ? (
          <EmptyState icon={<Ui name="clock" size={28} />} title="Sin mensajes en este período" text="Probá ampliar el rango de fechas o limpiar los filtros." />
        ) : (
          <>
            <div className="page-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Contacto</th><th>Dirección</th><th>Tipo</th><th>Origen</th><th>Mensaje</th>
                    <th>Agente</th><th>Fecha</th><th>Estado</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.messages.map((m) => (
                    <tr key={m.id}>
                      <td><ContactCell contact={m.contact} /></td>
                      <td><DirectionCell direction={m.direction} /></td>
                      <td>{m.typeLabel}</td>
                      <td><Pill tone={ORIGIN_META[m.origin]?.tone || 'neutral'}>{ORIGIN_META[m.origin]?.label || m.origin}</Pill></td>
                      <td className="hist-preview-cell">{m.preview || <span className="hist-muted">—</span>}</td>
                      <td>{m.agent?.name || '—'}</td>
                      <td className="hist-nowrap">{fullDate(m.createdAt)}</td>
                      <td><StatusPill status={m.status} /></td>
                      <td className="actions">
                        <button className="btn secondary small" title="Ver detalle" onClick={() => setPreviewId(m.id)}><Ui name="eye" size={14} /></button>
                        <a className="btn secondary small" title="Abrir conversación" href={`/inbox?conversation=${m.conversationId}`}><Ui name="external" size={14} /></a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="hist-pagination">
              <span className="hist-muted">{data.total.toLocaleString('es-PY')} mensajes · página {page} de {pages}</span>
              <div>
                <button className="btn secondary small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><Ui name="arrow-left" size={14} /> Anterior</button>
                <button className="btn secondary small" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Siguiente <Ui name="arrow-right" size={14} /></button>
              </div>
            </div>
          </>
        )}
      </Panel>

      {previewId && <MessageDetailModal id={previewId} onClose={() => setPreviewId(null)} />}
    </PageShell>
  );
}
