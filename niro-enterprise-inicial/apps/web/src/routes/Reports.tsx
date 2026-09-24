import { useEffect, useState } from 'react';
import { apiGet, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { PageHeader } from '../components/PageKit';
import { IconChart } from '../components/icons';
import { DonutChart, Heatmap, RankedBars, SERIES, StatTile, TimeSeriesChart } from '../components/Charts';
import { AuditLogPanel } from '../components/AuditLogPanel';
import type { ConversationStatus, OrderStatus } from '../types';
import { Ui } from '../components/Ui';
import '../styles/reports.css';

// "2026-09-23" -> "23 sep"
const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('es', { day: 'numeric', month: 'short' });

interface SeriesDay { day: string; conversations: number; inbound: number; outbound: number; orders: number; revenue: number }

interface Summary {
  period: { days: number };
  series: SeriesDay[];
  heatmap: { weekday: number; hour: number; total: number }[];
  messages: { inbound: number };
  trends: { conversations: number | null; orders: number | null; revenue: number | null; inbound: number | null };
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


export function Reports() {
  const { user } = useAuth();
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canSeeAudit = user?.role === 'OWNER' || user?.role === 'ADMIN';

  useEffect(() => {
    setLoading(true);
    setError(null);
    const requests: Promise<unknown>[] = [
      apiGet<Summary>(`/api/org/reports/summary?days=${days}`).then((data) => setSummary(data))
    ];
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
    <div className="page-shell reports-page">
      {/* Header Toolbar */}
      <div style={{ marginBottom: 24 }}>
        <PageHeader tone="blue" hero={{ eyebrow: 'Reportes', title: 'Medí la atención y las ventas.', text: 'Tiempos de respuesta, canales, productividad de agentes y ventas en un solo tablero.', features: [{ icon: 'clock', label: 'Tiempos de respuesta' }, { icon: 'users', label: 'Productividad' }, { icon: 'chart', label: 'Ventas' }], art: ['chart', 'zap', 'clock'] }}
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

      <section className="reports-kpis">
        <StatTile label="Conversaciones" value={summary.conversations.total.toLocaleString('es')} trend={summary.trends.conversations} hint="vs. período anterior" icon={<Ui name="chat" size={16} />} />
        <StatTile label="Mensajes recibidos" value={summary.messages.inbound.toLocaleString('es')} trend={summary.trends.inbound} hint="de clientes" icon={<Ui name="mail" size={16} />} />
        <StatTile label="Tasa de resolución" value={`${summary.conversations.resolutionRate}%`} hint="cerradas o resueltas" icon={<Ui name="check-circle" size={16} />} />
        <StatTile label="Primera respuesta" value={summary.conversations.avgFirstResponseMinutes !== null ? `${summary.conversations.avgFirstResponseMinutes} min` : '—'} hint="promedio del período" icon={<Ui name="clock" size={16} />} />
        <StatTile label="Pedidos" value={summary.orders.total.toLocaleString('es')} trend={summary.trends.orders} hint="vs. período anterior" icon={<Ui name="cart" size={16} />} />
        <StatTile label="Facturación" value={`Gs. ${money(summary.orders.revenue)}`} trend={summary.trends.revenue} hint="sin cancelados" icon={<Ui name="chart" size={16} />} />
      </section>

      <section className="reports-panel">
        <header className="reports-panel-head">
          <div><h3><Ui name="chat" size={16} /> Conversaciones y mensajes por día</h3><p>Cómo se movió la atención durante el período.</p></div>
        </header>
        <TimeSeriesChart series={[
          { name: 'Conversaciones', color: SERIES[0], points: summary.series.map((d) => ({ label: shortDay(d.day), value: d.conversations })) },
          { name: 'Mensajes recibidos', color: SERIES[1], points: summary.series.map((d) => ({ label: shortDay(d.day), value: d.inbound })) }
        ]} />
      </section>

      <div className="reports-pair">
        <section className="reports-panel">
          <header className="reports-panel-head"><div><h3><Ui name="globe" size={16} /> Canal de entrada</h3><p>Por dónde llegan los clientes.</p></div></header>
          <DonutChart centerLabel="conversaciones" data={summary.conversations.byChannel.map((c) => ({
            label: c.channel === 'whatsapp' ? 'WhatsApp' : c.channel === 'web' ? 'Widget web' : c.channel,
            value: c.count
          }))} />
        </section>

        <section className="reports-panel">
          <header className="reports-panel-head"><div><h3><Ui name="check-circle" size={16} /> Estado de las conversaciones</h3><p>Cuántas siguen abiertas y cuántas se cerraron.</p></div></header>
          <DonutChart centerLabel="conversaciones" data={conversationStatusRows.filter((r) => r.count > 0).map((r) => ({ label: r.label, value: r.count }))} />
        </section>
      </div>

      <div className="reports-pair">
        <section className="reports-panel">
          <header className="reports-panel-head"><div><h3><Ui name="user" size={16} /> Carga por agente</h3><p>Conversaciones asignadas a cada persona.</p></div></header>
          <RankedBars data={summary.conversations.byAgent.map((a) => ({ label: a.name, value: a.count }))} color={SERIES[4]} />
        </section>

        <section className="reports-panel">
          <header className="reports-panel-head"><div><h3><Ui name="building" size={16} /> Volumen por área</h3><p>A qué área llegan las consultas.</p></div></header>
          <RankedBars data={summary.conversations.byDepartment.map((d) => ({ label: d.name, value: d.count }))} color={SERIES[2]} />
        </section>
      </div>

      <section className="reports-panel">
        <header className="reports-panel-head"><div><h3><Ui name="clock" size={16} /> Cuándo escriben tus clientes</h3><p>Mensajes recibidos por día de la semana y hora. Cuanto más intenso, más movimiento.</p></div></header>
        <Heatmap cells={summary.heatmap} />
      </section>

      <div className="reports-pair">
        <section className="reports-panel">
          <header className="reports-panel-head"><div><h3><Ui name="cart" size={16} /> Pedidos por estado</h3><p>En qué etapa está cada pedido.</p></div></header>
          <RankedBars data={orderStatusRows.map((r) => ({ label: r.label, value: r.count }))} color={SERIES[3]} />
        </section>

        <section className="reports-panel">
          <header className="reports-panel-head"><div><h3><Ui name="chart" size={16} /> Facturación por día</h3><p>Ventas registradas, sin los pedidos cancelados.</p></div></header>
          <TimeSeriesChart height={200} formatValue={(value) => `Gs. ${money(value)}`} series={[
            { name: 'Facturación', color: SERIES[2], points: summary.series.map((d) => ({ label: shortDay(d.day), value: d.revenue })) }
          ]} />
        </section>
      </div>

      {/* Registro de auditoría: buscador, filtros y paginación propios (no dependen del selector de días de arriba). */}
      {canSeeAudit && (
        <div className="card reports-panel reports-audit" style={{ padding: 22, borderRadius: 14, background: 'var(--bg-surface)' }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 800, color: 'var(--text-main)' }}>
            <Ui name="lock" size={16} /> Registro de Auditoría de Operaciones
          </h3>
          <AuditLogPanel />
        </div>
      )}
    </div>
  );
}
