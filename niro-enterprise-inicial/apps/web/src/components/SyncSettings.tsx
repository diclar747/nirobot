import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { getPushStatus, subscribeToPush, unsubscribeFromPush, type PushSupport } from '../lib/push';
import { playMessageSound } from '../lib/sounds';
import { useNotifications } from '../context/NotificationsContext';
import { Modal } from './Modal';
import { Ui } from './Ui';
import '../styles/sync-settings.css';

type SyncType = 'groups' | 'contacts' | 'message_history' | 'avatars' | 'statuses';
interface Job { id: string; type: SyncType; status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL' | 'ERROR' | 'CANCELLED'; total: number; processed: number; failed: number; message: string | null; startedAt: string; finishedAt: string | null }
interface Item { type: SyncType; enabled: boolean; stored: number; job: Job | null }
interface State { connected: boolean; items: Item[] }

const CARDS: Record<SyncType, { icon: string; title: string; text: string; confirm: string; note?: string; label: string; canRun: boolean; unit: string }> = {
  groups: { icon: 'users', title: 'Descargar grupos', text: 'Importá a Niro los grupos disponibles en la cuenta de WhatsApp conectada, con sus participantes y administradores.', confirm: '¿Deseás importar tus grupos de WhatsApp? Niro descargará los grupos y participantes que WhatsApp tenga disponibles. Este proceso puede tardar algunos minutos.', label: 'grupos', canRun: true, unit: 'grupos' },
  contacts: { icon: 'contact', title: 'Descargar contactos', text: 'Importá los contactos que WhatsApp entregue. Quedan marcados como “Contacto importado” y no entran solos al CRM.', confirm: '¿Deseás importar los contactos de tu WhatsApp? Se guardan con nombre y teléfono cuando WhatsApp los entregue; los identificadores internos nunca se muestran como teléfonos.', label: 'contactos', canRun: true, unit: 'contactos' },
  message_history: { icon: 'chat', title: 'Descargar historial de mensajes', text: 'Importá los mensajes anteriores que WhatsApp permita sincronizar. No afecta a los mensajes nuevos, que siempre funcionan.', confirm: '¿Deseás importar el historial de mensajes? Niro guardará el historial que WhatsApp tenga disponible para dispositivos vinculados. No genera sonidos ni notificaciones.', note: 'Niro descargará el historial que WhatsApp tenga disponible para dispositivos vinculados. Algunos mensajes antiguos o archivos podrían no estar disponibles. WhatsApp lo entrega al vincular el número: si ya estaba vinculado, volvé a escanear el QR.', label: 'mensajes', canRun: false, unit: 'mensajes' },
  avatars: { icon: 'image', title: 'Descargar avatares', text: 'Descargá las fotos de perfil disponibles de tus contactos, de tus grupos y de sus integrantes. Se respeta la privacidad de cada persona.', confirm: '¿Deseás descargar las fotos de perfil de tus contactos? Se piden de a poco para no saturar a WhatsApp, así que puede tardar.', label: 'avatares', canRun: true, unit: 'avatares' },
  statuses: { icon: 'clock', title: 'Descargar estados', text: 'Guardá en Niro los estados que WhatsApp entregue mientras esta función esté activa.', confirm: '¿Deseás guardar los estados de tus contactos? Se guardarán desde ahora; los estados anteriores o vencidos podrían no estar disponibles.', note: 'Los estados se guardarán desde el momento en que actives esta función. Los estados anteriores o vencidos podrían no estar disponibles.', label: 'estados', canRun: false, unit: 'estados' }
};
const ORDER: SyncType[] = ['groups', 'contacts', 'message_history', 'avatars', 'statuses'];

const STATUS_LABEL: Record<string, { text: string; tone: string }> = {
  PENDING: { text: 'Preparando descarga', tone: 'busy' }, PROCESSING: { text: 'Descargando', tone: 'busy' },
  COMPLETED: { text: 'Completado', tone: 'ok' }, PARTIAL: { text: 'Completado parcialmente', tone: 'warn' },
  ERROR: { text: 'Error', tone: 'err' }, CANCELLED: { text: 'Cancelado', tone: 'off' }
};
const fmt = (n: number) => n.toLocaleString('es-PY');
const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleString('es-PY', { dateStyle: 'medium', timeStyle: 'short' }) : 'Nunca');

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <label className="sync-switch" aria-label={label}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="sync-track" />
    </label>
  );
}

/** Configuración → Notificaciones y sincronización con WhatsApp. Todo viene apagado; el usuario decide qué se importa. */
export function SyncSettings() {
  const { prefs, updatePrefs } = useNotifications();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ type: SyncType; kind: 'enable' | 'delete' | 'disable-running' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [push, setPush] = useState<PushSupport>('unsupported');

  const load = useCallback(async () => {
    try { setState(await apiGet<State>('/api/org/sync')); } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo cargar la sincronización'); }
  }, []);
  useEffect(() => { load(); getPushStatus().then(setPush).catch(() => setPush('unsupported')); }, [load]);

  useEffect(() => {
    const socket = getSocket();
    const onJob = ({ job }: { job: Job }) => setState((prev) => prev ? { ...prev, items: prev.items.map((it) => it.type === job.type ? { ...it, job } : it) } : prev);
    const onDone = ({ job }: { job: Job }) => { if (job.status !== 'PROCESSING') load(); };
    socket.on('sync:job', onJob); socket.on('sync:job', onDone);
    return () => { socket.off('sync:job', onJob); socket.off('sync:job', onDone); };
  }, [load]);

  function flash(message: string) { setNotice(message); setTimeout(() => setNotice(null), 6000); }

  async function setEnabled(type: SyncType, enabled: boolean) {
    setBusy(true); setError(null);
    try {
      setState(await apiPatch<State>('/api/org/sync', { [type]: enabled }));
      if (enabled && CARDS[type].canRun) flash('La función fue activada. ¿Querés iniciar la descarga ahora? Usá “Descargar ahora”.');
      else if (enabled) flash('Activado. Niro guardará esta información cuando WhatsApp la entregue.');
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo guardar'); }
    finally { setBusy(false); setConfirm(null); }
  }

  async function run(type: SyncType) {
    setError(null);
    try { await apiPost(`/api/org/sync/${type}/run`, {}); await load(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo iniciar la descarga'); }
  }
  async function cancel(type: SyncType) {
    try { await apiPost(`/api/org/sync/${type}/cancel`, {}); await load(); } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo cancelar'); }
  }
  async function removeData(type: SyncType) {
    setBusy(true);
    try { const res = await apiDelete<{ removed: number }>(`/api/org/sync/${type}/data`); flash(`Se eliminaron ${fmt(res.removed)} ${CARDS[type].unit} importados de Niro. Tu teléfono y WhatsApp no se tocaron.`); await load(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo eliminar'); }
    finally { setBusy(false); setConfirm(null); }
  }

  function onSwitch(item: Item, next: boolean) {
    if (next) { setConfirm({ type: item.type, kind: 'enable' }); return; }
    if (item.job && ['PENDING', 'PROCESSING'].includes(item.job.status)) { setConfirm({ type: item.type, kind: 'disable-running' }); return; }
    setEnabled(item.type, false);
  }

  async function togglePush(on: boolean) {
    setError(null);
    try {
      if (on) await subscribeToPush(); else await unsubscribeFromPush();
      setPush(await getPushStatus());
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo cambiar la notificación push'); setPush(await getPushStatus()); }
  }

  const pushLabel: Record<PushSupport, string> = {
    unsupported: 'Este dispositivo no es compatible.', unconfigured: 'El servidor todavía no tiene las notificaciones configuradas.',
    default: 'Desactivado.', available: 'Desactivado.', subscribed: 'Activado en este dispositivo.',
    denied: 'Bloqueado por el navegador: tocá el candado junto a la dirección y permití las notificaciones.'
  };

  const confirmItem = confirm ? CARDS[confirm.type] : null;

  return (
    <section className="sync-settings" aria-labelledby="sync-title">
      <h2 id="sync-title">Notificaciones y sincronización con WhatsApp</h2>
      <p className="muted sync-lead">Todo está desactivado por defecto. Niro se conecta y recibe los mensajes nuevos con normalidad; no importa nada de tu teléfono sin tu autorización.</p>
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}

      <div className="card sync-block">
        <h3>Notificaciones</h3>
        <div className="sync-row">
          <span className="sync-ico"><Ui name="volume" size={18} /></span>
          <div className="sync-row-text"><b>Sonido de mensajes</b><small>Suena únicamente con mensajes nuevos en tiempo real y nunca dentro del chat que tenés abierto.</small></div>
          <button type="button" className="btn secondary small" onClick={() => playMessageSound(prefs.volume)}>Probar sonido</button>
          <Switch label="Sonido de mensajes" checked={prefs.soundMessages} onChange={(v) => updatePrefs({ soundMessages: v })} />
        </div>
        <div className="sync-row">
          <span className="sync-ico"><Ui name="bell" size={18} /></span>
          <div className="sync-row-text"><b>Notificaciones push</b><small>{pushLabel[push]} Cada dispositivo decide las suyas; no suenan por mensajes históricos importados.</small></div>
          <Switch label="Notificaciones push" checked={push === 'subscribed'} disabled={push === 'unsupported' || push === 'unconfigured' || push === 'denied'} onChange={togglePush} />
        </div>
      </div>

      <div className="card sync-block">
        <h3>Importar información desde WhatsApp</h3>
        <p className="muted sync-note">Niro descargará toda la información que WhatsApp tenga disponible para dispositivos vinculados. Algunos mensajes antiguos, contactos, avatares o estados pueden no estar disponibles.</p>
        {!state ? <div className="muted">Cargando…</div> : !state.connected && <div className="alert">WhatsApp no está conectado: las descargas se habilitan al conectar el número.</div>}
        <div className="sync-grid">
          {state && ORDER.map((type) => {
            const item = state.items.find((i) => i.type === type)!;
            const card = CARDS[type];
            const job = item.job;
            const running = job ? ['PENDING', 'PROCESSING'].includes(job.status) : false;
            const badge = !item.enabled ? { text: 'Desactivado', tone: 'off' } : job ? STATUS_LABEL[job.status] : { text: 'Activado · pendiente', tone: 'ok' };
            const pct = job && job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0;
            return (
              <article key={type} className={`sync-card tone-${badge.tone} ${item.enabled ? 'on' : ''}`}>
                <header>
                  <span className="sync-ico"><Ui name={card.icon} size={18} /></span>
                  <div><h4>{card.title}</h4><span className={`sync-badge ${badge.tone}`}>{badge.text}</span></div>
                  <Switch label={card.title} checked={item.enabled} disabled={busy} onChange={(v) => onSwitch(item, v)} />
                </header>
                <p>{card.text}</p>
                {card.note && <p className="sync-hint">{card.note}</p>}
                {running && job && (
                  <div className="sync-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                    <div style={{ width: `${job.total > 0 ? pct : 15}%` }} className={job.total > 0 ? '' : 'indeterminate'} />
                    <span>Descargando {card.label}: {fmt(job.processed)}{job.total > 0 ? ` de ${fmt(job.total)}` : ''}.</span>
                  </div>
                )}
                {!running && job?.message && <p className={`sync-result ${badge.tone}`}>{job.message}</p>}
                <dl className="sync-meta">
                  <div><dt>Última sincronización</dt><dd>{fmtDate(job?.finishedAt || job?.startedAt || null)}</dd></div>
                  <div><dt>Guardados en Niro</dt><dd>{fmt(item.stored)} {card.unit}</dd></div>
                </dl>
                <footer>
                  {card.canRun && <button type="button" className="btn small" disabled={!item.enabled || running || !state.connected} onClick={() => run(type)}>{job && !running ? 'Volver a sincronizar' : 'Descargar ahora'}</button>}
                  {running && <button type="button" className="btn secondary small" onClick={() => cancel(type)}>Cancelar</button>}
                  <button type="button" className="btn danger small" disabled={item.stored === 0 || running} onClick={() => setConfirm({ type, kind: 'delete' })}>Eliminar datos importados</button>
                </footer>
              </article>
            );
          })}
        </div>
      </div>

      {confirm && confirmItem && (
        <Modal title={confirm.kind === 'delete' ? 'Eliminar datos importados' : confirm.kind === 'enable' ? confirmItem.title : 'Cancelar sincronización'} onClose={() => setConfirm(null)}>
          <p>
            {confirm.kind === 'enable' && confirmItem.confirm}
            {confirm.kind === 'delete' && 'Esta acción eliminará de Niro los datos importados, pero no eliminará nada de tu teléfono ni de WhatsApp. No se puede deshacer.'}
            {confirm.kind === 'disable-running' && 'Hay una descarga en curso. Si desactivás la opción se cancela. Lo ya descargado se conserva.'}
          </p>
          <div className="sync-modal-actions">
            <button type="button" className="btn secondary" onClick={() => setConfirm(null)}>No, volver</button>
            {confirm.kind === 'enable' && <button type="button" className="btn" disabled={busy} onClick={() => setEnabled(confirm.type, true)}>Sí, activar</button>}
            {confirm.kind === 'delete' && <button type="button" className="btn danger" disabled={busy} onClick={() => removeData(confirm.type)}>Sí, eliminar</button>}
            {confirm.kind === 'disable-running' && <button type="button" className="btn danger" disabled={busy} onClick={() => setEnabled(confirm.type, false)}>Desactivar y cancelar</button>}
          </div>
        </Modal>
      )}
    </section>
  );
}
