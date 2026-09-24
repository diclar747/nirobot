import { Fragment, useEffect, useMemo, useState } from 'react';
import { apiGet, ApiError } from '../lib/api';
import { Ui } from './Ui';
import '../styles/audit-log.css';

interface AuditEntry {
  id: string;
  action: string;
  category: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  actorUserId: string | null;
  actorName: string;
  createdAt: string;
}
interface FiltersResponse { categories: string[]; entityTypes: string[]; actors: { id: string; name: string }[] }
interface AuditResponse { entries: AuditEntry[]; total: number; page: number; pageSize: number; totalPages: number }

const PAGE_SIZE = 15;

function formatFull(iso: string) {
  return new Date(iso).toLocaleString('es-PY', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// "campaign.created" -> "Campaign · created": más legible sin perder el dato original (visible en el título).
function readableAction(action: string) {
  const [entity, verb] = action.split('.');
  if (!verb) return action;
  const VERBS: Record<string, string> = { created: 'creado', updated: 'actualizado', deleted: 'eliminado', started: 'iniciado', paused: 'pausado', cancelled: 'cancelado' };
  const label = entity.replace(/_/g, ' ');
  return `${label[0].toUpperCase()}${label.slice(1)} ${VERBS[verb] || verb}`;
}

/** Registro de auditoría: buscador, filtros por fecha/categoría/entidad/usuario, y páginas de 15. */
export function AuditLogPanel() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FiltersResponse>({ categories: [], entityTypes: [], actors: [] });
  const [expanded, setExpanded] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [category, setCategory] = useState('');
  const [entityType, setEntityType] = useState('');
  const [actorUserId, setActorUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => { apiGet<FiltersResponse>('/api/org/reports/audit/filters').then(setFilters).catch(() => {}); }, []);

  // Buscar con un pequeño respiro: no se dispara una consulta por cada letra escrita.
  useEffect(() => {
    const timer = window.setTimeout(() => { setQ(qInput); setPage(1); }, 350);
    return () => window.clearTimeout(timer);
  }, [qInput]);

  useEffect(() => { setPage(1); }, [category, entityType, actorUserId, from, to]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (q) params.set('q', q);
    if (category) params.set('category', category);
    if (entityType) params.set('entityType', entityType);
    if (actorUserId) params.set('actorUserId', actorUserId);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    apiGet<AuditResponse>(`/api/org/reports/audit?${params.toString()}`)
      .then((data) => { setEntries(data.entries); setTotal(data.total); setTotalPages(data.totalPages); })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'No se pudo cargar la auditoría'))
      .finally(() => setLoading(false));
  }, [page, q, category, entityType, actorUserId, from, to]);

  const active = Boolean(q || category || entityType || actorUserId || from || to);
  function clearFilters() {
    setQInput(''); setQ(''); setCategory(''); setEntityType(''); setActorUserId(''); setFrom(''); setTo('');
  }

  const pageNumbers = useMemo(() => {
    const span = 2;
    const start = Math.max(1, page - span);
    const end = Math.min(totalPages, page + span);
    const nums: number[] = [];
    for (let n = start; n <= end; n += 1) nums.push(n);
    return nums;
  }, [page, totalPages]);

  return (
    <div className="audit-panel">
      <div className="audit-toolbar">
        <label className="audit-search">
          <Ui name="search" size={14} />
          <input className="input" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Buscar por acción, entidad o id…" aria-label="Buscar en el registro" />
        </label>
        <div className="audit-filters">
          <label className="audit-filter"><span>Desde</span><input className="input" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="audit-filter"><span>Hasta</span><input className="input" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="audit-filter"><span>Categoría</span>
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Todas</option>
              {filters.categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="audit-filter"><span>Entidad</span>
            <select className="input" value={entityType} onChange={(e) => setEntityType(e.target.value)}>
              <option value="">Todas</option>
              {filters.entityTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="audit-filter"><span>Usuario</span>
            <select className="input" value={actorUserId} onChange={(e) => setActorUserId(e.target.value)}>
              <option value="">Todos</option>
              <option value="system">Sistema</option>
              {filters.actors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          {active && <button type="button" className="btn secondary small audit-clear" onClick={clearFilters}>Limpiar filtros</button>}
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="audit-table-wrap">
        <table className="audit-table">
          <thead>
            <tr>
              <th>Acción</th>
              <th>Categoría</th>
              <th>Entidad</th>
              <th>Usuario</th>
              <th>Fecha y hora</th>
              <th aria-hidden="true"></th>
            </tr>
          </thead>
          <tbody>
            {loading && Array.from({ length: 6 }).map((_, i) => (
              <tr key={`s-${i}`} className="audit-row-skeleton"><td colSpan={6}><span /></td></tr>
            ))}
            {!loading && entries.map((e) => (
              <Fragment key={e.id}>
                <tr className={`audit-row ${expanded === e.id ? 'open' : ''}`} onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                  <td><b>{readableAction(e.action)}</b><small className="audit-action-raw">{e.action}</small></td>
                  <td><span className="audit-badge">{e.category}</span></td>
                  <td>{e.entityType}{e.entityId ? <small className="audit-entity-id"> #{e.entityId.slice(-6)}</small> : null}</td>
                  <td className="audit-actor">{e.actorName}</td>
                  <td title={formatFull(e.createdAt)}>{formatFull(e.createdAt)}</td>
                  <td className="audit-expand-cell">{e.metadata && Object.keys(e.metadata).length > 0 && <Ui name={expanded === e.id ? 'chevron-left' : 'chevron-right'} size={14} />}</td>
                </tr>
                {expanded === e.id && e.metadata && Object.keys(e.metadata).length > 0 && (
                  <tr className="audit-detail-row" key={`${e.id}-detail`}>
                    <td colSpan={6}><pre className="audit-detail-json">{JSON.stringify(e.metadata, null, 2)}</pre></td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!loading && entries.length === 0 && (
              <tr><td colSpan={6} className="audit-empty">{active ? 'Nada coincide con estos filtros.' : 'Sin actividad registrada todavía.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="audit-pagination">
          <span className="audit-pagination-count">{total.toLocaleString('es')} registro{total === 1 ? '' : 's'}</span>
          <div className="audit-pagination-nav">
            <button type="button" className="btn secondary small" disabled={page <= 1} onClick={() => setPage(1)} aria-label="Primera página">«</button>
            <button type="button" className="btn secondary small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Página anterior">‹</button>
            {pageNumbers[0] > 1 && <span className="audit-page-ellipsis">…</span>}
            {pageNumbers.map((n) => (
              <button type="button" key={n} className={`btn small ${n === page ? '' : 'secondary'}`} onClick={() => setPage(n)} aria-current={n === page ? 'page' : undefined}>{n}</button>
            ))}
            {pageNumbers[pageNumbers.length - 1] < totalPages && <span className="audit-page-ellipsis">…</span>}
            <button type="button" className="btn secondary small" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Página siguiente">›</button>
            <button type="button" className="btn secondary small" disabled={page >= totalPages} onClick={() => setPage(totalPages)} aria-label="Última página">»</button>
          </div>
        </div>
      )}
    </div>
  );
}
