import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useAlerts } from '../context/AlertContext';
import { EmptyState, LoadingRows, PageHeader, PageShell, Panel, Pill, StatCard, StatGrid, type Tone } from '../components/PageKit';
import { Modal } from '../components/Modal';
import { Ui } from '../components/Ui';
import { IconChart } from '../components/icons';
import { CategoryBars, ColumnChart, StackedAgentBars, dayLabel } from '../components/ManagementCharts';
import { KIND_COLOR, KIND_HELP, KIND_LABEL, formatGs, type ManagementSummary, type OutcomeCategory, type OutcomeKind, type OutcomeRow } from '../lib/management';
import type { OrgUser } from '../types';
import '../styles/management.css';

type Tab = 'overview' | 'movements' | 'categories';
type Preset = 'today' | '7d' | '30d' | 'month' | 'custom';

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Hoy' }, { key: '7d', label: '7 días' }, { key: '30d', label: '30 días' }, { key: 'month', label: 'Este mes' }, { key: 'custom', label: 'Fechas' }
];
const KIND_OPTIONS: { key: '' | OutcomeKind; label: string }[] = [
  { key: '', label: 'Todos' }, { key: 'WON', label: 'Ventas' }, { key: 'LOST', label: 'Perdidas' }, { key: 'QUOTE', label: 'Cotizaciones' }, { key: 'OTHER', label: 'Otras gestiones' }
];
const SWATCHES = ['#10b981', '#ef4444', '#0284c7', '#8b5cf6', '#f59e0b', '#ec4899', '#14b8a6', '#64748b'];
const PAGE = 25;
const DAY_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Asuncion', year: 'numeric', month: '2-digit', day: '2-digit' });

const startOfDay = (date: Date) => { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; };
const endOfDay = (date: Date) => { const d = new Date(date); d.setHours(23, 59, 59, 999); return d; };

function rangeFor(preset: Preset, from: string, to: string) {
  const now = new Date();
  if (preset === 'today') return { from: startOfDay(now), to: now };
  if (preset === '7d') return { from: startOfDay(new Date(now.getTime() - 6 * 86400000)), to: now };
  if (preset === 'month') return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
  if (preset === 'custom') return { from: from ? startOfDay(new Date(`${from}T00:00:00`)) : startOfDay(new Date(now.getTime() - 29 * 86400000)), to: to ? endOfDay(new Date(`${to}T00:00:00`)) : now };
  return { from: startOfDay(new Date(now.getTime() - 29 * 86400000)), to: now };
}

const dateTime = (value: string) => new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const pct = (value: number | null) => (value === null ? '—' : `${value.toLocaleString('es', { maximumFractionDigits: 1 })} %`);

export function Management() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const manager = Boolean(user && ['OWNER', 'ADMIN', 'SUPERVISOR'].includes(user.role));
  const admin = Boolean(user && ['OWNER', 'ADMIN'].includes(user.role));
  const [tab, setTab] = useState<Tab>('overview');
  const [preset, setPreset] = useState<Preset>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [agentId, setAgentId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [kind, setKind] = useState<'' | OutcomeKind>('');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [summary, setSummary] = useState<ManagementSummary | null>(null);
  const [categories, setCategories] = useState<OutcomeCategory[]>([]);
  const [agents, setAgents] = useState<OrgUser[]>([]);
  const [rows, setRows] = useState<OutcomeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { const timer = setTimeout(() => setDebouncedQ(q), 300); return () => clearTimeout(timer); }, [q]);

  const range = useMemo(() => rangeFor(preset, customFrom, customTo), [preset, customFrom, customTo]);
  const query = useMemo(() => {
    const params = new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString() });
    if (agentId) params.set('agentId', agentId);
    if (categoryId) params.set('categoryId', categoryId);
    if (kind) params.set('kind', kind);
    if (debouncedQ.trim()) params.set('q', debouncedQ.trim());
    return params;
  }, [range, agentId, categoryId, kind, debouncedQ]);

  const loadCategories = useCallback(() => apiGet<{ categories: OutcomeCategory[] }>(`/api/org/management/categories${admin ? '?all=1' : ''}`).then((d) => setCategories(d.categories)).catch(() => {}), [admin]);
  useEffect(() => { loadCategories(); }, [loadCategories]);
  useEffect(() => { if (manager) apiGet<{ users: OrgUser[] }>('/api/org/users').then((d) => setAgents(d.users.filter((u) => u.active))).catch(() => {}); }, [manager]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    return Promise.all([
      apiGet<ManagementSummary>(`/api/org/management/summary?${query}`).then(setSummary),
      apiGet<{ outcomes: OutcomeRow[]; total: number }>(`/api/org/management/outcomes?${query}&limit=${PAGE}&offset=${page * PAGE}`).then((d) => { setRows(d.outcomes); setTotal(d.total); })
    ]).catch((err) => setError(err instanceof ApiError ? err.message : 'No se pudo cargar la gestión')).finally(() => setLoading(false));
  }, [query, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [query]);

  const daily = useMemo(() => {
    if (!summary) return [];
    const byDay = new Map(summary.daily.map((d) => [d.day, d]));
    const keys: string[] = [];
    const seen = new Set<string>();
    for (let t = new Date(summary.range.from).getTime(); t <= new Date(summary.range.to).getTime() + 86400000 && keys.length < 120; t += 86400000) {
      const key = DAY_KEY.format(new Date(t));
      if (!seen.has(key)) { seen.add(key); keys.push(key); }
    }
    const last = DAY_KEY.format(new Date(summary.range.to));
    return keys.filter((k) => k <= last).map((key) => {
      const d = byDay.get(key);
      return { key, label: dayLabel(key), value: d?.revenue || 0, detail: d ? `${d.won} ${d.won === 1 ? 'venta' : 'ventas'} · ${d.outcomes} gestiones` : 'Sin gestiones' };
    });
  }, [summary]);

  const filtered = Boolean(agentId || categoryId || kind || q);
  const clearFilters = () => { setAgentId(''); setCategoryId(''); setKind(''); setQ(''); };
  const totals = summary?.totals;
  const csvHref = `/api/org/management/outcomes?${query}&format=csv`;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <PageShell>
      <PageHeader tone="indigo" hero={{ eyebrow: 'Gestión comercial', title: 'El trabajo de tu equipo, en números.', text: 'Ventas, cotizaciones y cierres por agente, con filtros por fecha, categoría y tipo.', features: [{ icon: 'users', label: 'Por agente' }, { icon: 'calendar', label: 'Por período' }, { icon: 'download', label: 'Exportación CSV' }], art: ['chart', 'crown', 'package'] }}
        icon={<IconChart />}
        title="Gestión"
        subtitle={manager ? 'Todo lo que hizo cada agente: ventas, cotizaciones, cierres y montos. Filtrá por fecha, agente, categoría o tipo.' : 'Tu gestión: ventas, cotizaciones y cierres que registraste.'}
        actions={<a className="btn secondary" href={csvHref}><Ui name="download" size={16} /> Exportar CSV</a>}
      />

      <nav className="mgmt-tabs" aria-label="Secciones de gestión">
        {([['overview', 'Resumen'], ['movements', 'Movimientos'], ...(admin ? [['categories', 'Categorías']] : [])] as [Tab, string][]).map(([key, label]) => (
          <button type="button" key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </nav>

      {tab !== 'categories' && (
        <div className="list-filters">
          <div className="list-filter-chips" role="tablist" aria-label="Período">
            {PRESETS.map((p) => <button type="button" key={p.key} role="tab" aria-selected={preset === p.key} className={`list-chip ${preset === p.key ? 'active' : ''}`} onClick={() => setPreset(p.key)}>{p.label}</button>)}
          </div>
          <div className="list-filter-row">
            {preset === 'custom' && <>
              <label className="list-filter-field"><span>Desde</span><input className="input" type="date" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)} /></label>
              <label className="list-filter-field"><span>Hasta</span><input className="input" type="date" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)} /></label>
            </>}
            {manager && <label className="list-filter-field"><span>Agente</span>
              <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}><option value="">Todos</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
            <label className="list-filter-field"><span>Categoría</span>
              <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">Todas</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.active ? '' : ' (inactiva)'}</option>)}</select></label>
            <label className="list-filter-field"><span>Tipo</span>
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value as '' | OutcomeKind)}>{KIND_OPTIONS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</select></label>
            <label className="list-filter-search"><Ui name="search" size={14} /><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar contacto, agente o nota…" aria-label="Buscar" /></label>
            {filtered && <button type="button" className="btn secondary small list-filter-clear" onClick={clearFilters}><Ui name="x" size={13} /> Limpiar filtros</button>}
          </div>
        </div>
      )}

      {error && <div className="alert error">{error}</div>}

      {tab === 'overview' && (
        <>
          <div className="mgmt-kpis"><StatGrid>
            <StatCard label="Ventas cerradas" value={loading ? '—' : totals?.won ?? 0} hint={totals ? `${pct(totals.winRate)} de cierre` : undefined} tone="success" />
            <StatCard label="Monto vendido" value={loading ? '—' : formatGs(totals?.revenue ?? 0)} hint="suma de las ventas cerradas" tone="primary" />
            <StatCard label="Ticket promedio" value={loading ? '—' : formatGs(totals?.avgTicket ?? 0)} hint="monto por venta" tone="violet" />
            <StatCard label="Cotizaciones" value={loading ? '—' : totals?.quotes ?? 0} hint="enviadas o entregadas" tone="primary" />
            <StatCard label="Ventas perdidas" value={loading ? '—' : totals?.lost ?? 0} hint="conversaciones sin cierre" tone="danger" />
            <StatCard label="Gestiones" value={loading ? '—' : totals?.outcomes ?? 0} hint={totals ? `${totals.closed} conversaciones cerradas` : undefined} tone="neutral" />
          </StatGrid></div>

          {loading && !summary ? <LoadingRows /> : summary && summary.totals.outcomes === 0 ? (
            <Panel><EmptyState icon={<IconChart />} title="Todavía no hay gestión en este período" text="Cuando los agentes cierren conversaciones o registren cotizaciones, van a aparecer acá con sus montos." /></Panel>
          ) : summary && (
            <>
              <div className="mgmt-grid">
                <Panel title="Monto vendido por día"><ColumnChart data={daily} /></Panel>
                <Panel title="Gestiones por categoría"><CategoryBars rows={summary.byCategory} onPick={(id) => setCategoryId(id)} /></Panel>
              </div>
              {manager && <Panel title="Resultado por agente"><StackedAgentBars rows={summary.byAgent.filter((a) => a.outcomes > 0)} onPick={(id) => setAgentId(id)} /></Panel>}
              <Panel flush title={manager ? 'Rendimiento por agente' : 'Tu rendimiento'}>
                <div className="page-table-wrap">
                  <table className="mgmt-table">
                    <thead><tr><th>Agente</th><th className="num">Gestiones</th><th className="num">Ventas</th><th className="num">Monto vendido</th><th className="num">Ticket prom.</th><th className="num">Perdidas</th><th className="num">Cotizaciones</th><th className="num">Cierre</th><th className="num">Chats atendidos</th><th className="num">Mensajes</th></tr></thead>
                    <tbody>
                      {summary.byAgent.map((a) => (
                        <tr key={a.agentId || a.name} className={manager && a.agentId ? 'is-clickable' : ''} onClick={() => manager && a.agentId && setAgentId(a.agentId)}>
                          <td><b>{a.name}</b></td><td className="num">{a.outcomes}</td><td className="num">{a.won}</td><td className="num strong">{formatGs(a.revenue)}</td><td className="num">{a.won ? formatGs(a.avgTicket) : '—'}</td>
                          <td className="num">{a.lost}</td><td className="num">{a.quotes}</td><td className="num">{pct(a.winRate)}</td><td className="num">{a.chats}</td><td className="num">{a.messages}</td>
                        </tr>
                      ))}
                      {summary.byAgent.length === 0 && <tr><td colSpan={10} className="mgmt-empty-cell">Sin agentes con actividad en este período.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </>
          )}
        </>
      )}

      {tab === 'movements' && (
        <Panel flush title={`Movimientos (${total})`}>
          {loading && rows.length === 0 ? <LoadingRows /> : rows.length === 0 ? <EmptyState icon={<IconChart />} title="Sin movimientos" text="No hay gestiones que coincidan con los filtros." /> : (
            <>
              <div className="page-table-wrap">
                <table className="mgmt-table">
                  <thead><tr><th>Fecha</th><th>Agente</th><th>Resultado</th><th className="num">Monto</th><th>Contacto</th><th>Nota</th><th></th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td>{dateTime(r.createdAt)}</td>
                        <td>{r.agentName}</td>
                        <td><span className="mgmt-cat"><i style={{ background: r.color || KIND_COLOR[r.kind] }} />{r.categoryName}</span>{r.closedConversation && <small className="mgmt-sub">Cerró la conversación</small>}</td>
                        <td className="num strong">{r.amount !== null ? formatGs(r.amount) : '—'}</td>
                        <td>{r.contact?.name || r.contact?.phone || '—'}{r.contact?.name && r.contact.phone && <small className="mgmt-sub">{r.contact.phone}</small>}</td>
                        <td className="mgmt-note">{r.note || '—'}</td>
                        <td><button type="button" className="btn secondary small" onClick={() => navigate(`/inbox?conversation=${r.conversationId}`)}>Abrir chat</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mgmt-pager">
                <span>Página {page + 1} de {pages}</span>
                <button type="button" className="btn secondary small" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Anterior</button>
                <button type="button" className="btn secondary small" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Siguiente</button>
              </div>
            </>
          )}
        </Panel>
      )}

      {tab === 'categories' && admin && <CategoriesPanel categories={categories} onChange={loadCategories} />}
    </PageShell>
  );
}

function kindTone(kind: OutcomeKind): Tone { return kind === 'WON' ? 'success' : kind === 'LOST' ? 'danger' : kind === 'QUOTE' ? 'primary' : 'neutral'; }

function CategoriesPanel({ categories, onChange }: { categories: OutcomeCategory[]; onChange: () => void }) {
  const { confirm, notify } = useAlerts();
  const [editing, setEditing] = useState<OutcomeCategory | 'new' | null>(null);

  async function remove(category: OutcomeCategory) {
    const used = category.used || 0;
    const ok = await confirm({
      title: 'Eliminar categoría',
      message: used > 0 ? `“${category.name}” ya se usó ${used} ${used === 1 ? 'vez' : 'veces'}. Se va a desactivar: deja de ofrecerse a los agentes pero las estadísticas conservan su historial.` : `¿Eliminar “${category.name}”? Todavía no se usó.`,
      confirmLabel: used > 0 ? 'Desactivar' : 'Eliminar',
      tone: 'danger'
    });
    if (!ok) return;
    try {
      const res = await apiDelete<{ deactivated: boolean }>(`/api/org/management/categories/${category.id}`);
      notify(res.deactivated ? 'Categoría desactivada.' : 'Categoría eliminada.', { tone: 'success' });
      onChange();
    } catch (err) { notify(err instanceof ApiError ? err.message : 'No se pudo eliminar', { tone: 'error' }); }
  }
  async function toggle(category: OutcomeCategory) {
    try { await apiPatch(`/api/org/management/categories/${category.id}`, { active: !category.active }); onChange(); }
    catch (err) { notify(err instanceof ApiError ? err.message : 'No se pudo actualizar', { tone: 'error' }); }
  }

  return (
    <Panel flush title="Categorías de cierre" actions={<button type="button" className="btn small" onClick={() => setEditing('new')}>＋ Nueva categoría</button>}>
      <p className="mgmt-help">Son las opciones que ve el agente al cerrar una conversación (venta cerrada, venta perdida, cotización enviada…). Las de tipo <b>Venta</b> piden el monto y alimentan las estadísticas de ventas.</p>
      <div className="page-table-wrap">
        <table className="mgmt-table">
          <thead><tr><th>Categoría</th><th>Tipo</th><th>Pide monto</th><th className="num">Usos</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                <td><span className="mgmt-cat"><i style={{ background: c.color }} />{c.name}</span></td>
                <td><Pill tone={kindTone(c.kind)}>{KIND_LABEL[c.kind]}</Pill></td>
                <td>{c.requiresAmount || c.kind === 'WON' ? 'Sí' : 'No'}</td>
                <td className="num">{c.used || 0}</td>
                <td><Pill tone={c.active ? 'success' : 'neutral'} dot>{c.active ? 'Activa' : 'Inactiva'}</Pill></td>
                <td className="mgmt-actions">
                  <button type="button" className="btn secondary small" onClick={() => setEditing(c)}>Editar</button>
                  <button type="button" className="btn secondary small" onClick={() => toggle(c)}>{c.active ? 'Desactivar' : 'Activar'}</button>
                  <button type="button" className="btn secondary small" onClick={() => remove(c)} aria-label={`Eliminar ${c.name}`}><Ui name="trash" size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <CategoryModal category={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChange(); }} />}
    </Panel>
  );
}

function CategoryModal({ category, onClose, onSaved }: { category: OutcomeCategory | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(category?.name || '');
  const [kind, setKind] = useState<OutcomeKind>(category?.kind || 'OTHER');
  const [color, setColor] = useState(category?.color || SWATCHES[2]);
  const [requiresAmount, setRequiresAmount] = useState(Boolean(category?.requiresAmount));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim().length < 2) { setError('Escribí un nombre (mínimo 2 letras).'); return; }
    setBusy(true); setError(null);
    try {
      const body = { name: name.trim(), kind, color, requiresAmount: kind === 'WON' ? true : requiresAmount };
      if (category) await apiPatch(`/api/org/management/categories/${category.id}`, body);
      else await apiPost('/api/org/management/categories', body);
      onSaved();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo guardar'); setBusy(false); }
  }

  return (
    <Modal title={category ? 'Editar categoría' : 'Nueva categoría'} onClose={onClose}>
      <form onSubmit={submit} className="outcome-form">
        <div className="field"><label htmlFor="cat-name">Nombre</label><input id="cat-name" className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Cotización aprobada" autoFocus /></div>
        <div className="field"><label htmlFor="cat-kind">Tipo (para las estadísticas)</label>
          <select id="cat-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as OutcomeKind)}>{(Object.keys(KIND_LABEL) as OutcomeKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
          <small className="area-help">{KIND_HELP[kind]}</small></div>
        {kind !== 'WON' && kind !== 'LOST' && (
          <label className="auto-chat-option"><input type="checkbox" checked={requiresAmount} onChange={(e) => setRequiresAmount(e.target.checked)} /><span><b>Pedir el monto obligatorio</b><small>Si está apagado, el agente puede cargar el monto o dejarlo vacío.</small></span></label>
        )}
        <div className="field"><label>Color</label>
          <div className="mgmt-swatches">{SWATCHES.map((s) => <button type="button" key={s} className={`mgmt-swatch ${s === color ? 'selected' : ''}`} style={{ background: s }} onClick={() => setColor(s)} aria-label={`Color ${s}`} aria-pressed={s === color} />)}
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Color personalizado" /></div></div>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="outcome-actions"><button type="button" className="btn secondary" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button></div>
      </form>
    </Modal>
  );
}
