import { useEffect, useState } from 'react';
import { apiGet, ApiError } from '../lib/api';
import { formatTime } from '../lib/format';
import { useAuth } from '../context/AuthContext';
import { PageHeader } from '../components/PageKit';
import { IconChart } from '../components/icons';
import type { ConversationStatus, OrderStatus } from '../types';

interface Summary {
  period: { days: number };
  conversations: {
    total: number;
    byStatus: Partial<Record<ConversationStatus, number>>;
    byChannel: { channel: string; count: number }[];
    byDepartment: { departmentId: string | null; name: string; count: number }[];
    byAgent: { userId: string | null; name: string; count: number }[];
    resolutionRate: number;
    avgFirstResponseMinutes: number | null;
  };
  orders: {
    total: number;
    byStatus: Partial<Record<OrderStatus, number>>;
    revenue: number;
  };
}

interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorName: string;
  createdAt: string;
}

const CONV_STATUS_LABEL: Record<ConversationStatus, string> = {
  OPEN: 'Abiertas',
  PENDING: 'Pendientes',
  RESOLVED: 'Resueltas',
  CLOSED: 'Cerradas'
};

const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  RECEIVED: 'Recibido',
  CONFIRMED: 'Confirmado',
  PREPARING: 'En preparación',
  DISPATCHED: 'Despachado',
  DELIVERED: 'Entregado',
  CANCELLED: 'Cancelado'
};

function money(n: number) {
  return n.toLocaleString('es-PY', { maximumFractionDigits: 0 });
}

function ModernBarList({ rows, color = 'var(--primary)' }: { rows: { label: string; count: number }[]; color?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (rows.length === 0) return <p style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>Sin datos en este período.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((r) => (
        <div key={r.label}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
            <span style={{ fontWeight: 600, color: 'var(--text-main)' }}>{r.label}</span>
            <span style={{ fontWeight: 700, color: 'var(--text-muted)' }}>{r.count}</span>
          </div>
          <div style={{ width: '100%', height: 7, background: 'var(--bg-surface-2)', borderRadius: 4, overflow: 'hidden' }}>
            <div
              style={{
                width: `${(r.count / max) * 100}%`,
                height: '100%',
                background: color,
                borderRadius: 4,
                transition: 'width 0.4s ease'
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Reports() {
  const { user } = useAuth();
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canSeeAudit = user?.role === 'OWNER' || user?.role === 'ADMIN';

  useEffect(() => {
    setLoading(true);
    setError(null);
    const requests: Promise<unknown>[] = [
      apiGet<Summary>(`/api/org/reports/summary?days=${days}`).then((data) => setSummary(data))
    ];
    if (canSeeAudit) {
      requests.push(apiGet<{ entries: AuditEntry[] }>('/api/org/reports/audit?pageSize=20').then((data) => setAudit(data.entries)));
    }
    Promise.all(requests)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los reportes'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>
        Cargando estadísticas analíticas...
      </div>
    );
  }

  if (error || !summary) {
    return (
      <div style={{ padding: 20 }}>
        <div className="alert error">{error || 'No se pudieron cargar los reportes'}</div>
      </div>
    );
  }

  const conversationStatusRows = (Object.keys(CONV_STATUS_LABEL) as ConversationStatus[]).map((s) => ({
    label: CONV_STATUS_LABEL[s],
    count: summary.conversations.byStatus[s] || 0
  }));
  const orderStatusRows = (Object.keys(ORDER_STATUS_LABEL) as OrderStatus[]).map((s) => ({
    label: ORDER_STATUS_LABEL[s],
    count: summary.orders.byStatus[s] || 0
  }));

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '24px 32px', boxSizing: 'border-box' }}>
      {/* Header Toolbar */}
      <div style={{ marginBottom: 24 }}>
        <PageHeader
          icon={<IconChart />}
          title="Reportes de ventas y atención"
          subtitle="Estadísticas consolidadas de atención, canales, productividad de agentes y ventas."
          actions={
            <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>Últimos 7 días</option>
              <option value={14}>Últimos 14 días</option>
              <option value={30}>Últimos 30 días</option>
              <option value={90}>Últimos 90 días</option>
              <option value={365}>Último año</option>
            </select>
          }
        />
      </div>

      {/* KPI Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 16,
          marginBottom: 24
        }}
      >
        <div className="card" style={{ padding: '16px 20px', borderRadius: 14, background: 'var(--bg-surface)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}>
            Conversaciones Totales
          </div>
          <div style={{ fontSize: 28, fontWeight: 900, color: 'var(--text-main)', marginTop: 4 }}>
            {summary.conversations.total}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--primary-glow)', marginTop: 4 }}>
            En los últimos {days} días
          </div>
        </div>

        <div className="card" style={{ padding: '16px 20px', borderRadius: 14, background: 'var(--bg-surface)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}>
            Tasa de Resolución
          </div>
          <div style={{ fontSize: 28, fontWeight: 900, color: '#10b981', marginTop: 4 }}>
            {summary.conversations.resolutionRate}%
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
            Casos resueltos / cerrados
          </div>
        </div>

        <div className="card" style={{ padding: '16px 20px', borderRadius: 14, background: 'var(--bg-surface)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}>
            Tiempo Promedio 1.ª Respuesta
          </div>
          <div style={{ fontSize: 28, fontWeight: 900, color: 'var(--primary-glow)', marginTop: 4 }}>
            {summary.conversations.avgFirstResponseMinutes !== null
              ? `${summary.conversations.avgFirstResponseMinutes} min`
              : '—'}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
            Velocidad del equipo
          </div>
        </div>

        <div className="card" style={{ padding: '16px 20px', borderRadius: 14, background: 'var(--bg-surface)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}>
            Pedidos Generados
          </div>
          <div style={{ fontSize: 28, fontWeight: 900, color: 'var(--text-main)', marginTop: 4 }}>
            {summary.orders.total}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
            Cotizaciones / ventas
          </div>
        </div>

        <div className="card" style={{ padding: '16px 20px', borderRadius: 14, background: 'var(--bg-surface)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}>
            Facturación Total
          </div>
          <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--primary-glow)', marginTop: 6 }}>
            Gs. {money(summary.orders.revenue)}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
            Pedidos válidos (no cancelados)
          </div>
        </div>
      </div>

      {/* Row 1: Estados y Canales */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
        <div className="card" style={{ padding: 22, borderRadius: 14, background: 'var(--bg-surface)' }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 800, color: 'var(--text-main)' }}>
            📋 Conversaciones por Estado
          </h3>
          <ModernBarList rows={conversationStatusRows} color="linear-gradient(90deg, #0284c7 0%, #38bdf8 100%)" />
        </div>

        <div className="card" style={{ padding: 22, borderRadius: 14, background: 'var(--bg-surface)' }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 800, color: 'var(--text-main)' }}>
            🌐 Conversaciones por Canal de Entrada
          </h3>
          <ModernBarList
            rows={summary.conversations.byChannel.map((c) => ({
              label: c.channel === 'whatsapp' ? '🟢 WhatsApp' : c.channel === 'web' ? '🌐 Widget Web' : `📱 ${c.channel}`,
              count: c.count
            }))}
            color="linear-gradient(90deg, #10b981 0%, #34d399 100%)"
          />
        </div>
      </div>

      {/* Row 2: Carga por Agente y Departamentos */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
        <div className="card" style={{ padding: 22, borderRadius: 14, background: 'var(--bg-surface)' }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 800, color: 'var(--text-main)' }}>
            👤 Desempeño y Carga por Agente
          </h3>
          <ModernBarList
            rows={summary.conversations.byAgent.map((a) => ({ label: a.name, count: a.count }))}
            color="linear-gradient(90deg, #9333ea 0%, #c084fc 100%)"
          />
        </div>

        <div className="card" style={{ padding: 22, borderRadius: 14, background: 'var(--bg-surface)' }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 800, color: 'var(--text-main)' }}>
            🏢 Volumen por Departamento
          </h3>
          <ModernBarList
            rows={summary.conversations.byDepartment.map((d) => ({ label: d.name, count: d.count }))}
            color="linear-gradient(90deg, #f59e0b 0%, #fbbf24 100%)"
          />
        </div>
      </div>

      {/* Row 3: Pedidos por Estado */}
      <div className="card" style={{ padding: 22, borderRadius: 14, background: 'var(--bg-surface)', marginBottom: 20 }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 800, color: 'var(--text-main)' }}>
          🛒 Estado de Pedidos y Logística
        </h3>
        <ModernBarList rows={orderStatusRows} color="linear-gradient(90deg, #2563eb 0%, #60a5fa 100%)" />
      </div>

      {/* Audit Logs */}
      {canSeeAudit && (
        <div className="card" style={{ padding: 22, borderRadius: 14, background: 'var(--bg-surface)' }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 800, color: 'var(--text-main)' }}>
            🔒 Registro de Auditoría de Operaciones
          </h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                  <th style={{ padding: '8px 10px', color: 'var(--text-dim)' }}>Acción</th>
                  <th style={{ padding: '8px 10px', color: 'var(--text-dim)' }}>Entidad</th>
                  <th style={{ padding: '8px 10px', color: 'var(--text-dim)' }}>Usuario</th>
                  <th style={{ padding: '8px 10px', color: 'var(--text-dim)' }}>Fecha y Hora</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((e) => (
                  <tr key={e.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '10px', fontWeight: 600, color: 'var(--text-main)' }}>{e.action}</td>
                    <td style={{ padding: '10px', color: 'var(--text-muted)' }}>{e.entityType}</td>
                    <td style={{ padding: '10px', color: 'var(--primary-glow)' }}>{e.actorName}</td>
                    <td style={{ padding: '10px', color: 'var(--text-dim)' }}>{formatTime(e.createdAt)}</td>
                  </tr>
                ))}
                {audit.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ padding: 16, textAlign: 'center', color: 'var(--text-dim)' }}>
                      Sin actividad registrada todavía.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
