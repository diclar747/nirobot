import { FormEvent, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import type { Department, OrgUser } from '../types';
import { Modal } from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import { useAlerts } from '../context/AlertContext';
import { EmptyState, LoadingRows, PageHeader, PageShell, Panel, Pill, StatCard, StatGrid } from '../components/PageKit';
import { IconLayers, IconUsers } from '../components/icons';

export function OrgDepartments() {
  const { user: me } = useAuth();
  const { confirm } = useAlerts();
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Department | null>(null);
  const [managing, setManaging] = useState<Department | null>(null);

  const canManage = me ? ['OWNER', 'ADMIN'].includes(me.role) : false;

  async function load() {
    setLoading(true);
    try {
      const data = await apiGet<{ departments: Department[] }>('/api/org/departments');
      setDepartments(data.departments);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los departamentos');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function remove(dept: Department) {
    const accepted = await confirm({
      title: 'Eliminar departamento',
      message: `¿Querés eliminar el departamento "${dept.name}"? Esta acción no se puede deshacer.`,
      confirmLabel: 'Eliminar',
      tone: 'danger'
    });
    if (!accepted) return;
    try {
      await apiDelete(`/api/org/departments/${dept.id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo eliminar el departamento');
    }
  }

  const memberIds = new Set(departments.flatMap((d) => d.members.map((m) => m.id)));
  const emptyDepts = departments.filter((d) => d.members.length === 0).length;

  return (
    <PageShell>
      <PageHeader
        icon={<IconLayers />}
        title="Departamentos"
        subtitle="Organizá tu equipo por áreas (ventas, soporte, logística) para derivar conversaciones."
        actions={
          canManage && (
            <button className="btn" onClick={() => setShowCreate(true)}>
              + Nuevo departamento
            </button>
          )
        }
      />

      {error && <div className="alert error">{error}</div>}

      <StatGrid>
        <StatCard label="Departamentos" value={loading ? '—' : departments.length} hint="Áreas configuradas" icon={<IconLayers />} />
        <StatCard label="Miembros asignados" value={loading ? '—' : memberIds.size} hint="Usuarios en al menos un área" tone="success" icon={<IconUsers />} />
        <StatCard label="Sin miembros" value={loading ? '—' : emptyDepts} hint="Áreas que no reciben chats" tone="warning" icon={<IconLayers />} />
      </StatGrid>

      {loading ? (
        <Panel flush>
          <LoadingRows rows={3} />
        </Panel>
      ) : departments.length === 0 ? (
        <Panel>
          <EmptyState icon={<IconLayers />} title="Todavía no hay departamentos" text="Creá áreas como Ventas o Soporte para organizar la atención." />
        </Panel>
      ) : (
        <div className="page-card-grid">
          {departments.map((d) => (
            <div className="page-card" key={d.id}>
              <div className="row between" style={{ alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <h3 className="page-card-title">{d.name}</h3>
                  <p className="page-card-text">{d.description || 'Sin descripción'}</p>
                </div>
                <Pill tone={d.members.length ? 'success' : 'warning'}>
                  {d.members.length} {d.members.length === 1 ? 'miembro' : 'miembros'}
                </Pill>
              </div>

              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                {d.members.length === 0 ? (
                  <span className="page-muted" style={{ fontSize: 12.5 }}>Sin miembros asignados</span>
                ) : (
                  <>
                    <div className="page-avatar-stack">
                      {d.members.slice(0, 5).map((m) => (
                        <span key={m.id} className="page-person-avatar" title={m.name}>
                          {m.name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')}
                        </span>
                      ))}
                    </div>
                    <span className="page-muted" style={{ fontSize: 12.5 }}>
                      {d.members.map((m) => m.name.split(' ')[0]).join(', ')}
                    </span>
                  </>
                )}
              </div>

              {canManage && (
                <div className="page-card-footer">
                  <button className="btn secondary small" onClick={() => setManaging(d)}>
                    Miembros
                  </button>
                  <button className="btn secondary small" onClick={() => setEditing(d)}>
                    Editar
                  </button>
                  <button className="btn danger small" style={{ marginLeft: 'auto' }} onClick={() => remove(d)}>
                    Eliminar
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <DepartmentFormModal
          title="Nuevo departamento"
          onClose={() => setShowCreate(false)}
          onSubmit={async (data) => {
            await apiPost('/api/org/departments', data);
            setShowCreate(false);
            load();
          }}
        />
      )}

      {editing && (
        <DepartmentFormModal
          title={`Editar ${editing.name}`}
          initial={editing}
          onClose={() => setEditing(null)}
          onSubmit={async (data) => {
            await apiPatch(`/api/org/departments/${editing.id}`, data);
            setEditing(null);
            load();
          }}
        />
      )}

      {managing && (
        <ManageMembersModal
          department={managing}
          onClose={() => setManaging(null)}
          onChanged={() => {
            load();
          }}
        />
      )}
    </PageShell>
  );
}

function DepartmentFormModal({
  title,
  initial,
  onClose,
  onSubmit
}: {
  title: string;
  initial?: Department;
  onClose: () => void;
  onSubmit: (data: { name: string; description?: string }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({ name, description: description || undefined });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar el departamento');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      {error && <div className="alert error">{error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="dept-name">Nombre</label>
          <input id="dept-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="dept-desc">Descripción (opcional)</label>
          <input id="dept-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <button className="btn" type="submit" disabled={submitting} style={{ width: '100%', justifyContent: 'center' }}>
          {submitting ? 'Guardando…' : 'Guardar'}
        </button>
      </form>
    </Modal>
  );
}

function ManageMembersModal({
  department,
  onClose,
  onChanged
}: {
  department: Department;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [members, setMembers] = useState(department.members);
  const [allUsers, setAllUsers] = useState<OrgUser[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ users: OrgUser[] }>('/api/org/users')
      .then((data) => setAllUsers(data.users.filter((u) => u.active)))
      .catch(() => setAllUsers([]));
  }, []);

  const available = allUsers.filter((u) => !members.some((m) => m.id === u.id));

  async function addMember() {
    if (!selected) return;
    setError(null);
    try {
      await apiPost(`/api/org/departments/${department.id}/members`, { userId: selected });
      const user = allUsers.find((u) => u.id === selected);
      if (user) setMembers((prev) => [...prev, { id: user.id, name: user.name, email: user.email }]);
      setSelected('');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo agregar el miembro');
    }
  }

  async function removeMember(userId: string) {
    setError(null);
    try {
      await apiDelete(`/api/org/departments/${department.id}/members/${userId}`);
      setMembers((prev) => prev.filter((m) => m.id !== userId));
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo quitar el miembro');
    }
  }

  return (
    <Modal title={`Miembros de ${department.name}`} onClose={onClose}>
      {error && <div className="alert error">{error}</div>}
      <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
        {members.map((m) => (
          <div className="row between" key={m.id}>
            <span>
              {m.name} <span className="muted">({m.email})</span>
            </span>
            <button className="btn danger small" onClick={() => removeMember(m.id)}>
              Quitar
            </button>
          </div>
        ))}
        {members.length === 0 && <span className="muted">Sin miembros todavía.</span>}
      </div>
      <div className="row">
        <select className="input" value={selected} onChange={(e) => setSelected(e.target.value)} style={{ flex: 1 }}>
          <option value="">Agregar usuario…</option>
          {available.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} ({u.email})
            </option>
          ))}
        </select>
        <button className="btn secondary" onClick={addMember} disabled={!selected}>
          Agregar
        </button>
      </div>
    </Modal>
  );
}
