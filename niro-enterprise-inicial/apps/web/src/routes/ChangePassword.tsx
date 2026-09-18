import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiPost, ApiError } from '../lib/api';
import type { CurrentUser } from '../types';
import { Logo } from '../components/Logo';

export function ChangePassword() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('Las contraseñas nuevas no coinciden');
      return;
    }
    setSubmitting(true);
    try {
      const data = await apiPost<{ user: CurrentUser }>('/api/auth/change-password', { currentPassword, newPassword });
      setUser(data.user);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cambiar la contraseña');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card card">
        <div className="brand">
          <Logo />
          NIRO<span>.</span>
        </div>
        {user?.mustChangePassword ? (
          <div className="alert info">Por seguridad, tenés que definir una contraseña nueva antes de continuar.</div>
        ) : (
          <p className="muted" style={{ marginTop: -12, marginBottom: 20 }}>
            Cambiar contraseña
          </p>
        )}
        {error && <div className="alert error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="current">Contraseña actual</label>
            <input
              id="current"
              type="password"
              className="input"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="new">Contraseña nueva</label>
            <input
              id="new"
              type="password"
              className="input"
              required
              minLength={10}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="confirm">Confirmar contraseña nueva</label>
            <input
              id="confirm"
              type="password"
              className="input"
              required
              minLength={10}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          <button className="btn" type="submit" disabled={submitting} style={{ width: '100%', justifyContent: 'center' }}>
            {submitting ? 'Guardando…' : 'Guardar y continuar'}
          </button>
        </form>
      </div>
    </div>
  );
}
