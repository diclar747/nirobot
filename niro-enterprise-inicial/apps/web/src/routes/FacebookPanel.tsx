import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiGet, refreshAccessSession } from '../lib/api';
import { FACEBOOK_BASE_ROUTE, sectionByPanelHash, sectionByRoute } from '../lib/facebookPanel';
import { EmptyState } from '../components/PageKit';
import { useTheme } from '../context/ThemeContext';

// Tema de Niro → apariencia del panel (data-theme + data-accent, ver public/appearance.js del panel).
const PANEL_APPEARANCE: Record<string, [string, string | null]> = {
  blue: ['dark', 'blue'], dark: ['dark', 'violet'], emerald: ['dark', 'green'],
  sunset: ['dark', 'orange'], graphite: ['dark', 'graphite'], light: ['light', null],
};

function applyAppearance(win: Window | null | undefined, theme: string) {
  try {
    const root = win?.document.documentElement;
    if (!root) return;
    const [mode, accent] = PANEL_APPEARANCE[theme] || PANEL_APPEARANCE.blue;
    root.dataset.theme = mode;
    if (accent) root.dataset.accent = accent;
    else delete root.dataset.accent;
  } catch { /* todavía cargando */ }
}

// El panel de Facebook/Instagram corre en su propio contenedor bajo /facebook (mismo dominio).
// Acá se muestra DENTRO del layout de Niro: el menú lateral de Niro elige la sección y el iframe
// solo cambia de hash (no se recarga). Si adentro se navega, la URL de Niro se actualiza sola.
export function FacebookPanel() {
  const { section } = useParams();
  const navigate = useNavigate();
  const current = sectionByRoute(section);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'denied' | 'error'>('loading');
  const [src, setSrc] = useState('');
  const reopened = useRef(0);
  const { theme } = useTheme();
  useEffect(() => { applyAppearance(frameRef.current?.contentWindow, theme); }, [theme]);

  // apiGet renueva la sesión de Niro si hace falta, antes de que el iframe pida /facebook/open.
  useEffect(() => {
    apiGet<{ enabled: boolean }>('/api/org/facebook/status')
      .then((res) => {
        if (!res.enabled) return setStatus('denied');
        setSrc(`/api/org/facebook/open?section=${current.panel}`);
        setStatus('ready');
      })
      .catch(() => setStatus('error'));
    // Solo al entrar: los cambios de sección van por hash (efecto de abajo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // nginx deja pasar cada pedido del panel solo con la sesión de Niro viva (dura 15 min): mientras la
  // página está abierta se renueva sola, aunque la persona trabaje solo dentro del iframe.
  useEffect(() => {
    if (status !== 'ready') return;
    const timer = window.setInterval(() => { void refreshAccessSession(); }, 10 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [status]);

  // Sección elegida en el menú de Niro → hash del panel.
  useEffect(() => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    try {
      if (!win.location.pathname.startsWith('/facebook')) return;
      if (sectionByPanelHash(win.location.hash).route !== current.route) win.location.hash = `#/${current.panel}`;
    } catch { /* todavía cargando */ }
  }, [current]);

  const handleLoad = () => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    try {
      // Venció la sesión del panel → se vuelve a pedir por el puente (una sola vez seguida).
      if (win.location.pathname.endsWith('/login.html')) {
        if (reopened.current++ < 1) {
          void refreshAccessSession().then((ok) => {
            if (ok) setSrc(`/api/org/facebook/open?section=${current.panel}&r=${Date.now()}`);
            else setStatus('error');
          });
        } else setStatus('error');
        return;
      }
      if (!win.location.pathname.startsWith('/facebook')) return setStatus('error');
      reopened.current = 0;
      applyAppearance(win, theme);
      win.addEventListener('hashchange', () => {
        const next = sectionByPanelHash(win.location.hash);
        if (!window.location.pathname.endsWith(`/${next.route}`)) navigate(`${FACEBOOK_BASE_ROUTE}/${next.route}`, { replace: true });
      });
    } catch {
      setStatus('error');
    }
  };

  if (status === 'denied') {
    return <div className="page-shell"><EmptyState title="Facebook / Instagram no está habilitado" text="Tu cuenta no tiene acceso a este módulo. Pedíselo al administrador." /></div>;
  }
  if (status === 'error') {
    return <div className="page-shell"><EmptyState title="No se pudo abrir Facebook / Instagram" text="El módulo no respondió. Probá de nuevo en unos segundos." action={<button className="btn" onClick={() => window.location.reload()}>Reintentar</button>} /></div>;
  }
  return (
    <div className="fb-embed">
      {src && <iframe ref={frameRef} src={src} title={`Facebook / Instagram — ${current.label}`} onLoad={handleLoad} />}
    </div>
  );
}
