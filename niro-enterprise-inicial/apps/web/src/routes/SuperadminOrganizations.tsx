import { FormEvent, useEffect, useState } from 'react';
import { apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import type { OrganizationSummary } from '../types';
import { Modal } from '../components/Modal';
import { EmptyState, LoadingRows, PageHeader, PageShell, Panel, PersonCell, Pill, StatCard, StatGrid } from '../components/PageKit';
import { IconBuilding, IconUsers } from '../components/icons';

export function SuperadminOrganizations() {
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<{ email: string; temporaryPassword: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const data = await apiGet<{ organizations: OrganizationSummary[] }>('/api/superadmin/organizations');
      setOrganizations(data.organizations);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron cargar las organizaciones');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleActive(org: OrganizationSummary) {
    try {
      await apiPatch(`/api/superadmin/organizations/${org.id}`, { active: !org.active });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo actualizar la organización');
    }
  }

  const activeOrgs = organizations.filter((o) => o.active).length;
  const totalUsers = organizations.reduce((n, o) => n + (o.userCount ?? 0), 0);

  return (
    <PageShell>
      <PageHeader
        icon={<IconBuilding />}
        title="Organizaciones"
        subtitle="Empresas clientes de la plataforma, sus planes y estado de servicio."
        actions={
          <button className="btn" onClick={() => setShowCreate(true)}>
            + Nueva organización
          </button>
        }
      />

      {error && <div className="alert error">{error}</div>}

      <StatGrid>
        <StatCard label="Organizaciones" value={loading ? '—' : organizations.length} hint="Registradas" icon={<IconBuilding />} />
        <StatCard label="Activas" value={loading ? '—' : activeOrgs} hint="Con servicio habilitado" tone="success" icon={<IconBuilding />} />
        <StatCard label="Suspendidas" value={loading ? '—' : organizations.length - activeOrgs} hint="Sin acceso" tone="danger" icon={<IconBuilding />} />
        <StatCard label="Usuarios totales" value={loading ? '—' : totalUsers} hint="En todas las empresas" tone="violet" icon={<IconUsers />} />
      </StatGrid>

      <Panel flush title="Listado de organizaciones">
        {loading ? (
          <LoadingRows />
        ) : organizations.length === 0 ? (
          <EmptyState icon={<IconBuilding />} title="Todavía no hay organizaciones" text="Creá la primera empresa cliente." />
        ) : (
          <div className="page-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Organización</th>
                  <th>Plan</th>
                  <th className="num">Usuarios</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {organizations.map((org) => (
                  <tr key={org.id}>
                    <td>
                      <PersonCell name={org.name} detail={org.slug} />
                    </td>
                    <td>
                      <Pill tone="violet">{org.planTier}</Pill>
                    </td>
                    <td className="num">
                      {org.userCount ?? 0} / {org.maxUsers}
                    </td>
                    <td>
                      <Pill tone={org.active ? 'success' : 'danger'} dot>
                        {org.active ? 'Activa' : 'Suspendida'}
                      </Pill>
                    </td>
                    <td className="actions">
                      <button className="btn secondary small" onClick={() => toggleActive(org)}>
                        {org.active ? 'Suspender' : 'Activar'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {showCreate && (
        <CreateOrganizationModal
          onClose={() => setShowCreate(false)}
          onCreated={(owner) => {
            setShowCreate(false);
            setCreated(owner);
            load();
          }}
        />
      )}

      {created && (
        <Modal title="Organización creada" onClose={() => setCreated(null)}>
          <p>
            Contraseña temporal para <strong>{created.email}</strong>. Se pide cambiarla en el primer inicio de sesión —
            compartila de forma segura, no volverá a mostrarse.
          </p>
          <code className="secret">{created.temporaryPassword}</code>
        </Modal>
      )}
    </PageShell>
  );
}

function CreateOrganizationModal({
  onClose,
  onCreated
}: {
  onClose: () => void;
  onCreated: (owner: { email: string; temporaryPassword: string }) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [maxUsers, setMaxUsers] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const data = await apiPost<{ owner: { email: string; temporaryPassword: string } }>('/api/superadmin/organizations', {
        name,
        slug,
        ownerName,
        ownerEmail,
        maxUsers
      });
      onCreated(data.owner);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear la organización');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Nueva organización" onClose={onClose}>
      {error && <div className="alert error">{error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="org-name">Nombre de la empresa</label>
          <input id="org-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="org-slug">Slug (identificador único)</label>
          <input
            id="org-slug"
            className="input"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            placeholder="mi-empresa"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="owner-name">Nombre del propietario</label>
          <input id="owner-name" className="input" required value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="owner-email">Email del propietario</label>
          <input
            id="owner-email"
            type="email"
            className="input"
            required
            value={ownerEmail}
            onChange={(e) => setOwnerEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="max-users">Límite de usuarios del plan</label>
          <input
            id="max-users"
            type="number"
            min={1}
            className="input"
            value={maxUsers}
            onChange={(e) => setMaxUsers(Number(e.target.value))}
          />
        </div>
        <button className="btn" type="submit" disabled={submitting} style={{ width: '100%', justifyContent: 'center' }}>
          {submitting ? 'Creando…' : 'Crear organización'}
        </button>
      </form>
    </Modal>
  );
}
