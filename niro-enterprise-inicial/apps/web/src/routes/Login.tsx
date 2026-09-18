import { FormEvent, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ApiError } from '../lib/api';
import { Logo } from '../components/Logo';

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      const rawFrom = (location.state as { from?: Location })?.from?.pathname;
      const from = rawFrom && rawFrom !== '/' && rawFrom !== '/landing' && rawFrom !== '/login' ? rawFrom : '/inbox';
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo iniciar sesión');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell-modern">
      <div className="auth-modern-container">
        {/* Left / Main Login Form Card */}
        <div className="auth-form-column">
          <div className="auth-top-row">
            <Link to="/" className="auth-back-link">
              ← Volver a inicio
            </Link>
            <div className="auth-lang-selector">
              🌐 Español ▾
            </div>
          </div>

          <div className="auth-header-box">
            <div className="auth-logo-center">
              <Logo size={42} />
              <h1 className="auth-brand-name">NIRO</h1>
            </div>
            <h2 className="auth-title">Bienvenido de nuevo</h2>
            <p className="auth-subtitle">Ingresa a tu cuenta para continuar</p>
          </div>

          {error && <div className="alert error">{error}</div>}

          <form onSubmit={handleSubmit} className="auth-form-elements">
            <div className="field">
              <label htmlFor="email">Correo electrónico</label>
              <div className="input-with-icon">
                <svg className="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                <input
                  id="email"
                  type="email"
                  className="input input-indented"
                  placeholder="usuario@empresa.com"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="password">Contraseña</label>
              <div className="input-with-icon">
                <svg className="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  className="input input-indented"
                  placeholder="••••••••••••"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="show-pwd-btn"
                  onClick={() => setShowPassword(!showPassword)}
                  tabIndex={-1}
                >
                  {showPassword ? '👁️' : '👁️‍🗨️'}
                </button>
              </div>
            </div>

            <div className="auth-options-row">
              <label className="remember-label">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                <span>Recordarme</span>
              </label>
              <a href="#recuperar" onClick={(e) => { e.preventDefault(); alert('Por favor contacta al administrador de tu organización para restablecer tu acceso.'); }} className="forgot-link">
                ¿Olvidaste tu contraseña?
              </a>
            </div>

            <button className="btn btn-auth-submit" type="submit" disabled={submitting}>
              {submitting ? 'Iniciando sesión…' : 'Iniciar sesión'}
            </button>
          </form>

          <div className="auth-divider">
            <span>O continúa con</span>
          </div>

          <div className="auth-social-buttons">
            <button
              type="button"
              className="social-auth-btn"
              onClick={() => alert('Autenticación con Google disponible para cuentas empresariales configuradas.')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path fill="#EA4335" d="M12 5c1.6 0 3 .6 4.1 1.7l3.1-3.1C17.3 1.8 14.8 1 12 1 7.5 1 3.7 3.6 1.9 7.3l3.7 2.9C6.5 7.3 9 5 12 5z" />
                <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.7l3.7 2.9c2.2-2 3.7-5 3.7-8.8z" />
                <path fill="#FBBC05" d="M5.6 14.8c-.2-.7-.4-1.5-.4-2.3 0-.8.2-1.6.4-2.3L1.9 7.3C.7 9.7 0 12 0 12s.7 2.3 1.9 4.7l3.7-1.9z" />
                <path fill="#34A853" d="M12 23c3.2 0 6-1.1 8-3l-3.7-2.9c-1.1.7-2.5 1.2-4.3 1.2-3 0-5.5-2.3-6.4-5.2L1.9 16c1.8 3.7 5.6 7 10.1 7z" />
              </svg>
              <span>Google</span>
            </button>

            <button
              type="button"
              className="social-auth-btn"
              onClick={() => alert('Autenticación con Microsoft disponible para cuentas empresariales configuradas.')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path fill="#F25022" d="M1 1h10v10H1z" />
                <path fill="#7FBA00" d="M13 1h10v10H13z" />
                <path fill="#00A4EF" d="M1 13h10v10H1z" />
                <path fill="#FFB900" d="M13 13h10v10H13z" />
              </svg>
              <span>Microsoft</span>
            </button>
          </div>

          <div className="auth-footer-help">
            ¿No tienes una cuenta? <Link to="/#planes">Contáctanos</Link>
          </div>
        </div>

        {/* Right Modern Branding Banner (from 1.png) */}
        <div className="auth-brand-column">
          <div className="auth-brand-content">
            <h2 className="auth-banner-title">
              Empresas más humanas con tecnología inteligente
            </h2>

            <div className="auth-feature-list">
              <div className="auth-feature-item">
                <div className="auth-feature-icon">💬</div>
                <span>Chat inteligente</span>
              </div>
              <div className="auth-feature-item">
                <div className="auth-feature-icon">👥</div>
                <span>Gestión de equipos</span>
              </div>
              <div className="auth-feature-item">
                <div className="auth-feature-icon">📦</div>
                <span>Pedidos y logística</span>
              </div>
              <div className="auth-feature-item">
                <div className="auth-feature-icon">🎯</div>
                <span>Clientes más satisfechos</span>
              </div>
            </div>

            <div className="auth-robot-preview">
              <img
                src="/images/1.png"
                alt="Niro Enterprise Asistente Inteligente"
                className="auth-robot-image"
              />
            </div>

            <div className="auth-quote-slogan">
              “La tecnología también puede ser cercana”
              <strong>NIRO ♡</strong>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
