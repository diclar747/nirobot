import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost, apiUpload, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { useAlerts } from '../context/AlertContext';
import { EmptyState, Panel, Pill, StatCard, StatGrid, type Tone } from './PageKit';
import type { Contact } from '../types';
import { Ui } from './Ui';

type Campaign = {
  id: string;
  name: string;
  intervalHours: number;
  startAt: string;
  replacePrevious: boolean;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  totalItems: number;
  published: number;
  pending: number;
  failed: number;
  nextAt: string | null;
  endsAt: string;
};

type Item = { key: number; contentType: 'text' | 'image' | 'video'; text: string; caption: string; color: string; file: File | null };

const STATUS: Record<Campaign['status'], { label: string; tone: Tone }> = {
  active: { label: 'Activa', tone: 'success' },
  paused: { label: 'Pausada', tone: 'warning' },
  completed: { label: 'Terminada', tone: 'neutral' },
  cancelled: { label: 'Cancelada', tone: 'neutral' }
};
const COLORS = ['#075E54', '#128C7E', '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#0f172a'];
const DEFAULT_INTERVALS = [1, 2, 3, 4, 6, 8, 12, 16, 20, 24, 36, 48, 72, 168];

function intervalLabel(hours: number): string {
  if (hours === 24) return 'Cada 24 horas (1 por día)';
  if (hours === 168) return 'Cada semana';
  if (hours % 24 === 0) return `Cada ${hours / 24} días`;
  return `Cada ${hours} horas`;
}
function formatDateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('es-PY', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
}
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

let nextKey = 1;
const newItem = (contentType: 'text' | 'image' | 'video' = 'text', file: File | null = null): Item => ({ key: nextKey++, contentType, text: '', caption: '', color: COLORS[0], file });

export function StatusCampaigns({ contacts }: { contacts: Contact[] }) {
  const { notify, confirm } = useAlerts();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [intervals, setIntervals] = useState<number[]>(DEFAULT_INTERVALS);
  const [maxItems, setMaxItems] = useState(60);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [intervalHours, setIntervalHours] = useState(24);
  const [startAt, setStartAt] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60 * 1000)));
  const [replacePrevious, setReplacePrevious] = useState(true);
  const [audienceType, setAudienceType] = useState<'ALL' | 'TAG'>('ALL');
  const [tags, setTags] = useState<string[]>([]);
  const [items, setItems] = useState<Item[]>(() => [newItem()]);
  const [audienceCount, setAudienceCount] = useState<number | null>(null);

  const load = useCallback(() => {
    apiGet<{ campaigns: Campaign[]; intervals: number[]; maxItems: number }>('/api/org/status-campaigns')
      .then((data) => { setCampaigns(data.campaigns); setIntervals(data.intervals); setMaxItems(data.maxItems); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const socket = getSocket();
    socket.on('status-campaign:updated', load);
    socket.on('status-post:updated', load);
    return () => { socket.off('status-campaign:updated', load); socket.off('status-post:updated', load); };
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams({ audienceType, audienceTags: tags.join(','), audienceContactIds: '' });
    const timer = window.setTimeout(() => {
      apiGet<{ count: number }>(`/api/org/status-posts/audience-preview?${params}`).then((r) => setAudienceCount(r.count)).catch(() => setAudienceCount(null));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [audienceType, tags]);

  const allTags = useMemo(() => [...new Set(contacts.flatMap((c) => c.tags || []))].sort(), [contacts]);
  const update = (key: number, patch: Partial<Item>) => setItems((cur) => cur.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const itemReady = (i: Item) => (i.contentType === 'text' ? i.text.trim().length > 0 : Boolean(i.file));
  const lastAt = new Date(new Date(startAt).getTime() + (items.length - 1) * intervalHours * 3600 * 1000);
  const canSubmit = !busy && name.trim().length > 0 && items.length > 0 && items.every(itemReady) && audienceCount !== 0 && !Number.isNaN(new Date(startAt).getTime());

  function addImages(files: FileList | null) {
    if (!files) return;
    const room = maxItems - items.length;
    const added = [...files].slice(0, room).map((f) => newItem(f.type.startsWith('video/') ? 'video' : 'image', f));
    setItems((cur) => [...cur.filter((i) => i.contentType !== 'text' || i.text.trim() || cur.length === 1), ...added].slice(0, maxItems));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      const form = new FormData();
      const files: File[] = [];
      const payload = items.map((i) => {
        if (i.contentType === 'text') return { contentType: 'text', textContent: i.text.trim(), backgroundColor: i.color };
        files.push(i.file as File);
        return { contentType: i.contentType, ...(i.caption.trim() ? { caption: i.caption.trim() } : {}), fileIndex: files.length - 1 };
      });
      form.append('name', name.trim());
      form.append('intervalHours', String(intervalHours));
      form.append('startAt', new Date(startAt).toISOString());
      form.append('replacePrevious', String(replacePrevious));
      form.append('audienceType', audienceType);
      form.append('audienceTags', JSON.stringify(tags));
      form.append('items', JSON.stringify(payload));
      files.forEach((f) => form.append('files', f));
      await apiUpload('/api/org/status-campaigns', form);
      notify(`Campaña creada: ${items.length} estados programados.`, { tone: 'success', title: 'Listo' });
      setName(''); setItems([newItem()]);
      load();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'No se pudo crear la campaña.', { tone: 'error', title: 'Error' });
    } finally {
      setBusy(false);
    }
  }

  async function act(campaign: Campaign, action: 'pause' | 'resume' | 'cancel') {
    try {
      if (action === 'cancel' && !(await confirm({ title: 'Cancelar campaña', message: 'Se descartan los estados que todavía no salieron. Los ya publicados siguen visibles hasta que venzan.', confirmLabel: 'Cancelar campaña', tone: 'danger' }))) return;
      await apiPost(`/api/org/status-campaigns/${campaign.id}/${action}`, {});
      load();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'No se pudo completar la acción.', { tone: 'error', title: 'Error' });
    }
  }

  return (
    <>
      <StatGrid>
        <StatCard label="Campañas activas" value={campaigns.filter((c) => c.status === 'active').length} hint="Secuencias en marcha" icon={<Ui name="megaphone" />} tone="success" />
        <StatCard label="En pausa" value={campaigns.filter((c) => c.status === 'paused').length} hint="Listas para reanudar" icon={<Ui name="clock" />} tone="warning" />
        <StatCard label="Completadas" value={campaigns.filter((c) => c.status === 'completed').length} hint="Secuencias finalizadas" icon={<Ui name="check-circle" />} tone="primary" />
      </StatGrid>
      <Panel title="Nueva campaña de estados" actions={<Pill tone="violet">Publicación automática</Pill>}>
        <p className="sp-section-intro">Prepará una secuencia de textos, imágenes o videos. Podés crear varias campañas y gestionar cada una por separado.</p>
        <form className="sp-form" onSubmit={submit}>
          <label className="field">
            <span>Nombre de la campaña</span>
            <input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Producto estrella — septiembre" />
          </label>

          <div className="sc-row">
            <label className="field">
              <span>Cambiar el estado</span>
              <select className="input" value={intervalHours} onChange={(e) => setIntervalHours(Number(e.target.value))}>
                {intervals.map((h) => <option key={h} value={h}>{intervalLabel(h)}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Primera publicación</span>
              <input className="input" type="datetime-local" value={startAt} min={toLocalInput(new Date())} onChange={(e) => setStartAt(e.target.value)} />
            </label>
          </div>

          <label className="sc-check">
            <input type="checkbox" checked={replacePrevious} onChange={(e) => setReplacePrevious(e.target.checked)} />
            <span>Retirar el estado anterior al publicar el siguiente <small>(los contactos ven solo el actual)</small></span>
          </label>

          <fieldset className="sp-group">
            <legend>01 · Audiencia</legend>
            <div className="sp-seg small">
              <button type="button" className={audienceType === 'ALL' ? 'on' : ''} onClick={() => setAudienceType('ALL')}>Todos</button>
              <button type="button" className={audienceType === 'TAG' ? 'on' : ''} onClick={() => setAudienceType('TAG')}>Por etiqueta</button>
            </div>
            {audienceType === 'TAG' && (
              <div className="sp-tags">
                {allTags.length === 0 && <small>Todavía no hay etiquetas en tus contactos.</small>}
                {allTags.map((tag) => (
                  <button type="button" key={tag} className={tags.includes(tag) ? 'on' : ''} onClick={() => setTags((cur) => (cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]))}>{tag}</button>
                ))}
              </div>
            )}
            <p className={`sp-count ${audienceCount === 0 ? 'bad' : ''}`}>
              {audienceCount === null ? 'Calculando audiencia…' : audienceCount === 0 ? 'Sin contactos con número válido en esta audiencia.' : `${audienceCount} contactos verán estos estados.`}
            </p>
          </fieldset>

          <fieldset className="sp-group">
            <legend>02 · Secuencia ({items.length}/{maxItems}) — salen en este orden</legend>
            <ol className="sc-items">
              {items.map((item, index) => (
                <li key={item.key}>
                  <span className="sc-num">{index + 1}</span>
                  <div className="sc-item-body">
                    <div className="sp-seg small">
                      <button type="button" className={item.contentType === 'text' ? 'on' : ''} onClick={() => update(item.key, { contentType: 'text' })}>Texto</button>
                      <button type="button" className={item.contentType === 'image' ? 'on' : ''} onClick={() => update(item.key, { contentType: 'image', file: null })}>Imagen</button>
                      <button type="button" className={item.contentType === 'video' ? 'on' : ''} onClick={() => update(item.key, { contentType: 'video', file: null })}>Video</button>
                    </div>
                    {item.contentType === 'text' ? (
                      <>
                        <textarea className="input" rows={2} maxLength={700} value={item.text} onChange={(e) => update(item.key, { text: e.target.value })} placeholder="Texto del estado…" />
                        <div className="sp-colors">
                          {COLORS.map((c) => <button type="button" key={c} className={c === item.color ? 'on' : ''} style={{ background: c }} onClick={() => update(item.key, { color: c })} aria-label={`Color ${c}`} />)}
                        </div>
                      </>
                    ) : (
                      <>
                        <input className="input" type="file" accept={item.contentType === 'video' ? 'video/mp4,video/quicktime,video/webm' : 'image/jpeg,image/png,image/webp'} onChange={(e) => update(item.key, { file: e.target.files?.[0] || null })} />
                        {item.file && <small>{item.file.name}{item.contentType === 'video' ? ' · máx. 60 s' : ''}</small>}
                        <input className="input" maxLength={700} value={item.caption} onChange={(e) => update(item.key, { caption: e.target.value })} placeholder="Descripción (opcional)" />
                      </>
                    )}
                    <small className="sc-when">Sale: {formatDateTime(new Date(new Date(startAt).getTime() + index * intervalHours * 3600 * 1000).toISOString())}</small>
                  </div>
                  <span className="sc-move">
                    <button type="button" disabled={index === 0} onClick={() => setItems((cur) => { const c = [...cur]; [c[index - 1], c[index]] = [c[index], c[index - 1]]; return c; })} aria-label="Subir"><Ui name="upgrade" size={14} /></button>
                    <button type="button" disabled={index === items.length - 1} onClick={() => setItems((cur) => { const c = [...cur]; [c[index + 1], c[index]] = [c[index], c[index + 1]]; return c; })} aria-label="Bajar">↓</button>
                    <button type="button" disabled={items.length === 1} onClick={() => setItems((cur) => cur.filter((i) => i.key !== item.key))} aria-label="Quitar"><Ui name="x" size={14} /></button>
                  </span>
                </li>
              ))}
            </ol>
            <div className="sc-add">
              <button type="button" className="btn ghost" disabled={items.length >= maxItems} onClick={() => setItems((cur) => [...cur, newItem('text')])}>+ Agregar texto</button>
              <label className={`btn ghost ${items.length >= maxItems ? 'disabled' : ''}`}>
                + Subir varias imágenes o videos
                <input type="file" multiple hidden accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" disabled={items.length >= maxItems} onChange={(e) => { addImages(e.target.files); e.target.value = ''; }} />
              </label>
            </div>
          </fieldset>

          <p className="sc-summary">
            {items.length} estados · {intervalLabel(intervalHours).toLowerCase()} · terminan el {formatDateTime(lastAt.toISOString())}
          </p>
          <button className="btn" disabled={!canSubmit}>{busy ? 'Creando…' : 'Crear campaña'}</button>
        </form>
      </Panel>

      <Panel title="Mis campañas" actions={<Pill>{campaigns.length} campañas</Pill>} flush>
        {campaigns.length === 0 ? (
          <EmptyState icon={<Ui name="megaphone" size={28} />} title="Todavía no hay campañas" text="Creá una y los estados se publicarán solos en el intervalo que elijas." />
        ) : (
          <ul className="sp-history">
            {campaigns.map((c) => {
              const meta = STATUS[c.status];
              const percent = Math.round((c.published / Math.max(1, c.totalItems)) * 100);
              return (
                <li key={c.id} className="sc-campaign">
                  <span className="sp-info">
                    <strong>{c.name}</strong>
                    <small>
                      {intervalLabel(c.intervalHours)} · {c.published}/{c.totalItems} publicados
                      {c.failed > 0 ? ` · ${c.failed} con error` : ''}
                      {c.status === 'active' && c.nextAt ? ` · próximo ${formatDateTime(c.nextAt)}` : ''}
                      {c.status === 'paused' ? ' · en pausa' : ''}
                    </small>
                    <span className="sc-bar" role="progressbar" aria-label={`Progreso de ${c.name}`} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${percent}%` }} /></span>
                  </span>
                  <Pill tone={meta.tone}>{meta.label}</Pill>
                  <span className="sp-actions">
                    {c.status === 'active' && <button type="button" onClick={() => act(c, 'pause')}>Pausar</button>}
                    {c.status === 'paused' && <button type="button" onClick={() => act(c, 'resume')}>Reanudar</button>}
                    {(c.status === 'active' || c.status === 'paused') && <button type="button" className="danger" onClick={() => act(c, 'cancel')}>Cancelar</button>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
