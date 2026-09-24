import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiGet, apiPost, ApiError, refreshSession } from '../lib/api';
import { connectSocketFor, disconnectSocket } from '../lib/socket';
import type { CurrentUser } from '../types';

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<CurrentUser>;
  logout: () => Promise<CurrentUser | null>;
  stopImpersonation: () => Promise<CurrentUser>;
  refreshMe: () => Promise<void>;
  setUser: (user: CurrentUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Carga el usuario de la sesión. La cookie de acceso dura 15 minutos, pero la de renovación dura semanas:
  // si el acceso venció (p. ej. el navegador estuvo cerrado), se renueva en silencio en vez de pedir QR.
  // Solo se considera "sin sesión" cuando el servidor confirma que la renovación fue rechazada; un corte de
  // red o un reinicio del servidor lanza el error y no cierra la sesión.
  const refreshMe = useCallback(async () => {
    try {
      const data = await apiGet<{ user: CurrentUser }>('/api/auth/me');
      setUser(data.user);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) throw err;
      const renewed = await refreshSession();
      if (renewed === 'denied') { setUser(null); return; }
      if (renewed === 'unavailable') throw new Error('No se pudo renovar la sesión');
      const data = await apiGet<{ user: CurrentUser }>('/api/auth/me');
      setUser(data.user);
    }
  }, []);

  useEffect(() => {
    // Al abrir: si el servidor no responde (reinicio, deploy), reintenta unos segundos antes de rendirse.
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 7 && !cancelled; attempt += 1) {
        try { await refreshMe(); break; } catch { await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 800 * (attempt + 1)))); }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [refreshMe]);

  // El tiempo real sigue a la sesión: se abre al entrar, se reabre si entra otra persona en la misma pestaña
  // y se corta al salir (antes quedaba conectado como el usuario anterior y el nuevo figuraba "Desconectado").
  useEffect(() => {
    if (user) connectSocketFor(user.id);
    else if (!loading) disconnectSocket();
  }, [user?.id, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Si el administrador cambia tus permisos, se reflejan al volver a esta pestaña.
  useEffect(() => {
    let last = 0;
    const onFocus = () => {
      if (Date.now() - last < 15000) return;
      last = Date.now();
      refreshMe().catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshMe]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiPost<{ user: CurrentUser }>('/api/auth/login', { email, password });
    setUser(data.user);
    return data.user;
  }, []);

  // Cerrar sesión dentro de una sesión de soporte devuelve al superadmin a su panel: el servidor contesta con su usuario.
  const logout = useCallback(async () => {
    let restored: CurrentUser | null = null;
    try {
      const data = await apiPost<{ user?: CurrentUser } | undefined>('/api/auth/logout');
      restored = data?.user ?? null;
    } finally {
      setUser(restored);
    }
    return restored;
  }, []);

  const stopImpersonation = useCallback(async () => {
    const data = await apiPost<{ user: CurrentUser }>('/api/auth/stop-impersonation');
    setUser(data.user);
    return data.user;
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, stopImpersonation, refreshMe, setUser }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return ctx;
}
