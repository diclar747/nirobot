const CSRF_COOKIE = 'niro_csrf';
// 'ok' renovó; 'denied' la sesión ya no existe (hay que volver a entrar); 'unavailable' no se pudo consultar
// (sin red, servidor reiniciando): en ese caso NO hay que cerrar la sesión del usuario.
export type RefreshResult = 'ok' | 'denied' | 'unavailable';
let refreshPromise: Promise<RefreshResult> | null = null;

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export class ApiError extends Error {
  status: number;
  details?: unknown;
  code?: string;

  constructor(status: number, message: string, details?: unknown, code?: string) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export async function refreshSession(): Promise<RefreshResult> {
  if (!refreshPromise) {
    const attempt = () => fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    const outcome = (response: Response): RefreshResult => (response.ok ? 'ok' : response.status === 401 || response.status === 403 ? 'denied' : 'unavailable');
    refreshPromise = attempt()
      .then(async (response) => {
        // 409: another tab is renewing the shared cookie right now. Retry once with the new cookie.
        if (response.status === 409) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          return outcome(await attempt());
        }
        return outcome(response);
      })
      .catch((): RefreshResult => 'unavailable')
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export async function refreshAccessSession(): Promise<boolean> {
  return (await refreshSession()) === 'ok';
}

export async function api<T = unknown>(path: string, options: RequestInit = {}, allowRefresh = true): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers);

  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body && !isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (MUTATING_METHODS.has(method)) {
    const csrfToken = readCookie(CSRF_COOKIE);
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  }

  const res = await fetch(path, { ...options, method, headers, credentials: 'include' });

  // Access tokens are intentionally short-lived. Refresh once and retry the
  // original request so an open dashboard does not look logged out after a
  // period of inactivity or an API restart. Auth endpoints are excluded to
  // avoid retry loops while logging in, refreshing, or logging out.
  if (res.status === 401 && allowRefresh && !path.startsWith('/api/auth/')) {
    const refreshed = await refreshAccessSession();
    if (refreshed) return api<T>(path, options, false);
  }

  if (res.status === 204) return undefined as T;

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;

  if (res.status === 402 && body?.code === 'SUBSCRIPTION_REQUIRED') window.dispatchEvent(new Event('niro:subscription-required'));

  if (!res.ok) {
    const message = (body && (body.error as string)) || `Error ${res.status}`;
    throw new ApiError(res.status, message, body?.details ?? body?.data, typeof body?.code === 'string' ? body.code : undefined);
  }

  return body as T;
}

export const apiGet = <T = unknown>(path: string) => api<T>(path);
export const apiPost = <T = unknown>(path: string, data?: unknown) =>
  api<T>(path, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) });
export const apiPatch = <T = unknown>(path: string, data?: unknown) =>
  api<T>(path, { method: 'PATCH', body: data === undefined ? undefined : JSON.stringify(data) });
export const apiDelete = <T = unknown>(path: string) => api<T>(path, { method: 'DELETE' });
export const apiUpload = <T = unknown>(path: string, formData: FormData) => api<T>(path, { method: 'POST', body: formData });
