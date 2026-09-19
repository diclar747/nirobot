import { FormEvent, useEffect, useState } from 'react';
import { apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import type { OrgUser, UserRole } from '../types';
import { ORG_ROLES } from '../types';
import { Modal } from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import { EmptyState, LoadingRows, PageHeader, PageShell, Panel, PersonCell, Pill, StatCard, StatGrid, type Tone } from '../components/PageKit';
import { IconUsers } from '../components/icons';

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
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<OrgUser | null>(null);
  const [secret, setSecret] = useState<{ email: string; temporaryPassword: string } | null>(null);

  const canManage = me ? ['OWNER', 'ADMIN'].includes(me.role) : false;
  const canGrantOwner = me?.role === 'OWNER';

  async function load() {
    setLoading(true);
    try {
      const data = await apiGet<{ users: OrgUser[] }>('/api/org/users');
      setUsers(data.users);
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

  const activeCount = users.filter((u) => u.active).length;
  const agentCount = users.filter((u) => u.role === 'AGENT').length;
  const pendingCount = users.filter((u) => u.mustChangePassword).length;

  return (
    <PageShell>
      <PageHeader
        icon={<IconUsers />}
        title="Usuarios y equipo"
        subtitle="Gestioná accesos, roles y estado de tu equipo de ventas y atención."
        actions={
          canManage && (
            <button className="btn" onClick={() => setShowCreate(true)}>
              + Nuevo usuario
            </button>
          )
        }
      />

      {error && <div className="alert error">{error}</div>}

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
          <p>
            Para <strong>{secret.email}</strong>. Se le pedirá cambiarla en el próximo inicio de sesión — compartila de forma
            segura, no volverá a mostrarse.
          </p>
          <code className="secret">{secret.temporaryPassword}</code>
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
  onCreated: (secret: { email: string; temporaryPassword: string } | null) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('AGENT');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const roleOptions = ORG_ROLES.filter((r) => r !== 'OWNER' || canGrantOwner);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const data = await apiPost<{ temporaryPassword?: string }>('/api/org/users', { name, email, role });
      onCreated(data.temporaryPassword ? { email, temporaryPassword: data.temporaryPassword } : null);
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
          <label htmlFor="user-role">Rol</label>
          <select id="user-role" className="input" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            {roleOptions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
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
  const [role, setRole] = useState<UserRole>(user.role);
  const [active, setActive] = useState(user.active);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const roleOptions = ORG_ROLES.filter((r) => r !== 'OWNER' || canGrantOwner || user.role === 'OWNER');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiPatch(`/api/org/users/${user.id}`, { name, role, active });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar el usuario');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Editar ${user.name}`} onClose={onClose}>
      {error && <div className="alert error">{error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="edit-name">Nombre</label>
          <input id="edit-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="edit-role">Rol</label>
          <select id="edit-role" className="input" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            {roleOptions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input id="edit-active" type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <label htmlFor="edit-active" style={{ textTransform: 'none', fontSize: 14 }}>
            Usuario activo
          </label>
        </div>
        <button className="btn" type="submit" disabled={submitting} style={{ width: '100%', justifyContent: 'center' }}>
          {submitting ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </form>
    </Modal>
  );
}
