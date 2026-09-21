import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Modal } from '../components/Modal';
import { PageHeader, PageShell, StatCard, StatGrid } from '../components/PageKit';
import '../styles/contacts.css';
import { Ui } from '../components/Ui';

interface DirContact {
  id: string; name: string | null; phone: string | null; email: string | null; avatarUrl: string | null;
  tags: string[]; createdAt: string; conversationId: string | null; crmStage: string | null;
}
interface Directory { contacts: DirContact[]; total: number; page: number; pages: number; tags: string[]; stats: { total: number; withName: number; withPhone: number } }

const CRM_STAGES = [
  { key: 'Abiertas', color: '#0284c7' }, { key: 'Pendientes', color: '#f59e0b' }, { key: 'Clientes', color: '#10b981' },
  { key: 'Interesados', color: '#8b5cf6' }, { key: 'Cerradas', color: '#64748b' }
];
const stageColor = (stage: string | null) => CRM_STAGES.find((s) => s.key === stage)?.color || '#64748b';

function formatPhone(phone: string | null) {
  if (!phone) return 'Sin teléfono';
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 8 ? `+${digits}` : phone;
}

export function ContactAvatar({ contact, size = 56 }: { contact: { name: string | null; phone: string | null; avatarUrl: string | null }; size?: number }) {
  const [broken, setBroken] = useState(false);
  const label = (contact.name || contact.phone || '?').trim();
  const initials = /^\+?\d/.test(label) ? '#' : label.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const hue = Array.from(label).reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  if (contact.avatarUrl && !broken) {
    return <img src={contact.avatarUrl} alt="" className="contact-avatar" style={{ width: size, height: size }} onError={() => setBroken(true)} loading="lazy" />;
  }
  return <span className="contact-avatar fallback" style={{ width: size, height: size, fontSize: size * 0.36, background: `hsl(${hue} 55% 42%)` }}>{initials}</span>;
}

export function Contacts() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const canDelete = user ? ['OWNER', 'ADMIN', 'SUPERVISOR'].includes(user.role) : false;
  const [data, setData] = useState<Directory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tag, setTag] = useState('');
  const [stage, setStage] = useState('');
  const [named, setNamed] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [edit, setEdit] = useState<DirContact | null>(null);
  const [remove, setRemove] = useState<DirContact | null>(null);
  const [syncing, setSyncing] = useState(false);
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => { const t = window.setTimeout(() => { setDebounced(query); setPage(1); }, 300); return () => window.clearTimeout(t); }, [query]);

  const flash = useCallback((text: string) => { setToast(text); window.clearTimeout(toastTimer.current); toastTimer.current = window.setTimeout(() => setToast(null), 3500); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '24' });
      if (debounced) params.set('q', debounced);
      if (tag) params.set('tag', tag);
      if (stage) params.set('stage', stage);
      if (named) params.set('named', '1');
      setData(await apiGet<Directory>(`/api/org/contacts/directory?${params}`));
      setError(null);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los contactos'); }
    finally { setLoading(false); }
  }, [page, debounced, tag, stage, named]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuFor]);

  async function sync() {
    setSyncing(true);
    try {
      const res = await apiPost<{ imported: number; updated: number; total: number }>('/api/org/whatsapp/sync-contacts');
      apiPost('/api/org/whatsapp/sync-avatars').catch(() => {});
      flash(`${res.imported} importados · ${res.updated} actualizados. Las fotos se cargan en segundo plano.`);
      await load();
    } catch (err) { flash(err instanceof ApiError ? err.message : 'No se pudo sincronizar'); }
    finally { setSyncing(false); }
  }

  async function sendToCrm(contact: DirContact, target: string) {
    setMenuFor(null);
    try { await apiPost(`/api/org/contacts/${contact.id}/crm`, { stage: target }); flash(`${contact.name || formatPhone(contact.phone)}: enviado a ${target}`); await load(); }
    catch (err) { flash(err instanceof ApiError ? err.message : 'No se pudo enviar al CRM'); }
  }

  async function confirmRemove() {
    if (!remove) return;
    try { await apiDelete(`/api/org/contacts/${remove.id}`); flash('Contacto eliminado'); setRemove(null); await load(); }
    catch (err) { flash(err instanceof ApiError ? err.message : 'No se pudo eliminar'); setRemove(null); }
  }

  const stats = data?.stats;
  const filtersActive = Boolean(tag || stage || named || debounced);
  const pageNumbers = useMemo(() => {
    if (!data) return [];
    const pages: number[] = [];
    for (let p = Math.max(1, data.page - 2); p <= Math.min(data.pages, data.page + 2); p += 1) pages.push(p);
    return pages;
  }, [data]);

  return (
    <PageShell>
      <PageHeader title="Contactos" subtitle="Todos los contactos de tu WhatsApp en un solo lugar: editá, etiquetá y enviá al CRM."
        actions={<>
          <button className="btn secondary" onClick={sync} disabled={syncing}>{syncing ? 'Sincronizando…' : <><Ui name="refresh" size={16} /> Sincronizar teléfono</>}</button>
          <a className="btn" href="/api/org/contacts/export.csv" download><Ui name="download" size={16} /> Descargar contactos</a>
        </>} />

      <StatGrid>
        <StatCard label="Contactos" value={stats?.total ?? '—'} hint="En tu cuenta" tone="primary" />
        <StatCard label="Con nombre" value={stats?.withName ?? '—'} hint="Guardados en tu agenda" tone="success" />
        <StatCard label="Con teléfono" value={stats?.withPhone ?? '—'} hint="Listos para campañas" tone="violet" />
        <StatCard label="Resultados" value={data?.total ?? '—'} hint={filtersActive ? 'Con los filtros aplicados' : 'Sin filtros'} tone="neutral" />
      </StatGrid>

      <div className="contacts-toolbar">
        <input className="input contacts-search" placeholder="Buscar por nombre, teléfono o email…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="input" value={stage} onChange={(e) => { setStage(e.target.value); setPage(1); }}>
          <option value="">Todas las etapas CRM</option>{CRM_STAGES.map((s) => <option key={s.key} value={s.key}>{s.key}</option>)}
        </select>
        <select className="input" value={tag} onChange={(e) => { setTag(e.target.value); setPage(1); }}>
          <option value="">Todas las etiquetas</option>{data?.tags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="contacts-check"><input type="checkbox" checked={named} onChange={(e) => { setNamed(e.target.checked); setPage(1); }} /> Solo con nombre</label>
      </div>

      {error && <div className="campaign-alert error">{error}</div>}
      {loading && !data ? <div className="contacts-empty">Cargando contactos…</div> : data && data.contacts.length === 0 ? (
        <div className="contacts-empty"><strong>No hay contactos{filtersActive ? ' con esos filtros' : ' todavía'}</strong><span>{filtersActive ? 'Probá quitando algún filtro.' : 'Sincronizá tu teléfono para traer los contactos de WhatsApp.'}</span></div>
      ) : (
        <div className={`contacts-grid ${loading ? 'is-loading' : ''}`}>
          {data?.contacts.map((c) => (
            <article key={c.id} className="contact-card">
              <div className="contact-card-top">
                <ContactAvatar contact={c} />
                <div className="contact-card-id">
                  <strong title={c.name || ''}>{c.name?.trim() || formatPhone(c.phone)}</strong>
                  <span>{c.name?.trim() ? formatPhone(c.phone) : 'Sin nombre guardado'}</span>
                  {c.email && <small title={c.email}>{c.email}</small>}
                </div>
                <div className="contact-menu-wrap">
                  <button type="button" className="contact-menu-btn" aria-label="Acciones" onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === c.id ? null : c.id); }}>⋮</button>
                  {menuFor === c.id && (
                    <div className="contact-menu" onClick={(e) => e.stopPropagation()}>
                      <button type="button" onClick={() => { setMenuFor(null); setEdit(c); }}><Ui name="edit" size={16} /> Editar contacto</button>
                      {c.conversationId && <button type="button" onClick={() => navigate(`/inbox?conversation=${c.conversationId}`)}><Ui name="chat" size={16} /> Abrir chat</button>}
                      <div className="contact-menu-label">Enviar al CRM</div>
                      {CRM_STAGES.map((s) => <button type="button" key={s.key} onClick={() => sendToCrm(c, s.key)}><i style={{ background: s.color }} /> {s.key}{c.crmStage === s.key && <Ui name="check" size={14} style={{ marginLeft: 'auto' }} />}</button>)}
                      {canDelete && <><div className="contact-menu-sep" /><button type="button" className="danger" onClick={() => { setMenuFor(null); setRemove(c); }}><Ui name="trash" size={16} /> Eliminar contacto</button></>}
                    </div>
                  )}
                </div>
              </div>
              <div className="contact-card-tags">
                {c.crmStage && <span className="contact-chip crm" style={{ borderColor: stageColor(c.crmStage), color: stageColor(c.crmStage) }}><Ui name="tag" size={12} /> {c.crmStage}</span>}
                {c.tags.slice(0, 3).map((t) => <span key={t} className="contact-chip"># {t}</span>)}
                {c.tags.length > 3 && <span className="contact-chip more">+{c.tags.length - 3}</span>}
              </div>
              <div className="contact-card-actions">
                <button type="button" className="btn secondary small" onClick={() => setEdit(c)}>Editar</button>
                <button type="button" className="btn small" onClick={() => sendToCrm(c, c.crmStage || 'Abiertas')}>{c.crmStage ? 'Ver en CRM' : 'Enviar a CRM'}</button>
              </div>
            </article>
          ))}
        </div>
      )}

      {data && data.pages > 1 && (
        <div className="contacts-pager">
          <button className="btn secondary small" disabled={page <= 1} onClick={() => setPage(page - 1)}><Ui name="arrow-left" size={14} /> Anterior</button>
          {pageNumbers.map((p) => <button key={p} className={`btn small ${p === data.page ? '' : 'secondary'}`} onClick={() => setPage(p)}>{p}</button>)}
          <button className="btn secondary small" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>Siguiente <Ui name="arrow-right" size={14} /></button>
          <span>{data.total} contactos</span>
        </div>
      )}

      {edit && <EditContactModal contact={edit} tagOptions={data?.tags || []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); flash('Contacto actualizado'); load(); }} />}
      {remove && (
        <Modal title="Eliminar contacto" onClose={() => setRemove(null)}>
          <p style={{ margin: '0 0 14px', fontSize: 14, lineHeight: 1.5 }}>¿Eliminar a <b>{remove.name || formatPhone(remove.phone)}</b>? También se borran sus conversaciones y mensajes. Esta acción no se puede deshacer.</p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button className="btn secondary" onClick={() => setRemove(null)}>Cancelar</button><button className="btn danger" onClick={confirmRemove}>Sí, eliminar</button></div>
        </Modal>
      )}
      {toast && <div className="contacts-toast">{toast}</div>}
    </PageShell>
  );
}

function EditContactModal({ contact, tagOptions, onClose, onSaved }: { contact: DirContact; tagOptions: string[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(contact.name || '');
  const [phone, setPhone] = useState(contact.phone || '');
  const [email, setEmail] = useState(contact.email || '');
  const [tags, setTags] = useState<string[]>(contact.tags);
  const [newTag, setNewTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addTag() {
    const value = newTag.trim().replace(/^#/, '').slice(0, 30);
    if (value && !tags.includes(value)) setTags([...tags, value]);
    setNewTag('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      await apiPatch(`/api/org/contacts/${contact.id}`, { name: name.trim() || undefined, phone: phone.replace(/[^\d+]/g, '') || undefined, email: email.trim() || '', tags });
      onSaved();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo guardar'); setBusy(false); }
  }

  const suggestions = tagOptions.filter((t) => !tags.includes(t)).slice(0, 8);
  return (
    <Modal title="Editar contacto" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <div className="contact-edit-head"><ContactAvatar contact={contact} size={64} /><span>La foto se toma de WhatsApp.</span></div>
        <label className="field"><span>Nombre</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus /></label>
        <label className="field"><span>Teléfono</span><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></label>
        <label className="field"><span>Email</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <div className="field"><span>Etiquetas</span>
          <div className="contact-tag-edit">{tags.map((t) => <span key={t} className="contact-chip">#{t}<button type="button" onClick={() => setTags(tags.filter((x) => x !== t))} aria-label={`Quitar ${t}`}>×</button></span>)}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}><input className="input" placeholder="Nueva etiqueta" value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} /><button type="button" className="btn secondary" onClick={addTag}>Agregar</button></div>
          {suggestions.length > 0 && <div className="contact-tag-edit" style={{ marginTop: 6 }}>{suggestions.map((t) => <button type="button" key={t} className="contact-chip suggest" onClick={() => setTags([...tags, t])}>+ {t}</button>)}</div>}
        </div>
        {error && <div className="campaign-alert error">{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn secondary" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy}>{busy ? 'Guardando…' : 'Guardar cambios'}</button></div>
      </form>
    </Modal>
  );
}
