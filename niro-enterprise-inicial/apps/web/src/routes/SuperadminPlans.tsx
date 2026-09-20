import { FormEvent, useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import { Modal } from '../components/Modal';
import { EmptyState, LoadingRows, PageHeader, PageShell, Panel, Pill } from '../components/PageKit';
import { formatGs } from '../components/BillingGate';

interface AdminPlan {
  id: string; name: string; description: string | null; priceGs: number; maxAgents: number;
  features: string[]; active: boolean; popular: boolean; sortOrder: number; organizations: number;
}

export function SuperadminPlans() {
  const [plans, setPlans] = useState<AdminPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminPlan | 'new' | null>(null);
  const [removing, setRemoving] = useState<AdminPlan | null>(null);

  const load = useCallback(async () => {
    try { setPlans((await apiGet<{ plans: AdminPlan[] }>('/api/superadmin/plans')).plans); setError(null); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los planes'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function toggle(plan: AdminPlan, patch: Partial<AdminPlan>) {
    try { await apiPatch(`/api/superadmin/plans/${plan.id}`, patch); await load(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo actualizar'); }
  }

  async function confirmRemove() {
    if (!removing) return;
    try { await apiDelete(`/api/superadmin/plans/${removing.id}`); setRemoving(null); await load(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo eliminar'); setRemoving(null); }
  }

  return (
    <PageShell>
      <PageHeader title="Planes" subtitle="Definí precios y cuántos agentes incluye cada plan. Los cambios se aplican al instante."
        actions={<button className="btn" onClick={() => setEditing('new')}>＋ Nuevo plan</button>} />
      {error && <div className="campaign-alert error" style={{ marginBottom: 12 }}>{error}</div>}
      <Panel flush title="Planes de suscripción">
        {!plans ? <LoadingRows /> : plans.length === 0 ? <EmptyState title="No hay planes" text="Creá el primero para poder cobrar." /> : (
          <div className="page-table-wrap"><table>
            <thead><tr><th>Orden</th><th>Plan</th><th className="num">Precio / mes</th><th className="num">Agentes</th><th className="num">Clientes</th><th>Estado</th><th></th></tr></thead>
            <tbody>{plans.map((p) => (
              <tr key={p.id}>
                <td>{p.sortOrder}</td>
                <td><b>{p.name}</b> {p.popular && <Pill tone="violet">Más elegido</Pill>}<div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.description}</div></td>
                <td className="num">{formatGs(p.priceGs)}</td>
                <td className="num">{p.maxAgents} + propietario</td>
                <td className="num">{p.organizations}</td>
                <td><Pill tone={p.active ? 'success' : 'neutral'} dot>{p.active ? 'Disponible' : 'Oculto'}</Pill></td>
                <td className="actions">
                  <button className="btn secondary small" onClick={() => setEditing(p)}>Editar</button>{' '}
                  <button className="btn secondary small" onClick={() => toggle(p, { active: !p.active })}>{p.active ? 'Ocultar' : 'Mostrar'}</button>{' '}
                  <button className="btn danger small" onClick={() => setRemoving(p)}>Eliminar</button>
                </td>
              </tr>))}</tbody></table></div>
        )}
      </Panel>
      {editing && <PlanModal plan={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {removing && (
        <Modal title="Eliminar plan" onClose={() => setRemoving(null)}>
          <p style={{ margin: '0 0 14px', lineHeight: 1.5 }}>¿Eliminar el plan <b>{removing.name}</b>?{removing.organizations > 0 ? ` Lo usan ${removing.organizations} cliente(s), así que el sistema no lo va a permitir: ocultalo en su lugar.` : ' Esta acción no se puede deshacer.'}</p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button className="btn secondary" onClick={() => setRemoving(null)}>Cancelar</button><button className="btn danger" onClick={confirmRemove}>Sí, eliminar</button></div>
        </Modal>
      )}
    </PageShell>
  );
}

function PlanModal({ plan, onClose, onSaved }: { plan: AdminPlan | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(plan?.name || '');
  const [description, setDescription] = useState(plan?.description || '');
  const [priceGs, setPriceGs] = useState(String(plan?.priceGs ?? ''));
  const [maxAgents, setMaxAgents] = useState(String(plan?.maxAgents ?? ''));
  const [sortOrder, setSortOrder] = useState(String(plan?.sortOrder ?? ''));
  const [features, setFeatures] = useState((plan?.features || []).join('\n'));
  const [popular, setPopular] = useState(plan?.popular || false);
  const [active, setActive] = useState(plan?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const body = {
      name, description, priceGs: Number(priceGs.replace(/\D/g, '')), maxAgents: Number(maxAgents), popular, active,
      features: features.split('\n').map((line) => line.trim()).filter(Boolean),
      ...(sortOrder !== '' ? { sortOrder: Number(sortOrder) } : {})
    };
    try {
      if (plan) await apiPatch(`/api/superadmin/plans/${plan.id}`, body); else await apiPost('/api/superadmin/plans', body);
      onSaved();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo guardar'); setBusy(false); }
  }

  return (
    <Modal title={plan ? `Editar plan ${plan.name}` : 'Nuevo plan'} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Nombre</span><input className="input" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Ejecutivo" autoFocus /></label>
        <label className="field"><span>Descripción corta</span><input className="input" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <label className="field"><span>Precio mensual (Gs)</span><input className="input" required inputMode="numeric" value={priceGs} onChange={(e) => setPriceGs(e.target.value)} placeholder="49000" /></label>
          <label className="field"><span>Agentes (además del propietario)</span><input className="input" required type="number" min={0} max={1000} value={maxAgents} onChange={(e) => setMaxAgents(e.target.value)} /></label>
          <label className="field"><span>Orden</span><input className="input" type="number" min={0} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} placeholder="auto" /></label>
        </div>
        <label className="field"><span>Características (una por línea)</span><textarea className="input" rows={4} value={features} onChange={(e) => setFeatures(e.target.value)} /></label>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Disponible para contratar</label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={popular} onChange={(e) => setPopular(e.target.checked)} /> Marcar “Más elegido”</label>
        </div>
        {error && <div className="campaign-alert error">{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn secondary" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy}>{busy ? 'Guardando…' : plan ? 'Guardar cambios' : 'Crear plan'}</button></div>
      </form>
    </Modal>
  );
}
