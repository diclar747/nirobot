import { PresenceMenu } from './PresenceMenu';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme, type AppTheme } from '../context/ThemeContext';
import { Logo } from './Logo';
import { NiroMascot } from './NiroMascot';
import { WhatsAppConnectModal } from './WhatsAppConnectModal';
import { NotificationBell } from './NotificationBell';
import { BillingGate } from './BillingGate';
import { NotificationsProvider } from '../context/NotificationsContext';
import { NotificationCenter, NotificationSettingsModal, NotificationToasts } from './NotificationCenter';
import { can, isAdminRole } from '../lib/permissions';
import { apiGet } from '../lib/api';
import { getSocket } from '../lib/socket';
import '../styles/app-theme.css';
import '../styles/ui-fixes.css';
import { Ui } from './Ui';

type WhatsAppStatus = 'disconnected' | 'connecting' | 'qr' | 'connected';

interface WhatsAppStatusPayload {
  status: WhatsAppStatus;
  avatarUrl?: string | null;
  // La conexión falló varias veces pero las credenciales siguen guardadas: se puede reconectar sin escanear otro QR.
  needsManualReconnect?: boolean;
}

function initials(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

function formatPhone(digits: string) {
  if (digits.startsWith('595') && digits.length === 12) {
    return `+595 ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  }
  return `+${digits}`;
}

// Usuarios creados por conexión de WhatsApp: el nombre trae el número pegado y el email es interno (@niro.local).
function userIdentity(u: { name: string; email: string }) {
  const generated = /^admin\.(\d{6,})\.[^@]*@niro\.local$/i.exec(u.email || '');
  const name = u.name.replace(/\s+\d{6,}\s*$/, '').trim() || u.name;
  return { name, contact: generated ? formatPhone(generated[1]) : u.email };
}

export function Layout() {
  const { user, logout } = useAuth();
  const identity = user ? userIdentity(user) : { name: '', contact: '' };
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileMenu, setMobileMenu] = useState(false);
  useEffect(() => { setMobileMenu(false); }, [location.pathname]);
  useEffect(() => {
    if (!mobileMenu) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileMenu(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [mobileMenu]);
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [globalSearch, setGlobalSearch] = useState('');
  const [waStatus, setWaStatus] = useState<WhatsAppStatus>('disconnected');
  const [whatsappAvatarUrl, setWhatsappAvatarUrl] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('niro_sidebar_collapsed') === 'true');
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [unreadConversationsCount, setUnreadConversationsCount] = useState(0);
  const [showNotifSettings, setShowNotifSettings] = useState(false);
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
        if (res.status === 'disconnected' && !res.needsManualReconnect) forcePortalLogout();
      })
      .catch(() => {});

    const refreshOpenCount = () => {
      // Chats con mensajes sin leer (para este usuario), no chats abiertos.
      apiGet<{ conversations: number }>('/api/org/conversations/unread-summary')
        .then((res) => setUnreadConversationsCount(res.conversations || 0))
        .catch(() => {});
    };
    refreshOpenCount();

    const socket = getSocket();
    const onStatus = (payload: WhatsAppStatusPayload & { lastError?: string | null }) => {
      setWaStatus(payload.status);
      setWhatsappAvatarUrl(payload.avatarUrl || null);
      if (payload.status === 'disconnected' && !payload.needsManualReconnect) forcePortalLogout();
    };

    socket.on('whatsapp:status', onStatus);
    socket.on('message:new', refreshOpenCount);
    socket.on('conversation:new', refreshOpenCount);
    socket.on('conversation:updated', refreshOpenCount);
    socket.on('conversation:read', refreshOpenCount);

    return () => {
      socket.off('whatsapp:status', onStatus);
      socket.off('message:new', refreshOpenCount);
      socket.off('conversation:new', refreshOpenCount);
      socket.off('conversation:updated', refreshOpenCount);
      socket.off('conversation:read', refreshOpenCount);
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
  const isAdmin = isAdminRole(user);

  return (
    <NotificationsProvider>
    <div ref={appShellRef} className={`modern-app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${mobileMenu ? 'mobile-menu-open' : ''}`} >
      {/* SIDEBAR */}
      {mobileMenu && <button type="button" className="mobile-menu-backdrop" aria-label="Cerrar menú" onClick={() => setMobileMenu(false)} />}
      <aside id="app-navigation" className={`modern-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
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
          <nav onClick={(event) => { if ((event.target as HTMLElement).closest('a')) setMobileMenu(false); }} className="sidebar-nav-list" style={{ flex: 1, overflowY: 'auto' }}>
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

            {isSuperadmin && (
              <NavLink to="/planes" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9" />
                  </svg>
                  <span>Planes</span>
                </div>
              </NavLink>
            )}

            {isSuperadmin && (
              <NavLink to="/sms-admin" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="6" y="2" width="12" height="20" rx="2.5" />
                    <line x1="11" y1="18" x2="13" y2="18" />
                    <path d="M9.5 7.5h5M9.5 11h5" />
                  </svg>
                  <span>SMS</span>
                </div>
              </NavLink>
            )}

            {isSuperadmin && (
              <NavLink to="/clientes" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="5" width="20" height="14" rx="2" />
                    <line x1="2" y1="10" x2="22" y2="10" />
                  </svg>
                  <span>Clientes y cobros</span>
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

            {!isSuperadmin && can(user, 'contacts') &&(
              <NavLink to="/contactos" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                  <span>Contactos</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && can(user, 'groups') && (
              <NavLink to="/grupos" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="8" r="3" />
                    <circle cx="5" cy="10" r="2" />
                    <circle cx="19" cy="10" r="2" />
                    <path d="M7 20v-1.5a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4V20" />
                    <path d="M2 19v-1a3 3 0 0 1 3-3M22 19v-1a3 3 0 0 0-3-3" />
                  </svg>
                  <span>Grupos</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && isAdmin &&(
              <NavLink to="/billing" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="5" width="20" height="14" rx="2" />
                    <line x1="2" y1="10" x2="22" y2="10" />
                  </svg>
                  <span>Mi plan</span>
                </div>
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
              <NavLink to="/departments" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="7" height="7" rx="1.5" />
                    <rect x="14" y="3" width="7" height="7" rx="1.5" />
                    <rect x="3" y="14" width="7" height="7" rx="1.5" />
                    <rect x="14" y="14" width="7" height="7" rx="1.5" />
                  </svg>
                  <span>Áreas</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && can(user, 'aiAgents') &&(
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

            {!isSuperadmin && can(user, 'bot') &&(
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

            {!isSuperadmin && can(user, 'orders') &&(
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

            {!isSuperadmin && can(user, 'crm') &&(
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

            {!isSuperadmin && can(user, 'management') &&(
              <NavLink to="/gestion" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 3v18h18" />
                    <path d="m7 15 4-4 3 3 5-6" />
                  </svg>
                  <span>Gestión</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && can(user, 'reports') &&(
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

            {!isSuperadmin && can(user, 'history') &&(
              <NavLink to="/historial" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="9" />
                    <polyline points="12 7 12 12 15.5 14" />
                  </svg>
                  <span>Historial</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && can(user, 'sms') && ['OWNER', 'ADMIN', 'SUPERVISOR'].includes(user.role) && (
              <NavLink to="/sms" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="6" y="2" width="12" height="20" rx="2.5" />
                    <line x1="11" y1="18" x2="13" y2="18" />
                    <path d="M9.5 7.5h5M9.5 11h5" />
                  </svg>
                  <span>SMS</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && can(user, 'campaigns') &&(
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

            {!isSuperadmin && can(user, 'statuses') &&(
              <NavLink to="/estados" className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}>
                <div className="sidebar-nav-item-content">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="9" strokeDasharray="4 3" />
                    <circle cx="12" cy="12" r="4" />
                  </svg>
                  <span>Estados WhatsApp</span>
                </div>
              </NavLink>
            )}

            {!isSuperadmin && can(user, 'calls') &&(
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

            {!isSuperadmin && can(user, 'developers') &&(
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
          <button type="button" className="mobile-menu-toggle" aria-label={mobileMenu ? 'Cerrar menú' : 'Abrir menú'} aria-expanded={mobileMenu} aria-controls="app-navigation" onClick={() => setMobileMenu((open) => !open)}><span aria-hidden="true" style={{ fontSize: 22 }}>☰</span></button>
          <span className="mobile-brand">NIRO<span> Workspace</span></span>
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
            {!isSuperadmin && <NotificationCenter onOpenSettings={() => setShowNotifSettings(true)} />}
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

            <PresenceMenu />

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
                  <div className="topbar-user-name">{identity.name}</div>
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
                    <div style={{ fontWeight: 600, color: 'var(--text-main)' }}>{identity.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{identity.contact}</div>
                  </div>
                  <div className="dropdown-divider" />
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => { setShowUserMenu(false); navigate('/settings'); }}
                  >
                    <Ui name="settings" size={16} /> Configuración
                  </button>
                  {!isSuperadmin && (
                    <button
                      type="button"
                      className="dropdown-item"
                      onClick={() => { setShowUserMenu(false); setShowNotifSettings(true); }}
                    >
                      <Ui name="bell" size={16} /> Sonidos y notificaciones
                    </button>
                  )}
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => { setShowUserMenu(false); setShowWhatsAppModal(true); }}
                  >
                    <Ui name="chat" size={16} /> Estado WhatsApp ({waStatus === 'connected' ? 'Conectado' : waStatus === 'connecting' || waStatus === 'qr' ? 'Reconectando' : 'Desconectado'})
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
          <BillingGate>
            <Outlet />
          </BillingGate>
        </main>
      </div>

      {showWhatsAppModal && (
        <WhatsAppConnectModal onClose={() => setShowWhatsAppModal(false)} />
      )}
      {!isSuperadmin && <NotificationToasts />}
      {showNotifSettings && <NotificationSettingsModal onClose={() => setShowNotifSettings(false)} />}
    </div>
    </NotificationsProvider>
  );
}
