import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import type { UserRole } from '../types';
import { can, type PermissionKey } from '../lib/permissions';

export function ProtectedRoute({ roles, permission }: { roles?: UserRole[]; permission?: PermissionKey }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div className="pwa-launch" role="status"><img src="/icons/niro-192.png" alt="Robot de NIRO" width="112" height="112" /><strong>NIRO Enterprise</strong><span>Abriendo tu espacio de trabajo…</span></div>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  if (permission && !can(user, permission)) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
        <h2 style={{ color: 'var(--text-main)' }}>Función no habilitada</h2>
        <p>Tu administrador no activó esta función para tu usuario. Pedile acceso si la necesitás.</p>
      </div>
    );
  }

  return <Outlet />;
}
