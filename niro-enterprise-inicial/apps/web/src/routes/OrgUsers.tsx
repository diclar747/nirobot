import { FormEvent, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import type { OrgUser, UserRole } from '../types';
import { Modal } from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import { useAlerts } from '../context/AlertContext';
import { EmptyState, LoadingRows, PageHeader, PageShell, Panel, PersonCell, Pill, StatCard, StatGrid, type Tone } from '../components/PageKit';
import { IconUsers } from '../components/icons';
import { Link } from 'react-router-dom';
import type { SeatInfo } from '../components/BillingGate';
import type { PermissionDef } from '../lib/permissions';
import type { Department } from '../types';
import { Ui } from '../components/Ui';

const ROLE_LABEL: Record<UserRole, string> = {
  SUPERADMIN: 'Superadmin',
  OWNER: 'Propietario',
  ADMIN: 'Administrador',
  SUPERVISOR: 'Supervisor',
  AGENT: 'Agente'
};

const ROLE_TONE: Record<UserRole, Tone> = {
  SUPERADMIN: 'danger',
  OWNER: 'violet',
  ADMIN: 'primary',
  SUPERVISOR: 'warning',
  AGENT: 'success'
};

// Roles que se pueden asignar a un empleado. El propietario es la cuenta principal (una sola) y el superadmin
// pertenece a la plataforma: ninguno de los dos se crea desde acá.
const ASSIGNABLE_ROLES: { key: UserRole; label: string; help: string }[] = [
  { key: 'AGENT', label: 'Agente', help: 'Atiende los chats de sus áreas.' },
  { key: 'SUPERVISOR', label: 'Supervisor', help: 'Como agente, y además ve todos los chats, reportes y usuarios.' },
  { key: 'ADMIN', label: 'Administrador', help: 'Acceso total a la cuenta (usuarios, configuración y plan).' }
];

function AreaPicker({ departments, value, onChange }: { departments: Department[]; value: string[]; onChange: (ids: string[]) => void }) {
  if (departments.length === 0) {
    return <div className="area-empty">Todavía no hay áreas. <Link to="/departments">Creá la primera</Link> (por ejemplo Caja, Depósito, Soporte, Recursos Humanos) y después asignale personas.</div>;
  }
  return (
    <div className="area-picker" role="group" aria-label="Áreas del usuario">
      {departments.map((d) => {
        const on = value.includes(d.id);
        return (
          <button type="button" key={d.id} className={`area-chip ${on ? 'on' : ''}`} onClick={() => onChange(on ? value.filter((x) => x !== d.id) : [...value, d.id])} aria-pressed={on}>
            {on && <Ui name="check" size={13} />} {d.name}
          </button>
        );
      })}
    </div>
  );
}

function formatWhatsAppPhone(value: string | null | undefined) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('595') && digits.length === 12) {
    return `+595 ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  }
  return `+${digits}`;
}

function userDisplayName(user: OrgUser) {
  if (user.whatsapp?.name) return user.whatsapp.name;
  if (user.whatsapp) return user.name.replace(/\s+\d{6,}\s*$/, '') || 'Administrador';
  return user.name;
}

export function OrgUsers() {
  const { user: me } = useAuth();
  const { confirm } = useAlerts();
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<OrgUser | null>(null);
  const [seats, setSeats] = useState<SeatInfo | null>(null);
  const [secret, setSecret] = useState<{ email: string; temporaryPassword?: string; phone?: string; whatsapp?: { sent: boolean; error?: string } | null } | null>(null);

  const canManage = me ? ['OWNER', 'ADMIN'].includes(me.role) : false;
  const canGrantOwner = me?.role === 'OWNER';

  async function load() {
    setLoading(true);
    try {
      const data = await apiGet<{ users: OrgUser[] }>('/api/org/users');
      setUsers(data.users);
      apiGet<{ seats?: SeatInfo | null }>('/api/org/billing/status').then((res) => setSeats(res.seats || null)).catch(() => {});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los usuarios');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function resetPassword(u: OrgUser) {
    setError(null);
    try {
      const data = await apiPost<{ temporaryPassword: string }>(`/api/org/users/${u.id}/reset-password`);
      setSecret({ email: u.email, temporaryPassword: data.temporaryPassword });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo restablecer la contraseña');
    }
  }

  async function removeUser(u: OrgUser) {
    const accepted = await confirm({
      title: 'Eliminar usuario',
      message: `¿Eliminar a ${userDisplayName(u)}? Esta acción no se puede deshacer. Sus chats y mensajes se conservan pero quedan sin asignar.`,
      confirmLabel: 'Eliminar',
      tone: 'danger'
    });
    if (!accepted) return;
    setError(null);
    try {
      await apiDelete(`/api/org/users/${u.id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo eliminar el usuario');
    }
  }

  const activeCount = users.filter((u) => u.active).length;
  const agentCount = users.filter((u) => u.role === 'AGENT').length;
  const pendingCount = users.filter((u) => u.mustChangePassword).length;

  return (
    <PageShell>
      <PageHeader tone="indigo" hero={{ eyebrow: 'Tu equipo', title: 'Cada persona, con el acceso justo.', text: 'Sumá agentes, asigná roles y controlá quién está activo.', features: [{ icon: 'user-plus', label: 'Altas en segundos' }, { icon: 'shield', label: 'Roles y permisos' }, { icon: 'check-circle', label: 'Estado de cada usuario' }], art: ['users', 'shield', 'user-plus'] }}
        icon={<IconUsers />}
        title="Usuarios y equipo"
        subtitle="Gestioná accesos, roles y estado de tu equipo de ventas y atención."
        actions={
          canManage && (
            seats?.full ? (
              <Link className="btn secondary" to="/billing" title="Llegaste al límite de agentes de tu plan"><Ui name="upgrade" size={16} /> Mejorar plan para sumar agentes</Link>
            ) : (
              <button className="btn" onClick={() => setShowCreate(true)}>
                + Nuevo usuario
              </button>
            )
          )
        }
      />

      {error && <div className="alert error">{error}</div>}
      {seats && (
        <div className={`alert ${seats.full ? 'error' : ''}`} style={{ marginBottom: 12 }}>
          <Ui name="users" size={16} /> Agentes en uso: <b>{seats.agentsUsed}</b> de <b>{seats.maxAgents}</b>{seats.planName ? ` · ${seats.planName}` : ''}.
          {seats.full ? <> Llegaste al límite. <Link to="/billing">Mejorá tu plan</Link> para sumar más.</> : ` Te quedan ${Math.max(0, seats.maxAgents - seats.agentsUsed)}.`}
        </div>
      )}

      <StatGrid>
        <StatCard label="Total usuarios" value={loading ? '—' : users.length} hint="Miembros de la organización" icon={<IconUsers />} />
        <StatCard label="Activos" value={loading ? '—' : activeCount} hint="Con acceso habilitado" tone="success" icon={<IconUsers />} />
        <StatCard label="Agentes de venta" value={loading ? '—' : agentCount} hint="Rol AGENT" tone="violet" icon={<IconUsers />} />
        <StatCard label="Pendientes 1er login" value={loading ? '—' : pendingCount} hint="Deben cambiar contraseña" tone="warning" icon={<IconUsers />} />
      </StatGrid>

      <Panel flush title="Listado de usuarios">
        {loading ? (
          <LoadingRows />
        ) : users.length === 0 ? (
          <EmptyState icon={<IconUsers />} title="Todavía no hay usuarios" text="Creá el primer usuario para empezar a atender clientes." />
        ) : (
          <div className="page-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th>Rol</th>
                  <th>Áreas</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <PersonCell
                        name={userDisplayName(u)}
                        detail={u.whatsapp ? formatWhatsAppPhone(u.whatsapp.phone) || 'WhatsApp conectado' : u.email}
                        avatarUrl={u.whatsapp?.avatarUrl}
                      />
                    </td>
                    <td>
                      <Pill tone={ROLE_TONE[u.role]}>{ROLE_LABEL[u.role]}</Pill>
                      {u.role === 'AGENT' && u.autoChat && <span style={{ marginLeft: 6 }}><Pill tone="primary">Auto chat</Pill></span>}
                    </td>
                    <td>
                      {['OWNER', 'ADMIN', 'SUPERVISOR'].includes(u.role) ? <span className="area-all">Todas</span> : (u.departments || []).length === 0 ? <span className="area-none">Sin área</span> : <span className="area-list">{(u.departments || []).map((d) => <span key={d.id} className="area-tag">{d.name}</span>)}</span>}
                    </td>
                    <td>
                      <Pill tone={u.active ? 'success' : 'danger'} dot>
                        {u.active ? 'Activo' : 'Inactivo'}
                      </Pill>
                      {u.mustChangePassword && (
                        <span style={{ marginLeft: 6 }}>
                          <Pill tone="warning">Pendiente 1er login</Pill>
                        </span>
                      )}
                    </td>
                    <td className="actions">
                      {canManage && (u.role !== 'OWNER' || canGrantOwner) && (
                        <>
                          <button className="btn secondary small" onClick={() => setEditing(u)}>
                            Editar
                          </button>
                          <button className="btn secondary small" onClick={() => resetPassword(u)}>
                            Resetear contraseña
                          </button>
                          {u.id !== me?.id && (
                            <button className="btn secondary small" style={{ color: 'var(--danger)' }} onClick={() => removeUser(u)}>
                              Eliminar
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {showCreate && (
        <CreateUserModal
          canGrantOwner={canGrantOwner}
          onClose={() => setShowCreate(false)}
          onCreated={(result) => {
            setShowCreate(false);
            if (result) setSecret(result);
            load();
          }}
        />
      )}

      {editing && (
        <EditUserModal
          user={editing}
          canGrantOwner={canGrantOwner}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      {secret && (
        <Modal title="Contraseña temporal" onClose={() => setSecret(null)}>
          {secret.temporaryPassword && (
            <>
              <p>
                Para <strong>{secret.email}</strong>. Se le pedirá cambiarla en el próximo inicio de sesión — compartila de forma
                segura, no volverá a mostrarse.
              </p>
              <code className="secret">{secret.temporaryPassword}</code>
            </>
          )}
          {secret.whatsapp && (
            <p style={{ marginTop: secret.temporaryPassword ? 12 : 0 }}>
              {secret.whatsapp.sent
                ? <>✅ Le mandamos un WhatsApp de bienvenida a <strong>{formatWhatsAppPhone(secret.phone)}</strong> con su usuario y contraseña.</>
                : <>⚠️ No se pudo enviar el WhatsApp de bienvenida ({secret.whatsapp.error}). Pasale los datos a mano.</>}
            </p>
          )}
        </Modal>
      )}
    </PageShell>
  );
}

function CreateUserModal({
  canGrantOwner,
  onClose,
  onCreated
}: {
  canGrantOwner: boolean;
  onClose: () => void;
  onCreated: (secret: { email: string; temporaryPassword?: string; phone?: string; whatsapp?: { sent: boolean; error?: string } | null } | null) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<UserRole>('AGENT');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [autoChat, setAutoChat] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const roleOptions = ASSIGNABLE_ROLES;
  void canGrantOwner;
  useEffect(() => { apiGet<{ departments: Department[] }>('/api/org/departments').then((d) => setDepartments(d.departments)).catch(() => {}); }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const cleanPhone = phone.trim();
      const data = await apiPost<{ temporaryPassword?: string; whatsappWelcome?: { sent: boolean; error?: string } | null }>('/api/org/users', {
        name, email, role, ...(cleanPhone ? { phone: cleanPhone } : {}), ...(role === 'AGENT' ? { departmentIds, autoChat } : {})
      });
      onCreated(
        data.temporaryPassword || data.whatsappWelcome
          ? { email, temporaryPassword: data.temporaryPassword, phone: cleanPhone || undefined, whatsapp: data.whatsappWelcome }
          : null
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear el usuario');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Nuevo usuario" onClose={onClose}>
      {error && <div className="alert error">{error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="user-name">Nombre</label>
          <input id="user-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="user-email">Email</label>
          <input
            id="user-email"
            type="email"
            className="input"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="user-phone">WhatsApp (opcional)</label>
          <input
            id="user-phone"
            type="tel"
            className="input"
            placeholder="Ej: 595981234567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <small className="area-help">Si lo completás, le mandamos por WhatsApp la bienvenida con su usuario, contraseña y el link para entrar.</small>
        </div>
        <div className="field">
          <label htmlFor="user-role">Rol</label>
          <select id="user-role" className="input" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            {roleOptions.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
          <small className="area-help">{roleOptions.find((r) => r.key === role)?.help}</small>
        </div>
        {role === 'AGENT' && (
          <div className="field">
            <label>Áreas donde trabaja</label>
            <AreaPicker departments={departments} value={departmentIds} onChange={setDepartmentIds} />
            <small className="area-help">Verá los chats de estas áreas y los que le asignen. Podés cambiarlo cuando quieras.</small>
          </div>
        )}
        {role === 'AGENT' && (
          <label className="auto-chat-option">
            <input type="checkbox" checked={autoChat} onChange={(e) => setAutoChat(e.target.checked)} />
            <span><b>Auto chat</b><small>Recibe automáticamente todos los chats nuevos y puede responderlos, sin que un administrador se los transfiera. Si lo dejás apagado, solo verá los chats que le transfieran o asignen (y los de sus áreas).</small></span>
          </label>
        )}
        <button className="btn" type="submit" disabled={submitting} style={{ width: '100%', justifyContent: 'center' }}>
          {submitting ? 'Creando…' : 'Crear usuario'}
        </button>
      </form>
    </Modal>
  );
}

function EditUserModal({
  user,
  canGrantOwner,
  onClose,
  onSaved
}: {
  user: OrgUser;
  canGrantOwner: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(user.name);
  const [phone, setPhone] = useState(user.phone || '');
  const [role, setRole] = useState<UserRole>(user.role);
  const [active, setActive] = useState(user.active);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentIds, setDepartmentIds] = useState<string[]>((user.departments || []).map((d) => d.id));
  const [autoChat, setAutoChat] = useState(Boolean(user.autoChat));
  const [defs, setDefs] = useState<PermissionDef[]>([]);
  const [perms, setPerms] = useState<Record<string, boolean>>(() => ({ ...(user.permissions || {}) }));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const restrictable = role === 'AGENT' || role === 'SUPERVISOR';
  useEffect(() => { apiGet<{ permissions: PermissionDef[] }>('/api/org/permissions').then((r) => setDefs(r.permissions)).catch(() => {}); apiGet<{ departments: Department[] }>('/api/org/departments').then((r) => setDepartments(r.departments)).catch(() => {}); }, []);
  const isOn = (key: string) => perms[key] !== false;
  const disabledCount = defs.filter((d) => !isOn(d.key)).length;
  const groups = Array.from(new Set(defs.map((d) => d.group)));
  const roleOptions: { key: UserRole; label: string }[] = user.role === 'OWNER' ? [{ key: 'OWNER', label: 'Propietario' }] : ASSIGNABLE_ROLES;
  void canGrantOwner;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const cleanPhone = phone.trim();
      await apiPatch(`/api/org/users/${user.id}`, { name, role, active, phone: cleanPhone || null, ...(role === 'AGENT' ? { autoChat } : {}), ...(restrictable ? { departmentIds } : {}), ...(restrictable && defs.length ? { permissions: Object.fromEntries(defs.map((d) => [d.key, isOn(d.key)])) } : {}) });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar el usuario');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Editar ${user.name}`} onClose={onClose} className="perm-modal">
      {error && <div className="alert error">{error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="edit-name">Nombre</label>
          <input id="edit-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="edit-phone">WhatsApp</label>
          <input
            id="edit-phone"
            type="tel"
            className="input"
            placeholder="Ej: 595981234567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="edit-role">Rol</label>
          <select id="edit-role" className="input" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            {roleOptions.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        {restrictable && (
          <div className="field">
            <label>Áreas donde trabaja</label>
            <AreaPicker departments={departments} value={departmentIds} onChange={setDepartmentIds} />
            <small className="area-help">Verá los chats de estas áreas y los que le asignen.</small>
          </div>
        )}
        {role === 'AGENT' && (
          <label className="auto-chat-option">
            <input type="checkbox" checked={autoChat} onChange={(e) => setAutoChat(e.target.checked)} />
            <span><b>Auto chat</b><small>Recibe automáticamente todos los chats nuevos y puede responderlos, sin que un administrador se los transfiera. Si lo dejás apagado, solo verá los chats que le transfieran o asignen (y los de sus áreas).</small></span>
          </label>
        )}
        <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input id="edit-active" type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <label htmlFor="edit-active" style={{ textTransform: 'none', fontSize: 14 }}>
            Usuario activo
          </label>
        </div>
        {restrictable ? (
          <div className="perm-panel">
            <div className="perm-head">
              <div><strong>Permisos de este usuario</strong><small>{disabledCount === 0 ? 'Tiene todas las funciones activas.' : `${disabledCount} función${disabledCount > 1 ? 'es' : ''} desactivada${disabledCount > 1 ? 's' : ''}.`}</small></div>
              <button type="button" className="btn secondary small" onClick={() => setPerms({})} disabled={disabledCount === 0}>Activar todo</button>
            </div>
            {groups.map((group) => (
              <div key={group} className="perm-group">
                <span className="perm-group-title">{group}</span>
                {defs.filter((d) => d.group === group).map((d) => (
                  <label key={d.key} className={`perm-row ${isOn(d.key) ? 'on' : 'off'}`}>
                    <span><b>{d.label}</b><small>{d.description}</small></span>
                    <input type="checkbox" role="switch" checked={isOn(d.key)} onChange={(e) => setPerms((prev) => ({ ...prev, [d.key]: e.target.checked }))} />
                  </label>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <p className="perm-note"><Ui name="crown" size={16} /> Los propietarios y administradores siempre tienen todas las funciones.</p>
        )}
        <button className="btn" type="submit" disabled={submitting} style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}>
          {submitting ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </form>
    </Modal>
  );
}
