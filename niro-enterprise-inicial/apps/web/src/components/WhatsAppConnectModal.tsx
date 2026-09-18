import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { apiGet, apiPost, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';

type WhatsAppStatus = 'disconnected' | 'connecting' | 'qr' | 'connected';

interface StatusPayload {
  status: WhatsAppStatus;
  qr: string | null;
  phone: string | null;
}

export function WhatsAppConnectModal({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<StatusPayload>({ status: 'disconnected', qr: null, phone: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function handleConnect() {
    setError(null);
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
            <h4 style={{ margin: '0 0 8px 0', fontSize: 16 }}>Iniciando conexión...</h4>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>Generando el código QR, un momento.</p>
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
