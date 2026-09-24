import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost, ApiError } from '../lib/api';
import { EmptyState, LoadingRows, PageHeader, PageShell, Pill, StatCard, StatGrid } from '../components/PageKit';
import { Ui } from '../components/Ui';
import '../styles/groups.css';

interface Group {
  id: string; jid: string; name: string; description: string | null; ownerPhone: string | null; groupCreatedAt: string | null;
  announce: boolean; size: number; syncedAt: string; memberCount: number; admins: number; unidentified: number; avatarUrl: string | null;
}
interface Stats { groups: number; memberships: number; uniqueMembers: number; admins: number; unidentified: number; syncedAt: string | null }
interface Member { id: string; name: string | null; phone: string | null; lid: string | null; role: string | null; isSelf: boolean; phoneKnown: boolean; avatarUrl: string | null }

const fmtPhone = (phone: string | null) => (phone ? `+${phone}` : null);
const fmtDate = (value: string | null) => (value ? new Date(value).toLocaleString('es-PY', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function GroupAvatar({ name, src, round }: { name: string; src?: string | null; round?: boolean }) {
  const [broken, setBroken] = useState(false);
  const hue = Array.from(name).reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 11);
  const initials = name.split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || 'G';
  if (src && !broken) return <img src={src} alt="" className={`group-avatar-img ${round ? 'round' : ''}`} onError={() => setBroken(true)} loading="lazy" />;
  return <span className={`group-avatar ${round ? 'round' : ''}`} style={{ background: `hsl(${hue} 55% 42%)` }}>{initials}</span>;
}

export function Groups() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<'name' | 'size' | 'recent'>('name');
  const [openId, setOpenId] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, Member[]>>({});
  const [memberQuery, setMemberQuery] = useState('');
  const [memberFilter, setMemberFilter] = useState<'all' | 'admins' | 'pending'>('all');

  useEffect(() => { const t = setTimeout(() => setDebounced(query.trim()), 300); return () => clearTimeout(t); }, [query]);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ groups: Group[]; stats: Stats }>(`/api/org/groups${debounced ? `?q=${encodeURIComponent(debounced)}` : ''}`);
      setGroups(data.groups); setStats(data.stats); setError(null);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los grupos'); }
    finally { setLoading(false); }
  }, [debounced]);
  useEffect(() => { load(); }, [load]);

  async function sync() {
    setSyncing(true); setError(null);
    try {
      const res = await apiPost<{ groups?: number; members?: number; skipped?: boolean }>('/api/org/groups/sync', {});
      setMembers({});
      await load();
      setToast(res.skipped ? 'Ya hay una descarga en curso.' : `Descargados ${res.groups ?? 0} grupos con ${res.members ?? 0} integrantes.`);
      setTimeout(() => setToast(null), 4000);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo sincronizar'); }
    finally { setSyncing(false); }
  }

  async function toggle(group: Group) {
    if (openId === group.id) { setOpenId(null); return; }
    setOpenId(group.id); setMemberQuery(''); setMemberFilter('all');
    if (!members[group.id]) {
      try {
        const data = await apiGet<{ members: Member[] }>(`/api/org/groups/${group.id}/members`);
        setMembers((prev) => ({ ...prev, [group.id]: data.members }));
      } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los integrantes'); }
    }
  }

  const shown = useMemo(() => {
    const list = [...groups];
    if (sort === 'size') list.sort((a, b) => b.memberCount - a.memberCount);
    else if (sort === 'recent') list.sort((a, b) => String(b.groupCreatedAt || '').localeCompare(String(a.groupCreatedAt || '')));
    return list;
  }, [groups, sort]);

  function visibleMembers(groupId: string) {
    const q = memberQuery.trim().toLowerCase();
    return (members[groupId] || []).filter((m) => {
      if (memberFilter === 'admins' && !m.role) return false;
      if (memberFilter === 'pending' && m.phoneKnown) return false;
      return !q || (m.name || '').toLowerCase().includes(q) || (m.phone || '').includes(q.replace(/\D/g, '') || '__none__');
    });
  }

  async function copyPhones(groupId: string) {
    const phones = (members[groupId] || []).filter((m) => m.phone).map((m) => `+${m.phone}`).join('\n');
    try { await navigator.clipboard.writeText(phones); setToast('Números copiados.'); } catch { setToast('No se pudo copiar.'); }
    setTimeout(() => setToast(null), 3000);
  }

  const empty = !loading && groups.length === 0 && !debounced;

  return (
    <PageShell>
      <PageHeader tone="cyan" icon={<Ui name="users" size={22} />} hero={{ eyebrow: 'Centro de grupos', title: 'Tus comunidades, ordenadas.', text: 'Consultá los integrantes, filtrá y descargá las listas de todos tus grupos de WhatsApp.', features: [{ icon: 'users', label: 'Integrantes al día' }, { icon: 'search', label: 'Búsqueda rápida' }, { icon: 'download', label: 'Listas en CSV' }], art: ['users', 'chat', 'download'] }} title="Grupos de WhatsApp" subtitle="Todos tus grupos con sus integrantes: consultalos, filtralos y descargalos."
        actions={<>
          <button className="btn secondary" onClick={sync} disabled={syncing}>{syncing ? 'Descargando…' : <><Ui name="refresh" size={16} /> Sincronizar grupos</>}</button>
          <a className="btn secondary" href="/api/org/groups/export.csv?scope=groups" download><Ui name="download" size={16} /> Lista de grupos</a>
          <a className="btn" href="/api/org/groups/export.csv?scope=members" download><Ui name="download" size={16} /> Todos los integrantes</a>
        </>} />

      {error && <div className="alert error">{error}</div>}
      {toast && <div className="alert success">{toast}</div>}

      <StatGrid>
        <StatCard label="Grupos" value={stats?.groups ?? '—'} hint={stats?.syncedAt ? `Actualizado ${fmtDate(stats.syncedAt)}` : 'Sin sincronizar'} tone="primary" icon={<Ui name="users" size={18} />} />
        <StatCard label="Personas distintas" value={stats?.uniqueMembers ?? '—'} hint={`${stats?.memberships ?? 0} participaciones en total`} tone="success" icon={<Ui name="user" size={18} />} />
        <StatCard label="Administradores" value={stats?.admins ?? '—'} hint="Incluye a los creadores" tone="violet" icon={<Ui name="shield" size={18} />} />
        <StatCard label="Número por identificar" value={stats?.unidentified ?? '—'} hint="WhatsApp no entregó su teléfono" tone={stats && stats.unidentified > 0 ? 'warning' : 'neutral'} icon={<Ui name="info" size={18} />} />
      </StatGrid>

      {loading ? <LoadingRows rows={5} /> : empty ? (
        <EmptyState icon={<Ui name="users" size={28} />} title="Todavía no hay grupos descargados"
          text="Conectá tu WhatsApp y tocá “Sincronizar grupos”. También se descargan solos cada vez que la cuenta se conecta."
          action={<button className="btn" onClick={sync} disabled={syncing}>{syncing ? 'Descargando…' : 'Sincronizar grupos'}</button>} />
      ) : (
        <>
          <div className="groups-toolbar">
            <input className="input" placeholder="Buscar grupo, integrante o número…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select className="input" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="name">Ordenar: nombre</option><option value="size">Ordenar: más integrantes</option><option value="recent">Ordenar: más nuevos</option>
            </select>
          </div>
          <div className="groups-list">
            {shown.length === 0 && <div className="groups-none">Sin resultados para “{debounced}”.</div>}
            {shown.map((g) => (
              <Fragment key={g.id}>
                <div className={`group-row ${openId === g.id ? 'open' : ''}`}>
                  <button type="button" className="group-main" onClick={() => toggle(g)} aria-expanded={openId === g.id}>
                    <GroupAvatar name={g.name} src={g.avatarUrl} />
                    <span className="group-info"><strong>{g.name}</strong><small>{g.description ? g.description.slice(0, 90) : `Creado ${fmtDate(g.groupCreatedAt)}`}</small></span>
                    <span className="group-badges">
                      <Pill tone="primary">{g.memberCount} integrantes</Pill>
                      <Pill tone="violet">{g.admins} admins</Pill>
                      {g.unidentified > 0 && <Pill tone="warning">{g.unidentified} por identificar</Pill>}
                      {g.announce && <Pill tone="neutral">Solo admins escriben</Pill>}
                    </span>
                    <span className="group-chevron">{openId === g.id ? '▾' : '▸'}</span>
                  </button>
                  <a className="btn secondary small" href={`/api/org/groups/export.csv?scope=members&groupId=${g.id}`} download title="Descargar integrantes de este grupo"><Ui name="download" size={14} /> CSV</a>
                </div>
                {openId === g.id && (
                  <div className="group-detail">
                    {!members[g.id] ? <LoadingRows rows={3} /> : (
                      <>
                        <div className="group-detail-tools">
                          <input className="input" placeholder="Buscar en este grupo…" value={memberQuery} onChange={(e) => setMemberQuery(e.target.value)} />
                          <div className="group-filter">
                            {([['all', 'Todos'], ['admins', 'Admins'], ['pending', 'Por identificar']] as const).map(([key, label]) => (
                              <button key={key} type="button" className={memberFilter === key ? 'active' : ''} onClick={() => setMemberFilter(key)}>{label}</button>
                            ))}
                          </div>
                          <button type="button" className="btn secondary small" onClick={() => copyPhones(g.id)}><Ui name="copy" size={14} /> Copiar números</button>
                          <a className="btn secondary small" href={`/api/org/groups/export.csv?scope=members&groupId=${g.id}&onlyWithPhone=1`} download>Solo con teléfono</a>
                        </div>
                        <div className="group-members">
                          {visibleMembers(g.id).map((m) => (
                            <div className="group-member" key={m.id}>
                              <GroupAvatar name={m.name || m.phone || '?'} src={m.avatarUrl} round />
                              <span className="group-member-info">
                                <strong>{m.name || fmtPhone(m.phone) || 'Número por identificar'}{m.isSelf ? ' (vos)' : ''}</strong>
                                <small>{m.phone ? fmtPhone(m.phone) : 'WhatsApp no entregó el teléfono (identificador interno)'}</small>
                              </span>
                              {m.role === 'superadmin' && <Pill tone="warning">Creador</Pill>}
                              {m.role === 'admin' && <Pill tone="violet">Admin</Pill>}
                              {!m.phoneKnown && <Pill tone="neutral">Pendiente</Pill>}
                            </div>
                          ))}
                          {visibleMembers(g.id).length === 0 && <div className="groups-none">Sin integrantes con ese filtro.</div>}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </Fragment>
            ))}
          </div>
        </>
      )}
    </PageShell>
  );
}
