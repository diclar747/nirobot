import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme, type AppTheme } from '../context/ThemeContext';
import { Logo } from './Logo';
import { NiroMascot } from './NiroMascot';
import { WhatsAppConnectModal } from './WhatsAppConnectModal';
import { NotificationBell } from './NotificationBell';
import { apiGet } from '../lib/api';
import { getSocket } from '../lib/socket';
import '../styles/app-theme.css';
import '../styles/ui-fixes.css';

type WhatsAppStatus = 'disconnected' | 'connecting' | 'qr' | 'connected';

interface WhatsAppStatusPayload {
  status: WhatsAppStatus;
  avatarUrl?: string | null;
}

function initials(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

export function Layout() {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [globalSearch, setGlobalSearch] = useState('');
  const [waStatus, setWaStatus] = useState<WhatsAppStatus>('disconnected');
  const [whatsappAvatarUrl, setWhatsappAvatarUrl] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('niro_sidebar_collapsed') === 'true');
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [unreadConversationsCount, setUnreadConversationsCount] = useState(0);
  const appShellRef = useRef<HTMLDivElement>(null);
  const whatsappLogoutRef = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  function toggleSidebar() {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('niro_sidebar_collapsed', String(next));
      return next;
    });
  }

  function cycleTheme() {
    if (theme === 'blue') setTheme('light' as AppTheme);
    else if (theme === 'light') setTheme('dark' as AppTheme);
    else setTheme('blue' as AppTheme);
  }

  useEffect(() => {
    if (!user || user.role === 'SUPERADMIN') return;
    whatsappLogoutRef.current = false;

    const forcePortalLogout = () => {
      if (whatsappLogoutRef.current) return;
      whatsappLogoutRef.current = true;
      void logout().finally(() => navigate('/login', {
        replace: true,
        state: { whatsappLoggedOut: true }
      }));
    };

    setWhatsappAvatarUrl(null);
    apiGet<WhatsAppStatusPayload>('/api/org/whatsapp/status')
      .then((res) => {
        setWaStatus(res.status);
        setWhatsappAvatarUrl(res.avatarUrl || null);
        if (res.status === 'disconnected') forcePortalLogout();
      })
      .catch(() => {});

    const refreshOpenCount = () => {
      apiGet<{ conversations: { status: string }[] }>('/api/org/conversations?status=OPEN')
        .then((res) => setUnreadConversationsCount(res.conversations?.length || 0))
        .catch(() => {});
    };
    refreshOpenCount();

    const socket = getSocket();
    const onStatus = (payload: WhatsAppStatusPayload & { lastError?: string | null }) => {
      setWaStatus(payload.status);
      setWhatsappAvatarUrl(payload.avatarUrl || null);
      if (payload.status === 'disconnected') forcePortalLogout();
    };

    socket.on('whatsapp:status', onStatus);
    socket.on('message:new', refreshOpenCount);
    socket.on('conversation:new', refreshOpenCount);
    socket.on('conversation:updated', refreshOpenCount);

    return () => {
      socket.off('whatsapp:status', onStatus);
      socket.off('message:new', refreshOpenCount);
      socket.off('conversation:new', refreshOpenCount);
      socket.off('conversation:updated', refreshOpenCount);
    };
  }, [logout, navigate, user]);

  // Global Ctrl+K search listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        const input = document.getElementById('global-search-input');
        input?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsFullscreen(document.fullscreenElement === appShellRef.current);
    };

    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState);
  }, []);

  // Clic en una notificación push: el service worker enfoca la pestaña y manda esto para que la
  // app navegue a la conversación correspondiente.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'niro-push-navigate' && typeof event.data.url === 'string') {
        navigate(event.data.url);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  if (!user) return null;

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  async function toggleFullscreen() {
    const appShell = appShellRef.current;
    if (!appShell) return;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (appShell.requestFullscreen) {
        await appShell.requestFullscreen();
      }
    } catch {
      // Algunos navegadores pueden rechazar la solicitud si no proviene de una
      // interacción directa. El botón sigue disponible para volver a intentarlo.
    }
  }

  const isSuperadmin = user.role === 'SUPERADMIN';
  const canManageUsers = ['OWNER', 'ADMIN', 'SUPERVISOR'].includes(user.role);
  const canManageSettings = ['OWNER', 'ADMIN'].includes(user.role);
  const canSeeReports = ['OWNER', 'ADMIN', 'SUPERVISOR'].includes(user.role);

  return (
    <div ref={appShellRef} className={`modern-app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      {/* SIDEBAR */}
      <aside className={`modern-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <button
          type="button"
          className="sidebar-collapse-toggle"
          onClick={toggleSidebar}
          title={sidebarCollapsed ? 'Expandir menú' : 'Minimizar menú'}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: sidebarCollapsed ? 'rotate(180deg)' : 'none' }}>
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {/* Logo Header */}
          <NavLink to="/dashboard" className="sidebar-brand-box">
            <Logo size={36} />
            <div className="sidebar-brand-text-col">
              <span className="sidebar-brand-title">NIRO</span>
              <span className="sidebar-brand-slogan">AI WhatsApp CRM</span>
            </div>
          </NavLink>

          {/* Navigation Items */}
          <nav className="sidebar-nav-list" style={{ flex: 1, overflowY: 'auto' }}>
            <NavLink to="/dashboard" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`} end>
              <div className="sidebar-nav-item-content">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <polyline points="9 22 9 12 15 12 15 22" />
                </svg>
                <span>Dashboard</span>
              </div>
            </NavLink>

            {isSuperadmin && (
              <NavLink to="/organizations" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
                    <line x1="9" y1="22" x2="9" y2="22" />
                    <line x1="8" y1="6" x2="8.01" y2="6" />
                    <line x1="16" y1="6" x2="16.01" y2="6" />
                    <line x1="12" y1="6" x2="12.01" y2="6" />
                    <line x1="12" y1="10" x2="12.01" y2="10" />
                    <line x1="12" y1="14" x2="12.01" y2="14" />
                  </svg>
                  <span>Organizaciones</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && (
              <NavLink to="/inbox" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <span>Conversaciones</span>
                </div>
                {unreadConversationsCount > 0 && (
                  <span className="sidebar-badge-count">{unreadConversationsCount}</span>
                )}
              </NavLink>
            )}

            {!isSuperadmin && canManageUsers && (
              <NavLink to="/users" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="11" width="18" height="10" rx="2" />
                    <circle cx="12" cy="5" r="3" />
                    <line x1="12" y1="8" x2="12" y2="11" />
                  </svg>
                  <span>Usuarios</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && (
              <NavLink to="/ai-agents" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="9" width="18" height="11" rx="2" />
                    <circle cx="8.5" cy="14.5" r="1.2" fill="currentColor" stroke="none" />
                    <circle cx="15.5" cy="14.5" r="1.2" fill="currentColor" stroke="none" />
                    <path d="M12 9V5" />
                    <circle cx="12" cy="3.5" r="1.5" />
                  </svg>
                  <span>Agentes IA</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && (
              <NavLink to="/bot" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="5" cy="12" r="2" />
                    <circle cx="19" cy="6" r="2" />
                    <circle cx="19" cy="18" r="2" />
                    <path d="M7 12h5a4 4 0 0 0 4-4V8M12 12a4 4 0 0 1 4 4v0" />
                  </svg>
                  <span>Flujos de Bot</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && (
              <NavLink to="/orders" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="9" cy="21" r="1" />
                    <circle cx="20" cy="21" r="1" />
                    <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
                  </svg>
                  <span>Pedidos</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && (
              <NavLink to="/board" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="7" height="18" rx="1" />
                    <rect x="14" y="3" width="7" height="10" rx="1" />
                    <rect x="14" y="17" width="7" height="4" rx="1" />
                  </svg>
                  <span>CRM</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && canSeeReports && (
              <NavLink to="/reports" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="20" x2="18" y2="10" />
                    <line x1="12" y1="20" x2="12" y2="4" />
                    <line x1="6" y1="20" x2="6" y2="14" />
                  </svg>
                  <span>Reportes</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && canSeeReports && (
              <NavLink to="/campaigns" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 2 11 13" />
                    <path d="M22 2 15 22 11 13 2 9 22 2Z" />
                  </svg>
                  <span>Campañas</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && canSeeReports && (
              <NavLink to="/llamadas" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.63a2 2 0 0 1-.45 2.11L8 9.73a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.85.29 1.73.5 2.63.62A2 2 0 0 1 22 16.92z" />
                  </svg>
                  <span>Llamadas WhatsApp</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && (
              <button
                type="button"
                className="sidebar-nav-item"
                onClick={() => setShowWhatsAppModal(true)}
              >
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                  <span>Integraciones</span>
                </div>
              </button>
            )}

            {!isSuperadmin && (
              <NavLink to="/desarrolladores" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M8 9 5 12l3 3" />
                    <path d="m16 9 3 3-3 3" />
                    <path d="m14 5-4 14" />
                  </svg>
                  <span>API & Desarrolladores</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && canManageSettings && (
              <NavLink to="/settings" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span>Configuración</span>
                </div>
              </NavLink>
            )}
          </nav>

          {/* Niro AI Mascot Promo Box at Bottom of Sidebar */}
          {!sidebarCollapsed && (
            <div className="sidebar-mascot-promo-card">
              <div className="sidebar-mascot-img-wrap">
                <NiroMascot size={64} />
              </div>
              <div className="sidebar-mascot-title">Niro siempre trabajando para vos</div>
              <div className="sidebar-mascot-desc">Automatiza. Atiende. Vende. Haz crecer tu negocio.</div>
              <button
                type="button"
                className="sidebar-mascot-btn"
                onClick={() => window.open('https://wa.me/', '_blank')}
              >
                Ver Tutorial
              </button>
              <div className="sidebar-mascot-footer">
                <strong>CNID</strong> · Centro Nacional de Información Digital
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* MAIN VIEW AREA */}
      <div className="modern-main-area">
        {/* TOPBAR */}
        <header className="modern-topbar">
          <div className="topbar-search-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              id="global-search-input"
              type="text"
              className="topbar-search-input"
              placeholder="Buscar conversaciones, clientes, pedidos..."
              value={globalSearch}
              onChange={(e) => setGlobalSearch(e.target.value)}
            />
            <span className="topbar-search-shortcut">Ctrl + K</span>
          </div>

          <div className="topbar-actions">
            <button
              type="button"
              className={`topbar-icon-btn fullscreen-toggle ${isFullscreen ? 'is-active' : ''}`}
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? 'Salir de pantalla completa' : 'Activar pantalla completa'}
              aria-pressed={isFullscreen}
              title={isFullscreen ? 'Salir de pantalla completa (Esc)' : 'Activar pantalla completa'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18" aria-hidden="true">
                {isFullscreen ? (
                  <>
                    <polyline points="9 14 4 14 4 19" />
                    <polyline points="15 10 20 10 20 5" />
                    <line x1="4" y1="14" x2="10" y2="20" />
                    <line x1="14" y1="4" x2="20" y2="10" />
                  </>
                ) : (
                  <>
                    <polyline points="8 3 3 3 3 8" />
                    <polyline points="16 3 21 3 21 8" />
                    <polyline points="8 21 3 21 3 16" />
                    <polyline points="16 21 21 21 21 16" />
                  </>
                )}
              </svg>
            </button>
            <NotificationBell />

            {/* Theme Toggle Button (Sun / Moon) */}
            <button
              type="button"
              className="topbar-icon-btn"
              onClick={cycleTheme}
              title={`Tema actual: ${theme}. Haz clic para cambiar`}
            >
              {theme === 'light' ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </button>

            {/* User Profile Pill & Dropdown */}
            <div className="topbar-user-dropdown-container">
              <button
                type="button"
                className="topbar-user-pill"
                onClick={() => setShowUserMenu((prev) => !prev)}
              >
                <div className="topbar-user-avatar">
                  {whatsappAvatarUrl ? <img src={whatsappAvatarUrl} alt={`Perfil de WhatsApp de ${user.name}`} /> : initials(user.name)}
                </div>
                <div className="topbar-user-info">
                  <div className="topbar-user-name">{user.name}</div>
                  <div className="topbar-user-subtitle">
                    {user.role} {user.organization ? `· ${user.organization.name}` : ''}
                  </div>
                </div>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" style={{ color: 'var(--text-dim)', marginLeft: 2 }}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {showUserMenu && (
                <div className="topbar-dropdown-menu">
                  <div className="dropdown-header">
                    <div style={{ fontWeight: 600, color: 'var(--text-main)' }}>{user.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{user.email}</div>
                  </div>
                  <div className="dropdown-divider" />
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => { setShowUserMenu(false); navigate('/settings'); }}
                  >
                    ⚙ Configuración
                  </button>
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => { setShowUserMenu(false); setShowWhatsAppModal(true); }}
                  >
                    💬 Estado WhatsApp ({waStatus === 'connected' ? 'Conectado' : waStatus === 'connecting' || waStatus === 'qr' ? 'Reconectando' : 'Desconectado'})
                  </button>
                  <div className="dropdown-divider" />
                  <button
                    type="button"
                    className="dropdown-item logout"
                    onClick={handleLogout}
                  >
                    ⏻ Cerrar sesión
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* PAGE CONTENT */}
        <main style={{ flex: 1, overflowY: 'auto' }}>
          <Outlet />
        </main>
      </div>

      {showWhatsAppModal && (
        <WhatsAppConnectModal onClose={() => setShowWhatsAppModal(false)} />
      )}
    </div>
  );
}
