import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import '../styles/alerts.css';
import { Ui, type UiIconName } from '../components/Ui';

export type AlertTone = 'success' | 'error' | 'warning' | 'info';

type NotifyOptions = {
  tone?: AlertTone;
  title?: string;
  duration?: number;
};

type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'warning';
};

type Toast = {
  id: string;
  message: string;
  tone: AlertTone;
  title: string;
};

type ConfirmState = ConfirmOptions & { resolve: (value: boolean) => void };

type AlertContextValue = {
  notify: (message: string, options?: NotifyOptions) => void;
  confirm: (options: ConfirmOptions | string) => Promise<boolean>;
};

const AlertContext = createContext<AlertContextValue | null>(null);

const TONE_META: Record<AlertTone, { icon: UiIconName; title: string }> = {
  success: { icon: 'check-circle', title: 'Listo' },
  error: { icon: 'x-circle', title: 'Ocurrió un problema' },
  warning: { icon: 'alert', title: 'Atención' },
  info: { icon: 'info', title: 'Información' }
};

export function AlertProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const timersRef = useRef(new Map<string, number>());
  const confirmRef = useRef<ConfirmState | null>(null);

  const removeToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) window.clearTimeout(timer);
    timersRef.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback((message: string, options: NotifyOptions = {}) => {
    const tone = options.tone || 'info';
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const toast: Toast = { id, message, tone, title: options.title || TONE_META[tone].title };
    setToasts((current) => [...current.slice(-3), toast]);
    const duration = options.duration ?? (tone === 'error' ? 5200 : 3600);
    timersRef.current.set(id, window.setTimeout(() => removeToast(id), duration));
  }, [removeToast]);

  const confirm = useCallback((options: ConfirmOptions | string) => new Promise<boolean>((resolve) => {
    const next = typeof options === 'string' ? { message: options } : options;
    confirmRef.current?.resolve(false);
    const nextState = { ...next, resolve };
    confirmRef.current = nextState;
    setConfirmState(nextState);
  }), []);

  const finishConfirm = useCallback((value: boolean) => {
    const current = confirmRef.current;
    confirmRef.current = null;
    current?.resolve(value);
    setConfirmState(null);
  }, []);

  useEffect(() => {
    if (!confirmState) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finishConfirm(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [confirmState, finishConfirm]);

  useEffect(() => () => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    confirmRef.current?.resolve(false);
    confirmRef.current = null;
  }, []);

  return (
    <AlertContext.Provider value={{ notify, confirm }}>
      {children}

      <div className="modern-alert-viewport" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => {
          const meta = TONE_META[toast.tone];
          return (
            <div key={toast.id} className={`modern-toast ${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
              <span className="modern-toast-icon" aria-hidden="true"><Ui name={meta.icon} size={18} /></span>
              <div className="modern-toast-content">
                <strong>{toast.title}</strong>
                <span>{toast.message}</span>
              </div>
              <button type="button" className="modern-toast-close" onClick={() => removeToast(toast.id)} aria-label="Cerrar aviso">×</button>
            </div>
          );
        })}
      </div>

      {confirmState && (
        <div className="modern-confirm-backdrop">
          <div className="modern-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="modern-confirm-title" aria-describedby="modern-confirm-message">
            <div className={`modern-confirm-icon ${confirmState.tone || 'warning'}`} aria-hidden="true">{confirmState.tone === 'danger' ? '!' : '?'}</div>
            <div className="modern-confirm-copy">
              <h2 id="modern-confirm-title">{confirmState.title || '¿Querés continuar?'}</h2>
              <p id="modern-confirm-message">{confirmState.message}</p>
            </div>
            <div className="modern-confirm-actions">
              <button type="button" className="btn secondary" onClick={() => finishConfirm(false)}>{confirmState.cancelLabel || 'Cancelar'}</button>
              <button type="button" className={`btn ${confirmState.tone === 'danger' ? 'danger' : ''}`} onClick={() => finishConfirm(true)}>{confirmState.confirmLabel || 'Aceptar'}</button>
            </div>
          </div>
        </div>
      )}
    </AlertContext.Provider>
  );
}

export function useAlerts() {
  const context = useContext(AlertContext);
  if (!context) throw new Error('useAlerts debe usarse dentro de AlertProvider');
  return context;
}
