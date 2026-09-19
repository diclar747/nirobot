import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { apiGet, apiPost, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';

type WhatsAppStatus = 'disconnected' | 'connecting' | 'qr' | 'connected';

interface StatusPayload {
  status: WhatsAppStatus;
  qr: string | null;
  phone: string | null;
  lastError?: string | null;
}

const STATUS_POLL_INTERVAL_MS = 1000;
const QR_STATUS_POLL_INTERVAL_MS = 4000;
const CONNECTION_TIMEOUT_MS = 30000;

export function WhatsAppConnectModal({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<StatusPayload>({ status: 'disconnected', qr: null, phone: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slowReconnect, setSlowReconnect] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    apiGet<StatusPayload>('/api/org/whatsapp/status')
      .then(setState)
      .catch(() => {})
      .finally(() => setLoading(false));

    const socket = getSocket();
    const onStatus = (payload: StatusPayload) => setState(payload);
    socket.on('whatsapp:status', onStatus);
    return () => {
      socket.off('whatsapp:status', onStatus);
    };
  }, []);

  // Socket.IO is the fast path, but it can reconnect after the API or the browser
  // restarts. Polling while a QR is being negotiated makes the modal recover the
  // QR even when the status event was emitted before the listener was ready.
  useEffect(() => {
    if (loading || !['connecting', 'qr'].includes(state.status)) return;

    let cancelled = false;
    const startedAt = Date.now();

    const poll = async () => {
      try {
        const next = await apiGet<StatusPayload>('/api/org/whatsapp/status');
        if (cancelled) return;
        setState(next);
        if (next.status === 'connected') setSlowReconnect(false);

        if (next.status === 'connecting' && Date.now() - startedAt >= CONNECTION_TIMEOUT_MS) {
          setSlowReconnect(true);
          setError('El servidor todavía está reconectando WhatsApp. La sesión del teléfono no se borra ni se solicita otro QR automáticamente.');
        }

        if (next.status === 'connecting' || next.status === 'qr') {
          pollTimer.current = setTimeout(poll, next.status === 'qr' ? QR_STATUS_POLL_INTERVAL_MS : STATUS_POLL_INTERVAL_MS);
        }
      } catch {
        if (!cancelled) {
          pollTimer.current = setTimeout(poll, STATUS_POLL_INTERVAL_MS);
        }
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
      pollTimer.current = null;
    };
  }, [loading, state.status]);

  async function handleConnect() {
    setError(null);
    setSlowReconnect(false);
    setBusy(true);
    try {
      const res = await apiPost<StatusPayload>('/api/org/whatsapp/connect');
      setState(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo iniciar la conexión con WhatsApp');
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setError(null);
    setBusy(true);
    try {
      const res = await apiPost<StatusPayload>('/api/org/whatsapp/disconnect');
      setState(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo desconectar WhatsApp');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Conectar WhatsApp" onClose={onClose}>
      <div style={{ textAlign: 'center', padding: '10px 0' }}>
        {loading && <p style={{ color: 'var(--text-muted)' }}>Cargando estado...</p>}

        {!loading && error && (
          <p style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 14 }}>{error}</p>
        )}

        {!loading && state.status === 'disconnected' && (
          <div style={{ padding: '10px 0' }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>📵</div>
            <h4 style={{ margin: '0 0 8px 0', fontSize: 16 }}>WhatsApp no conectado</h4>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 18px 0' }}>
              Conectá un número real de WhatsApp escaneando un código QR desde el teléfono de la empresa.
            </p>
            <button
              type="button"
              className="btn"
              style={{ background: '#25d366', color: '#fff', width: '100%', justifyContent: 'center' }}
              onClick={handleConnect}
              disabled={busy}
            >
              {busy ? 'Iniciando...' : 'Generar código QR'}
            </button>
          </div>
        )}

        {!loading && state.status === 'connecting' && !state.qr && (
          <div style={{ padding: '30px 0' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🔄</div>
            <h4 style={{ margin: '0 0 8px 0', fontSize: 16 }}>{slowReconnect || state.lastError ? 'Reconectando WhatsApp...' : 'Iniciando conexión...'}</h4>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 16px' }}>{slowReconnect || state.lastError ? 'El teléfono puede seguir vinculado. El servidor está intentando recuperar el canal sin cerrar la sesión.' : 'Generando el código QR, un momento.'}</p>
            {(slowReconnect || state.lastError) && <button type="button" className="btn secondary" onClick={handleConnect} disabled={busy}>{busy ? 'Intentando…' : 'Solicitar un QR nuevo'}</button>}
          </div>
        )}

        {!loading && state.status === 'qr' && state.qr && (
          <div>
            <div style={{ display: 'inline-flex', padding: 12, background: '#ffffff', borderRadius: 16, border: '2px solid #25d366', boxShadow: '0 8px 30px rgba(37, 211, 102, 0.2)' }}>
              <img src={state.qr} width={200} height={200} alt="Código QR de WhatsApp" />
            </div>

            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '14px 0 6px 0' }}>
              Abrí WhatsApp en tu teléfono {'>'} Dispositivos vinculados {'>'} Vincular un dispositivo
            </p>
            <span style={{ fontSize: 11.5, color: 'var(--primary-text)', fontWeight: 600 }}>
              Esperando que escanees el código...
            </span>
          </div>
        )}

        {!loading && state.status === 'connected' && (
          <div style={{ padding: '20px 0' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(16,185,129,0.15)', color: '#10b981', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, margin: '0 auto 12px auto' }}>
              ✓
            </div>
            <h4 style={{ margin: '0 0 8px 0', fontSize: 17, color: '#10b981' }}>¡WhatsApp conectado!</h4>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 20px 0' }}>
              Número: <strong>+{state.phone}</strong>. Los mensajes entrantes y salientes ya se sincronizan con la bandeja.
            </p>
            <button
              type="button"
              className="btn"
              style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
              onClick={onClose}
            >
              Ir a la bandeja de conversaciones →
            </button>
            <button
              type="button"
              className="btn secondary"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={handleDisconnect}
              disabled={busy}
            >
              {busy ? 'Desconectando...' : 'Desconectar número'}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
