const CSRF_COOKIE = 'niro_csrf';
let refreshPromise: Promise<boolean> | null = null;

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export async function refreshAccessSession(): Promise<boolean> {
  if (!refreshPromise) {
    const attempt = () => fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    refreshPromise = attempt()
      .then(async (response) => {
        // 409: another tab is renewing the shared cookie right now. Retry once with the new cookie.
        if (response.status === 409) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          return (await attempt()).ok;
        }
        return response.ok;
      })
      .catch(() => false)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
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
    throw new ApiError(res.status, message, body?.details);
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
