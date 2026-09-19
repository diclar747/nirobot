import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ApiError, api, apiGet, apiPost } from '../lib/api';
import { Logo } from '../components/Logo';
import { NiroMascot } from '../components/NiroMascot';
import '../styles/qr-login.css';
import type { CurrentUser } from '../types';

type LoginMode = 'qr' | 'agent';
type QrStatus = 'disconnected' | 'connecting' | 'qr' | 'connected';

interface QrPayload {
  flowId: string;
  status: QrStatus;
  qr: string | null;
  phone: string | null;
  lastError?: string | null;
  setupRequired: boolean;
  organizationName?: string | null;
}

function destination() {
  // El acceso QR y el acceso de agentes siempre aterrizan en el panel
  // principal. Así una sesión recién iniciada no vuelve a una ruta protegida
  // anterior ni queda nuevamente en /login.
  return '/dashboard';
}

function qrBrowserKey() {
  const storageKey = 'niro.qr.browser.key';
  try {
    const existing = window.localStorage.getItem(storageKey);
    if (existing) return existing;
    const created = `browser-${crypto.randomUUID()}`;
    window.localStorage.setItem(storageKey, created);
    return created;
  } catch {
    return '';
  }
}

export function Login() {
  const { login, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<LoginMode>('qr');
  const [qr, setQr] = useState<QrPayload | null>(null);
  const [qrLoading, setQrLoading] = useState(true);
  const [qrError, setQrError] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [completing, setCompleting] = useState(false);
  const completingRef = useRef(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const sessionNotice = Boolean((location.state as { whatsappLoggedOut?: boolean } | null)?.whatsappLoggedOut);

  const completeQrLogin = useCallback(async (flowId: string) => {
    if (completingRef.current) return;
    completingRef.current = true;
    setCompleting(true);
    setQrError(null);
    try {
      const result = await apiPost<{ user: CurrentUser; phone: string }>('/api/auth/whatsapp/complete', {
        flowId,
        companyName: companyName.trim() || undefined,
        adminName: adminName.trim() || undefined
      });
      setUser(result.user);
      navigate(destination(), { replace: true });
    } catch (err) {
      completingRef.current = false;
      setCompleting(false);
      setQrError(err instanceof ApiError ? err.message : 'No se pudo completar el acceso con WhatsApp');
    }
  }, [adminName, companyName, location, navigate, setUser]);

  const startQr = useCallback(async () => {
    setQrLoading(true);
    setQrError(null);
    completingRef.current = false;
    setCompleting(false);
    try {
      const result = await api<QrPayload>('/api/auth/whatsapp/start', {
        method: 'POST',
        headers: { 'X-Niro-QR-Browser': qrBrowserKey() },
        body: '{}'
      });
      setQr(result);
    } catch (err) {
      setQrError(err instanceof ApiError ? err.message : 'No se pudo iniciar el acceso QR');
    } finally {
      setQrLoading(false);
    }
  }, []);

  useEffect(() => {
    startQr();
  }, [startQr]);

  useEffect(() => {
    if (!qr?.flowId || qr.status === 'connected') return;
    let active = true;
    const poll = async () => {
      try {
        const next = await apiGet<QrPayload>(`/api/auth/whatsapp/status/${qr.flowId}`);
        if (active) setQr(next);
      } catch (err) {
        if (active && err instanceof ApiError && err.status === 404) {
          // El flujo QR vive en memoria del proceso. Si la API se reinicia,
          // renovar automáticamente evita dejar al usuario en una pantalla
          // de error y mantiene la experiencia tipo WhatsApp Web.
          setQr(null);
          void startQr();
        }
      }
    };
    const timer = window.setInterval(poll, 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [qr?.flowId, qr?.status, startQr]);

  useEffect(() => {
    if (!qr || qr.status !== 'connected' || qr.setupRequired || completingRef.current) return;
    completeQrLogin(qr.flowId);
  }, [completeQrLogin, qr]);

  async function handleAgentLogin(e: FormEvent) {
    e.preventDefault();
    setAgentError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate(destination(), { replace: true });
    } catch (err) {
      setAgentError(err instanceof ApiError ? err.message : 'No se pudo iniciar sesión');
    } finally {
      setSubmitting(false);
    }
  }

  const showSetup = qr?.status === 'connected' && qr.setupRequired;
  const statusText = qr?.status === 'qr'
    ? 'Escaneá el código con tu teléfono'
    : qr?.status === 'connected'
      ? showSetup ? 'WhatsApp conectado' : 'Verificando tu cuenta'
      : 'Preparando conexión segura';

  return (
    <div className="qr-login-shell">
      <div className="qr-login-bg-orb qr-login-bg-orb-one" />
      <div className="qr-login-bg-orb qr-login-bg-orb-two" />
      <header className="qr-login-topbar">
        <div className="qr-login-brand"><Logo size={42} /><div><strong>NIRO</strong><span>AI WhatsApp CRM</span></div></div>
        <div className="qr-login-topbar-meta"><span className="qr-login-live-dot" /> Niro Web <b>·</b> Acceso privado</div>
      </header>

      <main className="qr-login-layout">
        <section className="qr-login-hero">
          <span className="qr-login-kicker">NIRO WEB · EXPERIENCIA SEGURA</span>
          <h1>Tu WhatsApp, <em>solo en este navegador.</em></h1>
          <p className="qr-login-hero-copy">Iniciá como en WhatsApp Web: escaneá un código QR y entrá a tu entorno de trabajo. Cada navegador obtiene su propia sesión.</p>
          <div className="qr-login-feature-list">
            <div><span>01</span><strong>Escaneá tu QR</strong><small>Desde WhatsApp → Dispositivos vinculados.</small></div>
            <div><span>02</span><strong>Confirmá tu entorno</strong><small>El acceso queda guardado únicamente aquí.</small></div>
            <div><span>03</span><strong>Trabajá con tu equipo</strong><small>Los agentes ingresan con sus propias credenciales.</small></div>
          </div>
          <div className="qr-login-hero-visual">
            <div className="qr-login-visual-ring qr-login-visual-ring-one" />
            <div className="qr-login-visual-ring qr-login-visual-ring-two" />
            <div className="qr-login-robot"><NiroMascot size={230} /></div>
            <div className="qr-login-visual-card qr-login-visual-card-top"><span>●</span><div><strong>Sesión protegida</strong><small>Vinculada a este navegador</small></div></div>
            <div className="qr-login-visual-card qr-login-visual-card-bottom"><span>✦</span><div><strong>Niro siempre contigo</strong><small>Conversá · Automatizá · Crecé</small></div></div>
          </div>
        </section>

        <section className="qr-login-card" aria-label="Acceso a Niro Web">
          {sessionNotice && <div className="qr-login-session-notice" role="status"><span>↻</span><div><strong>La sesión de WhatsApp se cerró</strong><small>Se cerró desde el teléfono. Escaneá un nuevo QR para volver a entrar a Niro.</small></div></div>}
          <div className="qr-login-card-head">
            <div><span className="qr-login-step">PASO 1 DE 2</span><h2>{mode === 'qr' ? 'Conectá tu WhatsApp' : 'Ingresá como agente'}</h2></div>
            <span className="qr-login-secure"><span className="qr-login-lock">⌁</span> Seguro</span>
          </div>

          {mode === 'qr' ? (
            <>
              <div className="qr-login-card-intro"><span className="qr-whatsapp-mark">◉</span><div><strong>Escaneá para iniciar</strong><small>Como WhatsApp Web, sin compartir contraseñas.</small></div></div>
              <div className="qr-login-panel">
                {qrLoading && <div className="qr-login-placeholder"><span className="qr-spinner" /><strong>Preparando tu acceso seguro…</strong><small>Creando una sesión exclusiva para este navegador</small></div>}
                {!qrLoading && qr?.status === 'qr' && qr.qr && <div className="qr-login-code-wrap"><div className="qr-login-code"><img src={qr.qr} alt="Código QR para iniciar sesión en Niro Web" /></div><strong>{statusText}</strong><span>WhatsApp → Dispositivos vinculados → Vincular un dispositivo</span></div>}
                {!qrLoading && qr?.status === 'connecting' && <div className="qr-login-placeholder"><span className="qr-spinner" /><strong>{statusText}…</strong><small>Estamos preparando un QR nuevo para este navegador</small></div>}
                {!qrLoading && qr?.status === 'connected' && <div className="qr-login-connected"><span>✓</span><strong>{statusText}</strong><small>+{qr.phone || 'número verificado'}</small></div>}
                {!qrLoading && qr?.status === 'disconnected' && <div className="qr-login-placeholder"><span className="qr-login-offline">!</span><strong>No se pudo mantener el QR</strong><small>Generá un código nuevo para continuar.</small></div>}
              </div>

              <div className="qr-login-browser-note"><span>⌁</span><div><strong>Sesión exclusiva de este navegador</strong><small>Si abrís Niro en otra computadora o navegador, tendrás que escanear otro QR. El teléfono conectado no habilita accesos automáticamente.</small></div></div>
              {showSetup && <div className="qr-login-setup"><div><strong>Terminemos de configurar Niro</strong><span>Solo se solicita la primera vez para crear tu empresa y tu perfil administrador.</span></div><input className="input" placeholder="Nombre de la empresa" value={companyName} onChange={(e) => setCompanyName(e.target.value)} /><input className="input" placeholder="Tu nombre" value={adminName} onChange={(e) => setAdminName(e.target.value)} /><button className="btn qr-login-primary" disabled={completing || !companyName.trim() || !adminName.trim()} onClick={() => qr && completeQrLogin(qr.flowId)}>{completing ? 'Creando entorno…' : 'Entrar a Niro'}</button></div>}
              {qrError && <div className="qr-login-error">{qrError}</div>}
              <div className="qr-login-actions"><button type="button" className="btn secondary" onClick={startQr} disabled={qrLoading || completing}>↻ Generar otro QR</button><button type="button" className="qr-login-agent-link" onClick={() => { setMode('agent'); setAgentError(null); }}>Ingresar como agente →</button></div>
            </>
          ) : (
            <>
              <div className="qr-login-card-intro qr-login-card-intro-agent"><span className="qr-login-agent-icon">♙</span><div><strong>Acceso del equipo</strong><small>Usá el usuario y contraseña entregados por el administrador.</small></div></div>
              {agentError && <div className="qr-login-error">{agentError}</div>}
              <form onSubmit={handleAgentLogin} className="qr-login-agent-form"><label className="field"><span>Usuario o correo electrónico</span><input className="input" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="usuario@empresa.com" /></label><label className="field"><span>Contraseña</span><div className="qr-password-field"><input className="input" type={showPassword ? 'text' : 'password'} required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" /><button type="button" onClick={() => setShowPassword((current) => !current)}>{showPassword ? 'Ocultar' : 'Mostrar'}</button></div></label><button className="btn qr-login-primary" type="submit" disabled={submitting}>{submitting ? 'Ingresando…' : 'Ingresar al sistema'}</button></form><button type="button" className="qr-login-back" onClick={() => setMode('qr')}>← Volver al acceso QR del administrador</button>
            </>
          )}

          <div className="qr-login-card-footer"><span>🔒 Tus datos permanecen protegidos</span><span>Los agentes no necesitan QR</span></div>
        </section>
      </main>
      <footer className="qr-login-footer"><span>© Niro Enterprise</span><span>Tu empresa, más cerca de las personas.</span><span>Conexión cifrada · Sesión por navegador</span></footer>
    </div>
  );
}
