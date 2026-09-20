import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiGet } from '../lib/api';
import { getSocket } from '../lib/socket';
import { WhatsAppConnectModal } from '../components/WhatsAppConnectModal';
import { NiroMascot } from '../components/NiroMascot';
import type { DashboardStats, AgentPresence } from '../types';

type WhatsAppStatus = 'disconnected' | 'connecting' | 'qr' | 'connected';

function formatGs(amount: number) {
  return `Gs. ${amount.toLocaleString('es-PY')}`;
}

function initialsOf(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

// Builds a smooth-ish SVG path through real data points (cubic bezier via midpoint control),
// scaled to a viewBox of the given width/height with y=0 at the top and y=height at the baseline.
function buildLinePath(values: number[], width: number, height: number, maxValue: number) {
  if (values.length === 0) return '';
  const safeMax = maxValue > 0 ? maxValue : 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((v, i) => [i * stepX, height - (v / safeMax) * height] as const);
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const midX = (x0 + x1) / 2;
    d += ` C${midX},${y0} ${midX},${y1} ${x1},${y1}`;
  }
  return d;
}

function buildAreaPath(linePath: string, width: number, height: number) {
  return `${linePath} L${width},${height} L0,${height} Z`;
}

export function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [showWaModal, setShowWaModal] = useState(false);
  const [waStatus, setWaStatus] = useState<WhatsAppStatus>('disconnected');
  const [nowDate, setNowDate] = useState(() => new Date());

  // Clock updater
  useEffect(() => {
    const timer = setInterval(() => setNowDate(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  const fetchStats = useCallback(async () => {
    if (!user || user.role === 'SUPERADMIN') {
      setLoading(false);
      return;
    }
    try {
      const data = await apiGet<DashboardStats>('/api/org/dashboard-stats');
      setStats(data);
    } catch (err) {
      console.error('Error loading dashboard stats:', err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    if (!user || user.role === 'SUPERADMIN') return;
    apiGet<{ status: WhatsAppStatus }>('/api/org/whatsapp/status')
      .then((res) => setWaStatus(res.status))
      .catch(() => {});
  }, [user]);

  // Real-time socket listeners
  useEffect(() => {
    if (!user || user.role === 'SUPERADMIN') return;
    const socket = getSocket();

    const handleRefresh = () => fetchStats();
    const handlePresence = ({ presence }: { presence: AgentPresence[] }) => {
      setStats((prev) => {
        if (!prev) return prev;
        const onlineIds = new Set(presence.map((p) => p.userId));
        const updatedList = prev.kpis.agents.list.map((a) => {
          const found = presence.find((p) => p.userId === a.id);
          return {
            ...a,
            online: onlineIds.has(a.id),
            status: found ? found.status : a.status
          };
        });
        const onlineCount = updatedList.filter((a) => a.online).length;
        return {
          ...prev,
          kpis: {
            ...prev.kpis,
            agents: {
              ...prev.kpis.agents,
              onlineCount,
              list: updatedList
            }
          }
        };
      });
    };
    const handleWaStatus = (payload: { status: WhatsAppStatus }) => setWaStatus(payload.status);

    socket.on('message:new', handleRefresh);
    socket.on('conversation:new', handleRefresh);
    socket.on('conversation:updated', handleRefresh);
    socket.on('agent:presence_list', handlePresence);
    socket.on('whatsapp:status', handleWaStatus);

    return () => {
      socket.off('message:new', handleRefresh);
      socket.off('conversation:new', handleRefresh);
      socket.off('conversation:updated', handleRefresh);
      socket.off('agent:presence_list', handlePresence);
      socket.off('whatsapp:status', handleWaStatus);
    };
  }, [fetchStats, user]);

  if (loading) {
    return (
      <div className="modern-dashboard-loading">
        <div className="dashboard-spinner" />
        <div style={{ marginTop: 16, color: 'var(--text-muted)' }}>Cargando panel de control de Niro...</div>
      </div>
    );
  }

  // Dynamic & live counts — all sourced from /api/org/dashboard-stats, no placeholders.
  const totalConversations = stats?.kpis.conversations.total ?? 0;
  const newClients = stats?.kpis.conversations.activeClients ?? 0;
  const totalRevenue = stats?.kpis.orders.revenueTotal ?? 0;
  const onlineAgents = stats?.kpis.agents.onlineCount ?? 0;
  const totalAgents = stats?.kpis.agents.total ?? 0;
  const activeConversations = stats?.kpis.conversations.open ?? 0;
  const isWaConnected = waStatus === 'connected';

  const msgStats = stats?.kpis.messages;
  const avgResponseLabel = msgStats && msgStats.avgFirstResponseMinutes !== null ? `${msgStats.avgFirstResponseMinutes}m` : '—';
  const botResolvedPct = msgStats && msgStats.outbound > 0 ? Math.round((msgStats.bot / msgStats.outbound) * 100) : 0;
  const transferredPct = msgStats && msgStats.outbound > 0 ? 100 - botResolvedPct : 0;

  const formattedDate = nowDate.toLocaleDateString('es-PY', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
  const formattedTime = nowDate.toLocaleTimeString('es-PY', {
    hour: '2-digit',
    minute: '2-digit'
  });
  const capitalizedDate = formattedDate.charAt(0).toUpperCase() + formattedDate.slice(1);

  interface RecentConvItem {
    id: string;
    name: string;
    phone: string | null;
    preview: string;
    status: string;
    statusColor: string;
    time: string;
    avatarUrl: string | null;
  }

  const recentConversations: RecentConvItem[] = (stats?.recentUnassigned || []).slice(0, 5).map((c) => ({
    id: c.id,
    name: c.contact.name || c.contact.phone || 'Cliente',
    phone: c.contact.phone,
    preview: c.lastMessage || 'Conversación activa',
    status: c.status === 'OPEN' ? 'En chat' : c.status === 'PENDING' ? 'En espera' : 'Resuelta',
    statusColor: c.status === 'OPEN' ? '#38bdf8' : c.status === 'PENDING' ? '#f59e0b' : '#10b981',
    time: new Date(c.updatedAt).toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' }),
    avatarUrl: c.contact.avatarUrl || null
  }));

  // Real 7-day message chart (inbound/outbound), drawn from stats.dailyActivity.
  const daily = stats?.dailyActivity || [];
  const chartMax = Math.max(1, ...daily.map((d) => Math.max(d.inbound, d.outbound)));
  const inboundPath = buildLinePath(daily.map((d) => d.inbound), 500, 150, chartMax);
  const outboundPath = buildLinePath(daily.map((d) => d.outbound), 500, 150, chartMax);

  // Real conversation-status donut (4 real statuses; a 5th "transferred" bucket doesn't exist
  // as a tracked conversation status — transfers are logged as notes, not a status change).
  const conv = stats?.kpis.conversations;
  const donutTotal = conv?.total || 0;
  const CIRC = 2 * Math.PI * 54;
  const donutSegments = conv
    ? [
        { label: 'En chat', value: conv.open, color: '#38bdf8' },
        { label: 'En espera', value: conv.pending, color: '#f59e0b' },
        { label: 'Resueltas', value: conv.resolved, color: '#10b981' },
        { label: 'Archivadas', value: conv.closed, color: '#a855f7' }
      ]
    : [];
  let donutOffset = 0;
  const donutArcs = donutSegments.map((seg) => {
    const fraction = donutTotal > 0 ? seg.value / donutTotal : 0;
    const length = fraction * CIRC;
    const arc = { ...seg, dasharray: `${length} ${CIRC}`, dashoffset: -donutOffset };
    donutOffset += length;
    return arc;
  });

  return (
    <div className="modern-dashboard-wrapper">
      {/* 1. HERO SECTION WITH NIRO 3D ROBOT */}
      <section className="dashboard-hero-card">
        <svg className="dashboard-hero-cyber-wave" viewBox="0 0 1200 240" fill="none" preserveAspectRatio="none">
          <path
            d="M0,140 C200,60 400,200 650,110 C900,20 1050,160 1200,80 L1200,240 L0,240 Z"
            fill="url(#heroWaveGrad)"
            opacity="0.35"
          />
          <path
            d="M0,180 C250,90 450,220 700,130 C950,40 1100,180 1200,100"
            stroke="url(#heroLineGrad)"
            strokeWidth="2.5"
            strokeLinecap="round"
            fill="none"
          />
          <defs>
            <linearGradient id="heroWaveGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#2563eb" stopOpacity="0.8" />
              <stop offset="50%" stopColor="#06b6d4" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#0b1329" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="heroLineGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#38bdf8" />
              <stop offset="50%" stopColor="#818cf8" />
              <stop offset="100%" stopColor="#06b6d4" />
            </linearGradient>
          </defs>
        </svg>

        <div className="dashboard-hero-content">
          <div className="dashboard-hero-left">
            <h1 className="dashboard-hero-title">
              Hola, {user?.name.split(' ')[0] || ''} 👋
            </h1>
            <p className="dashboard-hero-subtitle">
              Niro está activo y atendiendo tus clientes
            </p>

            <div className="dashboard-hero-badges-row">
              <button
                type="button"
                className="dashboard-wa-status-pill"
                onClick={() => setShowWaModal(true)}
              >
                <span className={`status-dot ${isWaConnected ? 'online' : 'connecting'}`} />
                <span>{isWaConnected ? 'WhatsApp conectado' : waStatus === 'qr' ? 'Escaneá el QR' : waStatus === 'connecting' ? 'Conectando...' : 'WhatsApp desconectado'}</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" style={{ marginLeft: 4 }}>
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              </button>

              <div className="dashboard-hero-datetime">
                {capitalizedDate} · {formattedTime}
              </div>
            </div>
          </div>

          <div className="dashboard-hero-right">
            <div className="dashboard-hero-bubble">
              <div className="bubble-title">¡Todo en orden!</div>
              <div className="bubble-text">{activeConversations} conversaciones activas ahora mismo.</div>
              <div className="bubble-arrow" />
            </div>

            <div className="dashboard-hero-mascot-wrap">
              <NiroMascot size={130} />
            </div>
          </div>
        </div>
      </section>

      {/* 2. TOP 5 KPI METRIC CARDS */}
      <section className="dashboard-kpis-grid">
        <div className="dashboard-kpi-card blue-card">
          <div className="kpi-icon-box blue-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
            </svg>
          </div>
          <div className="kpi-label">Conversaciones</div>
          <div className="kpi-number">{totalConversations}</div>
        </div>

        <div className="dashboard-kpi-card green-card">
          <div className="kpi-icon-box green-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
            </svg>
          </div>
          <div className="kpi-label">Clientes activos</div>
          <div className="kpi-number">{newClients}</div>
        </div>

        <div className="dashboard-kpi-card purple-card">
          <div className="kpi-icon-box purple-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49c.08-.14.12-.31.12-.48 0-.55-.45-1-1-1H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z" />
            </svg>
          </div>
          <div className="kpi-label">Ventas / Pedidos</div>
          <div className="kpi-number">{formatGs(totalRevenue)}</div>
        </div>

        <div className="dashboard-kpi-card orange-card">
          <div className="kpi-icon-box orange-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.38-1 1.72V7h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h4V5.72A2 2 0 0 1 10 4a2 2 0 0 1 2-2zm-3 9a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm-6 5h6v1H9v-1z" />
            </svg>
          </div>
          <div className="kpi-label">Agentes</div>
          <div className="kpi-number">{onlineAgents} / {totalAgents}</div>
          <div className="kpi-trend online-tag">
            <span className="dot-green" /> En línea
          </div>
        </div>

        <div className="dashboard-kpi-card cyan-card">
          <div className="kpi-icon-box cyan-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" />
            </svg>
          </div>
          <div className="kpi-label">Primera respuesta (prom.)</div>
          <div className="kpi-number">{avgResponseLabel}</div>
        </div>
      </section>

      {/* 3. MIDDLE ROW: REALTIME CHARTS & METRICS */}
      <section className="dashboard-charts-row">
        <div className="dashboard-chart-card">
          <div className="chart-card-header">
            <div>
              <h3 className="chart-card-title">Mensajes — últimos 7 días</h3>
              <div className="chart-legend-row">
                <span className="legend-item"><span className="legend-dot blue" /> Entrantes</span>
                <span className="legend-item"><span className="legend-dot purple" /> Salientes</span>
              </div>
            </div>
          </div>

          <div className="chart-area-with-sidebar">
            <div className="chart-svg-container">
              {daily.length === 0 ? (
                <p style={{ color: 'var(--text-dim)', fontSize: 13, padding: '20px 0' }}>Todavía no hay actividad suficiente para graficar.</p>
              ) : (
                <>
                  <svg viewBox="0 0 500 150" className="chart-svg" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="areaEntrantes" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.25" />
                        <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.0" />
                      </linearGradient>
                      <linearGradient id="areaSalientes" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#818cf8" stopOpacity="0.2" />
                        <stop offset="100%" stopColor="#818cf8" stopOpacity="0.0" />
                      </linearGradient>
                    </defs>

                    <line x1="0" y1="0" x2="500" y2="0" stroke="rgba(255,255,255,0.05)" />
                    <line x1="0" y1="75" x2="500" y2="75" stroke="rgba(255,255,255,0.05)" />
                    <line x1="0" y1="150" x2="500" y2="150" stroke="rgba(255,255,255,0.05)" />

                    <path d={buildAreaPath(inboundPath, 500, 150)} fill="url(#areaEntrantes)" />
                    <path d={inboundPath} fill="none" stroke="#38bdf8" strokeWidth="2.8" strokeLinecap="round" />

                    <path d={buildAreaPath(outboundPath, 500, 150)} fill="url(#areaSalientes)" />
                    <path d={outboundPath} fill="none" stroke="#a855f7" strokeWidth="2.4" strokeLinecap="round" />
                  </svg>

                  <div className="chart-x-labels">
                    {daily.map((d) => (
                      <span key={d.date}>{d.dayName}</span>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="chart-side-stats">
              <div className="side-stat-row">
                <div className="stat-icon-circle blue">💬</div>
                <div>
                  <div className="stat-value">{msgStats?.total ?? 0}</div>
                  <div className="stat-title">Mensajes totales</div>
                </div>
              </div>

              <div className="side-stat-row">
                <div className="stat-icon-circle green">⚡</div>
                <div>
                  <div className="stat-value">{botResolvedPct}%</div>
                  <div className="stat-title">Respondidos por IA</div>
                </div>
              </div>

              <div className="side-stat-row">
                <div className="stat-icon-circle orange">👥</div>
                <div>
                  <div className="stat-value">{transferredPct}%</div>
                  <div className="stat-title">Respondidos por agentes</div>
                </div>
              </div>

              <div className="side-stat-row">
                <div className="stat-icon-circle cyan">⏱</div>
                <div>
                  <div className="stat-value">{avgResponseLabel}</div>
                  <div className="stat-title">Tiempo de primera respuesta</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Chart Card: Estado de las conversaciones (Donut) */}
        <div className="dashboard-donut-card">
          <div className="chart-card-header">
            <h3 className="chart-card-title">Estado de las conversaciones</h3>
          </div>

          {donutTotal === 0 ? (
            <p style={{ color: 'var(--text-dim)', fontSize: 13, padding: '12px 0' }}>Todavía no hay conversaciones registradas.</p>
          ) : (
            <div className="donut-content-row">
              <div className="donut-chart-wrap">
                <svg viewBox="0 0 160 160" width="140" height="140" className="donut-svg">
                  <circle cx="80" cy="80" r="54" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="18" />
                  {donutArcs.map((arc) => (
                    <circle
                      key={arc.label}
                      cx="80"
                      cy="80"
                      r="54"
                      fill="none"
                      stroke={arc.color}
                      strokeWidth="18"
                      strokeDasharray={arc.dasharray}
                      strokeDashoffset={arc.dashoffset}
                    />
                  ))}
                </svg>
                <div className="donut-center-text">
                  <div className="donut-center-label">Total</div>
                  <div className="donut-center-number">{donutTotal}</div>
                </div>
              </div>

              <div className="donut-legend-list">
                {donutSegments.map((seg) => (
                  <div className="donut-legend-item" key={seg.label}>
                    <div className="legend-bullet-box">
                      <span className="bullet" style={{ background: seg.color }} />
                      <span>{seg.label}</span>
                    </div>
                    <span className="legend-count">{seg.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 4. RECENT CONVERSATIONS */}
      <section className="dashboard-tables-row">
        <div className="dashboard-table-card" style={{ gridColumn: '1 / -1' }}>
          <div className="table-card-header">
            <h3 className="chart-card-title">Conversaciones sin asignar</h3>
            <button
              type="button"
              className="table-card-link"
              onClick={() => navigate('/inbox')}
            >
              Ver todas →
            </button>
          </div>

          {recentConversations.length === 0 ? (
            <p style={{ color: 'var(--text-dim)', fontSize: 13, padding: '12px 4px' }}>No hay conversaciones sin asignar en este momento.</p>
          ) : (
            <div className="table-responsive">
              <table className="dashboard-data-table">
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th>Mensaje</th>
                    <th>Estado</th>
                    <th style={{ textAlign: 'right' }}>Hora</th>
                  </tr>
                </thead>
                <tbody>
                  {recentConversations.map((item) => (
                    <tr
                      key={item.id}
                      onClick={() => navigate('/inbox')}
                      className="clickable-table-row"
                    >
                      <td>
                        <div className="table-contact-cell">
                          <div className="table-avatar-wrap">
                            {item.avatarUrl ? (
                              <img src={item.avatarUrl} alt={item.name} className="table-avatar-img" />
                            ) : (
                              <div className="table-avatar-fallback">{initialsOf(item.name)}</div>
                            )}
                            <span className="table-wa-icon-badge">
                              <svg viewBox="0 0 24 24" fill="#25d366" width="10" height="10">
                                <path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.182-.573c.978.58 1.911.928 3.145.929 3.178 0 5.767-2.587 5.768-5.766.001-3.187-2.575-5.77-5.764-5.771z" />
                              </svg>
                            </span>
                          </div>
                          <span className="table-contact-name">{item.name}</span>
                        </div>
                      </td>
                      <td className="table-msg-preview">{item.preview}</td>
                      <td>
                        <span
                          className="table-status-pill"
                          style={{
                            color: item.statusColor,
                            borderColor: `${item.statusColor}40`,
                            backgroundColor: `${item.statusColor}15`
                          }}
                        >
                          ● {item.status}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 12 }}>
                        {item.time}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* 5. BOTTOM BRAND BANNER */}
      <footer className="dashboard-footer-brand-bar">
        <div className="footer-brand-title">NIRO</div>
        <div className="footer-brand-slogan">TU NEGOCIO CON INTELIGENCIA REAL</div>
        <div className="footer-brand-tags">
          <span className="footer-tag">💬 WhatsApp</span>
          <span className="footer-tag">🚀 Automatiza</span>
          <span className="footer-tag">🛒 Vende</span>
          <span className="footer-tag">📊 Crece</span>
        </div>
      </footer>

      {showWaModal && (
        <WhatsAppConnectModal onClose={() => setShowWaModal(false)} />
      )}
    </div>
  );
}
