import { useEffect, useState } from 'react';
import { Modal } from './Modal';

type InstallPrompt = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

// ¿La app ya está instalada? Se sabe por varios caminos, porque ninguno alcanza solo:
//  · se está ejecutando como app (ventana propia, cualquiera de sus modos de pantalla);
//  · el navegador avisó "appinstalled", o ya se abrió como app antes en este navegador (queda anotado);
//  · el navegador la reporta como instalada (getInstalledRelatedApps).
// Si el navegador vuelve a ofrecer instalar (beforeinstallprompt), significa que NO está instalada (p. ej. se desinstaló).
const APP_MODES = ['standalone', 'window-controls-overlay', 'minimal-ui', 'fullscreen'];
const FLAG = 'niro.pwa.installed';
const DISMISS = 'niro.pwa.install.dismissed';
const DISMISS_DAYS = 14;
const runningAsApp = () => APP_MODES.some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches) || Boolean((navigator as Navigator & { standalone?: boolean }).standalone) || document.referrer.startsWith('android-app://');
const readFlag = () => { try { return localStorage.getItem(FLAG) === '1'; } catch { return false; } };
const writeFlag = (value: boolean) => { try { if (value) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); } catch { /* sin almacenamiento */ } };
const wasDismissed = () => { try { const at = Number(localStorage.getItem(DISMISS) || 0); return at > 0 && Date.now() - at < DISMISS_DAYS * 86400000; } catch { return false; } };

export function PwaExperience() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(() => runningAsApp() || readFlag());
  const [dismissed, setDismissed] = useState(wasDismissed);
  const [help, setHelp] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [installError, setInstallError] = useState('');

  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      if (viewport && viewport.scale === 1) document.documentElement.style.setProperty('--app-height', `${viewport.height}px`);
    };
    resize();
    viewport?.addEventListener('resize', resize);
    // Se está usando como app: queda anotado para no ofrecer instalar también en las pestañas del navegador.
    if (runningAsApp()) writeFlag(true);
    const modeQueries = APP_MODES.map((mode) => window.matchMedia(`(display-mode: ${mode})`));
    const onMode = () => { if (runningAsApp()) { writeFlag(true); setInstalled(true); } };
    modeQueries.forEach((q) => q.addEventListener?.('change', onMode));
    const related = (navigator as Navigator & { getInstalledRelatedApps?: () => Promise<unknown[]> }).getInstalledRelatedApps;
    if (related) void related.call(navigator).then((apps) => { if (!disposedEarly && apps.length > 0) { writeFlag(true); setInstalled(true); } }).catch(() => {});
    let disposedEarly = false;
    const install = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
      if (!runningAsApp()) { writeFlag(false); setInstalled(false); } // el navegador la ofrece: no está instalada
    };
    const done = () => { writeFlag(true); setInstalled(true); setPrompt(null); setHelp(false); };
    const online = () => setOffline(!navigator.onLine);
    window.addEventListener('beforeinstallprompt', install);
    window.addEventListener('appinstalled', done);
    window.addEventListener('online', online);
    window.addEventListener('offline', online);
    let disposed = false;
    let registration: ServiceWorkerRegistration | undefined;
    const update = () => {
      const worker = registration?.installing;
      if (worker) worker.addEventListener('statechange', () => {
        if (!disposed && worker.state === 'installed' && navigator.serviceWorker.controller) setWaiting(registration?.waiting || null);
      });
    };
    const checkUpdate = () => { if (document.visibilityState === 'visible' && navigator.onLine) void registration?.update().catch(() => {}); };
    if ('serviceWorker' in navigator && import.meta.env.PROD) {
      void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((reg) => {
        if (disposed) return;
        registration = reg;
        setWaiting(reg.waiting);
        reg.addEventListener('updatefound', update);
        document.addEventListener('visibilitychange', checkUpdate);
      }).catch(() => { /* Browser installation remains available; retry on the next visit. */ });
    }
    return () => {
      disposed = true;
      disposedEarly = true;
      modeQueries.forEach((q) => q.removeEventListener?.('change', onMode));
      viewport?.removeEventListener('resize', resize);
      window.removeEventListener('beforeinstallprompt', install);
      window.removeEventListener('appinstalled', done);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', online);
      registration?.removeEventListener('updatefound', update);
      document.removeEventListener('visibilitychange', checkUpdate);
    };
  }, []);

  async function install() {
    if (!prompt) { setHelp(true); return; }
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === 'accepted') { writeFlag(true); setInstalled(true); }
    } catch { setInstallError('Usá el menú de tu navegador para instalar NIRO.'); setHelp(true); }
    finally { setPrompt(null); }
  }

  function activateUpdate() {
    if (!waiting || !window.confirm('Guardá o enviá tus borradores antes de actualizar. ¿Recargar NIRO ahora?')) return;
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
    waiting.postMessage({ type: 'NIRO_ACTIVATE_UPDATE' });
  }

  return <>
    {!installed && !dismissed && <div className="pwa-install">
      <button type="button" className="pwa-install-btn" onClick={install} aria-label="Instalar NIRO en este dispositivo"><img src="/icons/niro-192.png" alt="" /> Instalar NIRO</button>
      <button type="button" className="pwa-install-close" onClick={() => { try { localStorage.setItem(DISMISS, String(Date.now())); } catch { /* sin almacenamiento */ } setDismissed(true); }} aria-label="No mostrar por ahora" title="No mostrar por 14 días">×</button>
    </div>}
    {(offline || waiting) && <div className="pwa-status" role="status">
      {offline ? 'Sin conexión · Los mensajes necesitan Internet para enviarse.' : <>Hay una nueva versión de NIRO. <button type="button" onClick={activateUpdate}>Actualizar</button></>}
    </div>}
    {help && <Modal title="NIRO, siempre a mano" onClose={() => setHelp(false)} className="pwa-install-modal">
      <img className="pwa-help-icon" src="/icons/niro-192.png" alt="Robot de NIRO" />
      <p>Abrí tus conversaciones desde el robot de NIRO, en una ventana propia.</p>
      {installError && <p role="alert">{installError}</p>}
      <ul><li><strong>Windows y Android:</strong> abrí NIRO en Chrome o Edge y elegí «Instalar aplicación» en el menú del navegador.</li><li><strong>iPhone y iPad:</strong> en Safari, tocá Compartir → Añadir a pantalla de inicio → Abrir como app, si aparece.</li><li><strong>Mac:</strong> en Safari, usá Archivo → Añadir al Dock; en Chrome, usá «Instalar».</li></ul>
      <p>Las opciones dependen del navegador. Para trabajar y recibir mensajes necesitás conexión. Podés activar las notificaciones desde la campanita de tu cuenta.</p>
    </Modal>}
  </>;
}
