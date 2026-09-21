import { useEffect, useMemo, useState } from 'react';
import { apiGet, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { formatPhone, initials } from '../lib/format';
import { Modal } from './Modal';
import { Ui } from './Ui';

export interface StatusViewer {
  id: string;
  viewerJid: string;
  phone: string | null;
  name: string | null;
  viewedAt: string | null;
  reaction: string | null;
  reactedAt: string | null;
}
interface ViewsPayload { views: StatusViewer[]; counts: { views: number; reactions: number }; audienceCount: number }

const timeAgo = (iso: string | null) => {
  if (!iso) return '';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'hace un momento';
  if (seconds < 3600) return `hace ${Math.floor(seconds / 60)} min`;
  const date = new Date(iso);
  const today = new Date();
  const time = date.toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === today.toDateString() ? `hoy ${time}` : `${date.toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })} ${time}`;
};

// Quién vio (y quién reaccionó a) un estado publicado, como en el teléfono, y que se actualiza en vivo.
export function StatusViewersModal({ postId, title, onClose }: { postId: string; title: string; onClose: () => void }) {
  const [data, setData] = useState<ViewsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'all' | 'likes'>('all');
  const [live, setLive] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiGet<ViewsPayload>(`/api/org/status-posts/${postId}/views`)
      .then((payload) => { if (!cancelled) setData(payload); })
      .catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'No se pudo cargar la lista'); });
    const socket = getSocket();
    const onView = (payload: { postId: string | null; view: StatusViewer; counts: { views: number; reactions: number } }) => {
      if (payload.postId !== postId) return;
      setLive(true);
      setData((current) => {
        const base = current || { views: [], counts: payload.counts, audienceCount: 0 };
        const others = base.views.filter((v) => v.viewerJid !== payload.view.viewerJid);
        return { ...base, counts: payload.counts, views: [payload.view, ...others] };
      });
    };
    socket.on('status:view', onView);
    const timer = window.setInterval(() => tick((n) => n + 1), 30000); // refresca "hace X min"
    return () => { cancelled = true; socket.off('status:view', onView); window.clearInterval(timer); };
  }, [postId]);

  const rows = useMemo(() => {
    const list = data?.views || [];
    const filtered = tab === 'likes' ? list.filter((v) => v.reaction) : list;
    return [...filtered].sort((a, b) => new Date(b.reactedAt || b.viewedAt || 0).getTime() - new Date(a.reactedAt || a.viewedAt || 0).getTime());
  }, [data, tab]);
  const views = data?.counts.views || 0;
  const reactions = data?.counts.reactions || 0;
  const audience = data?.audienceCount || 0;
  const percent = audience > 0 ? Math.min(100, Math.round((views / audience) * 100)) : null;

  return (
    <Modal title="Vistas del estado" onClose={onClose} className="sv-modal">
      <div className="sv-head">
        <p className="sv-title">{title}</p>
        <div className="sv-stats">
          <span><Ui name="eye" size={16} /><b>{views}</b> {views === 1 ? 'vista' : 'vistas'}</span>
          <span><b>❤️</b><b>{reactions}</b> {reactions === 1 ? 'me gusta' : 'me gusta'}</span>
          {live && <span className="sv-live"><i /> En vivo</span>}
        </div>
        {percent !== null && (
          <div className="sv-progress" aria-label={`${percent} % de la audiencia`}>
            <div><span style={{ width: `${percent}%` }} /></div>
            <small>{views} de {audience} contactos ({percent} %)</small>
          </div>
        )}
      </div>
      <div className="sv-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>Vistas ({views})</button>
        <button type="button" role="tab" aria-selected={tab === 'likes'} className={tab === 'likes' ? 'active' : ''} onClick={() => setTab('likes')}>Me gusta ({reactions})</button>
      </div>
      {error && <div className="alert error">{error}</div>}
      {!data && !error && <p className="sv-empty">Cargando…</p>}
      {data && rows.length === 0 && (
        <div className="sv-empty">
          <strong>{tab === 'likes' ? 'Todavía nadie reaccionó' : 'Todavía nadie lo vio'}</strong>
          <span>Las vistas aparecen acá en cuanto alguien abre tu estado. WhatsApp solo informa las de quienes tienen activadas las confirmaciones de lectura.</span>
        </div>
      )}
      <ul className="sv-list">
        {rows.map((viewer) => (
          <li key={viewer.id}>
            <span className="sv-avatar">{initials(viewer.name || viewer.phone || '?')}</span>
            <span className="sv-person">
              <b>{viewer.name || (viewer.phone ? formatPhone(viewer.phone) : 'Contacto de WhatsApp')}</b>
              <small>{viewer.name && viewer.phone ? `${formatPhone(viewer.phone)} · ` : ''}{timeAgo(viewer.viewedAt)}</small>
            </span>
            {viewer.reaction && <span className="sv-reaction" title="Me gusta">{viewer.reaction}</span>}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
