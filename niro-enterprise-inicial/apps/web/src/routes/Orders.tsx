import { FormEvent, useEffect, useState } from 'react';
import { apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import { contactLabel } from '../lib/format';
import { Modal } from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import type { Contact, Order, OrderItem, OrderStatus, OrgUser } from '../types';
import { ORDER_STATUSES } from '../types';
import { EmptyState, LoadingRows, PageHeader, PageShell, Panel, PersonCell, Pill, StatCard, StatGrid, type Tone } from '../components/PageKit';
import { IconChart, IconPackage } from '../components/icons';

const STATUS_TONE: Record<OrderStatus, Tone> = {
  RECEIVED: 'primary',
  CONFIRMED: 'violet',
  PREPARING: 'warning',
  DISPATCHED: 'primary',
  DELIVERED: 'success',
  CANCELLED: 'danger'
};

const STATUS_LABEL: Record<OrderStatus, string> = {
  RECEIVED: 'Recibido',
  CONFIRMED: 'Confirmado',
  PREPARING: 'Preparando',
  DISPATCHED: 'Despachado',
  DELIVERED: 'Entregado',
  CANCELLED: 'Cancelado'
};

function money(n: number) {
  return n.toLocaleString('es-PY', { maximumFractionDigits: 0 });
}

export function Orders() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<Order | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // Load every order once; the status chips filter client-side so the KPIs always reflect all sales.
      const data = await apiGet<{ orders: Order[] }>('/api/org/orders');
      setOrders(data.orders);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los pedidos');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  void user;

  const validOrders = orders.filter((o) => o.status !== 'CANCELLED');
  const salesTotal = validOrders.reduce((sum, o) => sum + o.total, 0);
  const avgTicket = validOrders.length ? Math.round(salesTotal / validOrders.length) : 0;
  const inProgress = orders.filter((o) => ['RECEIVED', 'CONFIRMED', 'PREPARING', 'DISPATCHED'].includes(o.status)).length;
  const delivered = orders.filter((o) => o.status === 'DELIVERED').length;
  const visibleOrders = statusFilter ? orders.filter((o) => o.status === statusFilter) : orders;

  return (
    <PageShell>
      <PageHeader
        icon={<IconPackage />}
        title="Pedidos y ventas"
        subtitle="Seguimiento de pedidos, cotizaciones y facturación de tu negocio."
        actions={
          <button className="btn" onClick={() => setShowCreate(true)}>
            + Nuevo pedido
          </button>
        }
      />

      {error && <div className="alert error">{error}</div>}

      <StatGrid>
        <StatCard label="Ventas totales" value={loading ? '—' : `Gs. ${money(salesTotal)}`} hint="Sin contar cancelados" tone="success" icon={<IconChart />} />
        <StatCard label="Pedidos" value={loading ? '—' : orders.length} hint={`${validOrders.length} válidos`} icon={<IconPackage />} />
        <StatCard label="Ticket promedio" value={loading ? '—' : `Gs. ${money(avgTicket)}`} hint="Por pedido válido" tone="violet" icon={<IconChart />} />
        <StatCard label="En curso" value={loading ? '—' : inProgress} hint={`${delivered} entregados`} tone="warning" icon={<IconPackage />} />
      </StatGrid>

      <Panel
        flush
        title="Listado de pedidos"
        actions={
          <div className="page-chips">
            <button type="button" className={`page-chip ${statusFilter === '' ? 'active' : ''}`} onClick={() => setStatusFilter('')}>
              Todos ({orders.length})
            </button>
            {ORDER_STATUSES.map((s) => {
              const count = orders.filter((o) => o.status === s).length;
              if (!count && statusFilter !== s) return null;
              return (
                <button key={s} type="button" className={`page-chip ${statusFilter === s ? 'active' : ''}`} onClick={() => setStatusFilter(s)}>
                  {STATUS_LABEL[s]} ({count})
                </button>
              );
            })}
          </div>
        }
      >
        {loading ? (
          <LoadingRows />
        ) : visibleOrders.length === 0 ? (
          <EmptyState
            icon={<IconPackage />}
            title={statusFilter ? 'No hay pedidos con este estado' : 'Todavía no hay pedidos'}
            text="Los pedidos creados desde el chat o manualmente aparecen acá."
            action={
              !statusFilter && (
                <button className="btn" onClick={() => setShowCreate(true)}>
                  + Crear pedido
                </button>
              )
            }
          />
        ) : (
          <div className="page-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Fecha</th>
                  <th>Estado</th>
                  <th className="num">Artículos</th>
                  <th className="num">Total</th>
                  <th>Asignado a</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visibleOrders.map((o) => (
                  <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(o)}>
                    <td>
                      <PersonCell name={contactLabel(o.contact)} detail={o.contact.phone || o.contact.email || undefined} />
                    </td>
                    <td className="page-muted">{new Date(o.createdAt).toLocaleDateString('es-PY')}</td>
                    <td>
                      <Pill tone={STATUS_TONE[o.status]} dot>
                        {STATUS_LABEL[o.status]}
                      </Pill>
                    </td>
                    <td className="num">{o.items.reduce((n, it) => n + it.quantity, 0)}</td>
                    <td className="num page-strong">Gs. {money(o.total)}</td>
                    <td className="page-muted">{o.assignedTo?.name || 'Sin asignar'}</td>
                    <td className="actions">
                      <button className="btn secondary small" onClick={(e) => { e.stopPropagation(); setSelected(o); }}>
                        Ver
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
        <OrderFormModal
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      {selected && (
        <OrderDetailModal
          order={selected}
          onClose={() => setSelected(null)}
          onSaved={(order) => {
            setSelected(order);
            load();
          }}
        />
      )}
    </PageShell>
  );
}

function ItemsEditor({ items, onChange }: { items: OrderItem[]; onChange: (items: OrderItem[]) => void }) {
  function update(i: number, patch: Partial<OrderItem>) {
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }
  function add() {
    onChange([...items, { name: '', quantity: 1, unitPrice: null }]);
  }
  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i));
  }

  return (
    <div className="field">
      <label>Artículos</label>
      <div style={{ display: 'grid', gap: 8 }}>
        {items.map((item, i) => (
          <div className="row" key={i}>
            <input
              className="input"
              style={{ flex: 2 }}
              placeholder="Producto o servicio"
              value={item.name}
              onChange={(e) => update(i, { name: e.target.value })}
            />
            <input
              className="input"
              type="number"
              min={1}
              style={{ width: 64 }}
              value={item.quantity}
              onChange={(e) => update(i, { quantity: Number(e.target.value) || 1 })}
            />
            <input
              className="input"
              type="number"
              min={0}
              style={{ width: 100 }}
              placeholder="Precio"
              value={item.unitPrice ?? ''}
              onChange={(e) => update(i, { unitPrice: e.target.value === '' ? null : Number(e.target.value) })}
            />
            <button type="button" className="btn danger small" onClick={() => remove(i)}>
              Quitar
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="btn secondary small" style={{ marginTop: 8 }} onClick={add}>
        + Agregar artículo
      </button>
    </div>
  );
}

function OrderFormModal({ onClose, onSaved }: { onClose: () => void; onSaved: (order: Order) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Contact[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<OrderItem[]>([{ name: '', quantity: 1, unitPrice: null }]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!query.trim() || selectedContact) {
      setResults([]);
      return;
    }
    const id = setTimeout(() => {
      apiGet<{ contacts: Contact[] }>(`/api/org/contacts?q=${encodeURIComponent(query.trim())}`)
        .then((data) => setResults(data.contacts))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [query, selectedContact]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        notes: notes || undefined,
        items: items.filter((i) => i.name.trim())
      };
      if (selectedContact) body.contactId = selectedContact.id;
      else if (creatingNew && newName) body.newContact = { name: newName, phone: newPhone || undefined };
      else throw new Error('Elegí un contacto existente o cargá uno nuevo');

      const data = await apiPost<{ order: Order }>('/api/org/orders', body);
      onSaved(data.order);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'No se pudo crear el pedido');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Nuevo pedido" onClose={onClose}>
      {error && <div className="alert error">{error}</div>}
      <form onSubmit={handleSubmit}>
        {!creatingNew && (
          <div className="field">
            <label htmlFor="order-contact-search">Cliente</label>
            {selectedContact ? (
              <div className="row between" style={{ background: 'var(--surface-2)', padding: '8px 12px', borderRadius: 10 }}>
                <span>{contactLabel(selectedContact)}</span>
                <button type="button" className="btn secondary small" onClick={() => setSelectedContact(null)}>
                  Cambiar
                </button>
              </div>
            ) : (
              <>
                <input
                  id="order-contact-search"
                  className="input"
                  placeholder="Buscar por nombre, teléfono o email…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {results.length > 0 && (
                  <div style={{ border: '1px solid var(--line)', borderRadius: 10, marginTop: 6, overflow: 'hidden' }}>
                    {results.map((c) => (
                      <div
                        key={c.id}
                        onClick={() => setSelectedContact(c)}
                        style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--line)' }}
                      >
                        {contactLabel(c)}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {!selectedContact && (
          <button type="button" className="btn secondary small" onClick={() => setCreatingNew((v) => !v)} style={{ marginBottom: 14 }}>
            {creatingNew ? 'Buscar cliente existente' : '+ Cargar cliente nuevo'}
          </button>
        )}
        {creatingNew && !selectedContact && (
          <>
            <div className="field">
              <label htmlFor="order-new-name">Nombre</label>
              <input id="order-new-name" className="input" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="order-new-phone">Teléfono</label>
              <input id="order-new-phone" className="input" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
            </div>
          </>
        )}

        <ItemsEditor items={items} onChange={setItems} />

        <div className="field">
          <label htmlFor="order-notes">Notas (opcional)</label>
          <input id="order-notes" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <button className="btn" type="submit" disabled={submitting} style={{ width: '100%', justifyContent: 'center' }}>
          {submitting ? 'Creando…' : 'Crear pedido'}
        </button>
      </form>
    </Modal>
  );
}

function OrderDetailModal({ order, onClose, onSaved }: { order: Order; onClose: () => void; onSaved: (o: Order) => void }) {
  const [status, setStatus] = useState(order.status);
  const [assignedToId, setAssignedToId] = useState(order.assignedTo?.id || '');
  const [notes, setNotes] = useState(order.notes || '');
  const [items, setItems] = useState<OrderItem[]>(order.items);
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiGet<{ users: OrgUser[] }>('/api/org/users')
      .then((data) => setUsers(data.users.filter((u) => u.active)))
      .catch(() => setUsers([]));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const data = await apiPatch<{ order: Order }>(`/api/org/orders/${order.id}`, {
        status,
        assignedToId: assignedToId || null,
        notes: notes || null,
        items: items.filter((i) => i.name.trim())
      });
      onSaved(data.order);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo actualizar el pedido');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Pedido de ${contactLabel(order.contact)}`} onClose={onClose}>
      {error && <div className="alert error">{error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="row" style={{ marginBottom: 14 }}>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <label htmlFor="order-status">Estado</label>
            <select id="order-status" className="input" value={status} onChange={(e) => setStatus(e.target.value as OrderStatus)}>
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <label htmlFor="order-assignee">Responsable</label>
            <select id="order-assignee" className="input" value={assignedToId} onChange={(e) => setAssignedToId(e.target.value)}>
              <option value="">Sin asignar</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <ItemsEditor items={items} onChange={setItems} />

        <div className="field">
          <label htmlFor="order-detail-notes">Notas</label>
          <input id="order-detail-notes" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <p className="muted" style={{ fontSize: 13 }}>
          Total: Gs. {money(items.reduce((sum, i) => sum + (i.unitPrice || 0) * i.quantity, 0))}
        </p>

        <button className="btn" type="submit" disabled={submitting} style={{ width: '100%', justifyContent: 'center' }}>
          {submitting ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </form>
    </Modal>
  );
}
