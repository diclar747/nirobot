import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import { fillTemplate, QUICK_VARIABLES, type QuickReply, type TemplateContext } from '../lib/quickReplies';
import { EmojiPicker } from './EmojiPicker';
import { Modal } from './Modal';
import { Ui } from './Ui';
import { useAlerts } from '../context/AlertContext';
import '../styles/quick-replies.css';

/** Carga y mantiene la lista de respuestas rápidas (se refresca al crear/editar/borrar). */
export function useQuickReplies() {
  const [items, setItems] = useState<QuickReply[]>([]);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    try { setItems((await apiGet<{ quickReplies: QuickReply[] }>('/api/org/quick-replies')).quickReplies); }
    catch { /* si falla, el chat sigue funcionando sin plantillas */ }
    finally { setLoaded(true); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { items, loaded, reload };
}

const EXAMPLES = [
  { shortcut: 'horario', title: 'Horario de atención', content: 'Hola {{nombre}} 👋 Nuestro horario es de lunes a viernes de 8:00 a 18:00 y sábados de 8:00 a 12:00.' },
  { shortcut: 'cuenta', title: 'Datos de cuenta bancaria', content: 'Los datos para la transferencia son:\nBanco: \nCuenta N°: \nTitular: \nCI/RUC: \nAvisame cuando hagas el pago y te envío el comprobante 🙌' },
  { shortcut: 'ubicacion', title: 'Ubicación del local', content: 'Estamos en: (dirección). Te dejo el mapa para llegar fácil 📍' }
];

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const i = text.toLowerCase().indexOf(query);
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + query.length)}</mark>{text.slice(i + query.length)}</>;
}

/** Lista desplegable que aparece al escribir "/" en el chat. */
export function QuickReplyPopover({ items, query, activeIndex, context, canManage, onPick, onManage, onCreate, onHover, onClose, loaded }: {
  items: QuickReply[]; query: string; activeIndex: number; context: TemplateContext; canManage: boolean; loaded: boolean;
  onPick: (reply: QuickReply) => void; onManage: () => void; onCreate: (shortcut?: string) => void; onHover: (index: number) => void; onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Clic afuera (fuera de la lista, de la barra de escribir y del botón ⚡) = cerrar.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element;
      if (rootRef.current?.contains(target) || target.closest?.('[data-qr-keep]')) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, items]);

  return (
    <div ref={rootRef} className="qr-popover" role="listbox" aria-label="Respuestas rápidas" onMouseDown={(e) => e.preventDefault()}>
      <div className="qr-head">
        <span><Ui name="zap" size={16} /> Respuestas rápidas</span>
        <span className="qr-head-actions">
          {canManage && <button type="button" onClick={onManage}><Ui name="settings" size={14} /> Gestionar</button>}
          <button type="button" className="qr-close" onClick={onClose} aria-label="Cerrar respuestas rápidas" title="Cerrar (Esc)"><Ui name="x" size={16} /></button>
        </span>
      </div>
      <div className="qr-list" ref={listRef}>
        {items.map((reply, index) => (
          <button type="button" role="option" aria-selected={index === activeIndex} data-active={index === activeIndex} key={reply.id}
            className={`qr-item ${index === activeIndex ? 'active' : ''}`} onClick={() => onPick(reply)} onMouseEnter={() => onHover(index)}>
            <span className="qr-shortcut">/<Highlight text={reply.shortcut} query={query} /></span>
            <span className="qr-body">
              <b><Highlight text={reply.title} query={query} /></b>
              <small>{fillTemplate(reply.content, context).replace(/\n+/g, ' · ')}</small>
            </span>
            {!reply.shared && <em className="qr-private" title="Solo la ves vos"><Ui name="lock" size={12} /></em>}
          </button>
        ))}
        {items.length === 0 && loaded && (
          <div className="qr-empty">
            <p>{query ? <>No hay respuestas con “<b>{query}</b>”.</> : 'Todavía no tenés respuestas rápidas.'}</p>
            {canManage && <button type="button" className="qr-create" onClick={() => onCreate(query || undefined)}><Ui name="plus" size={14} /> {query ? `Crear /${query}` : 'Crear la primera'}</button>}
          </div>
        )}
      </div>
      <div className="qr-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navegar</span><span><kbd>Enter</kbd> insertar</span><span><kbd>Esc</kbd> cerrar</span></div>
    </div>
  );
}

/** Ventana para crear, editar y borrar respuestas rápidas. */
export function QuickReplyManager({ items, context, initialShortcut, startNew, onClose, onChanged }: {
  items: QuickReply[]; context: TemplateContext; initialShortcut?: string; startNew?: boolean; onClose: () => void; onChanged: () => void;
}) {
  const { confirm, notify } = useAlerts();
  const [editing, setEditing] = useState<Partial<QuickReply> | null>(startNew ? { shortcut: initialShortcut || '', shared: true } : null);
  const [search, setSearch] = useState('');
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((r) => !q || `${r.shortcut} ${r.title} ${r.content}`.toLowerCase().includes(q));
  }, [items, search]);

  async function remove(reply: QuickReply) {
    const ok = await confirm({ title: 'Eliminar respuesta rápida', message: `¿Eliminar /${reply.shortcut}? Esta acción no se puede deshacer.`, confirmLabel: 'Eliminar', tone: 'danger' });
    if (!ok) return;
    try { await apiDelete(`/api/org/quick-replies/${reply.id}`); notify('Respuesta eliminada', { tone: 'success' }); onChanged(); }
    catch (err) { notify(err instanceof ApiError ? err.message : 'No se pudo eliminar', { tone: 'error' }); }
  }

  return (
    <Modal title="Respuestas rápidas" onClose={onClose} className="qr-modal">
      <div className={`qr-manager ${editing ? 'editing' : ''}`}>
        <section className="qr-manager-list">
          <div className="qr-manager-bar">
            <input className="input" placeholder="Buscar respuesta…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <button type="button" className="btn" onClick={() => setEditing({ shortcut: '', shared: true })}><Ui name="plus" size={16} /> Nueva</button>
          </div>
          {items.length === 0 && (
            <div className="qr-examples">
              <p>Empezá con un ejemplo y editalo a tu gusto:</p>
              {EXAMPLES.map((ex) => <button type="button" key={ex.shortcut} onClick={() => setEditing({ ...ex, shared: true })}><b>/{ex.shortcut}</b> {ex.title}</button>)}
            </div>
          )}
          <div className="qr-manager-items">
            {shown.map((reply) => (
              <div key={reply.id} className={`qr-row ${editing?.id === reply.id ? 'active' : ''}`}>
                <button type="button" className="qr-row-main" onClick={() => setEditing(reply)}>
                  <span className="qr-shortcut">/{reply.shortcut}</span>
                  <span className="qr-body"><b>{reply.title}</b><small>{reply.content.replace(/\n+/g, ' · ')}</small></span>
                </button>
                <span className="qr-row-meta">{reply.shared ? <Ui name="users" size={14} title="Compartida con el equipo" /> : <Ui name="lock" size={14} title="Solo vos" />}{reply.usageCount > 0 && <small>{reply.usageCount}×</small>}</span>
                <button type="button" className="qr-row-btn" onClick={() => setEditing(reply)} aria-label="Editar"><Ui name="edit" size={16} /></button>
                <button type="button" className="qr-row-btn danger" onClick={() => remove(reply)} aria-label="Eliminar"><Ui name="trash" size={16} /></button>
              </div>
            ))}
            {items.length > 0 && shown.length === 0 && <p className="qr-none">Sin resultados.</p>}
          </div>
        </section>
        {editing && <QuickReplyForm reply={editing} context={context} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />}
      </div>
    </Modal>
  );
}

function QuickReplyForm({ reply, context, onCancel, onSaved }: { reply: Partial<QuickReply>; context: TemplateContext; onCancel: () => void; onSaved: () => void }) {
  const [shortcut, setShortcut] = useState(reply.shortcut || '');
  const [title, setTitle] = useState(reply.title || '');
  const [content, setContent] = useState(reply.content || '');
  const [shared, setShared] = useState(reply.shared ?? true);
  const [showEmoji, setShowEmoji] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);

  function insert(text: string) {
    const el = area.current;
    const start = el?.selectionStart ?? content.length;
    const end = el?.selectionEnd ?? content.length;
    setContent(content.slice(0, start) + text + content.slice(end));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + text.length, start + text.length); });
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const body = { shortcut, title, content, shared };
      if (reply.id) await apiPatch(`/api/org/quick-replies/${reply.id}`, body); else await apiPost('/api/org/quick-replies', body);
      onSaved();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo guardar'); setBusy(false); }
  }

  return (
    <form className="qr-form" onSubmit={submit}>
      <h4>{reply.id ? 'Editar respuesta' : 'Nueva respuesta rápida'}</h4>
      <div className="qr-form-row">
        <label className="field qr-shortcut-field"><span>Atajo</span><div className="qr-slash-input"><i>/</i><input className="input" required maxLength={30} value={shortcut} onChange={(e) => setShortcut(e.target.value.replace(/^\/+/, '').toLowerCase().replace(/\s+/g, '-'))} placeholder="cuenta" autoFocus={!reply.id} /></div></label>
        <label className="field"><span>Título</span><input className="input" required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Datos de cuenta bancaria" /></label>
      </div>
      <label className="field"><span>Mensaje</span>
        <div className="qr-vars">{QUICK_VARIABLES.map((v) => <button type="button" key={v.token} title={v.label} onClick={() => insert(v.token)}>＋ {v.label.split(' ')[0] === 'Tu' ? v.label : v.label}</button>)}</div>
        <textarea ref={area} className="input" required rows={7} maxLength={4000} value={content} onChange={(e) => setContent(e.target.value)} placeholder={'Los datos de la cuenta son:\nBanco: …\nCuenta: …'} />
      </label>
      <div className="qr-form-tools">
        <div className="campaign-emoji-anchor"><button type="button" className="campaign-emoji-toggle" data-emoji-toggle onClick={() => setShowEmoji((v) => !v)}><Ui name="smile" size={16} /> Emojis</button>{showEmoji && <EmojiPicker keepOpen onPick={insert} onClose={() => setShowEmoji(false)} />}</div>
        <span className="qr-count">{content.length} / 4000</span>
      </div>
      <div className="qr-preview"><span>Vista previa</span><p>{content.trim() ? fillTemplate(content, context) : 'Tu mensaje aparecerá acá…'}</p></div>
      <label className="qr-share"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> <span><b>Compartida con todo el equipo</b><small>{shared ? 'Todos tus compañeros pueden usarla.' : 'Solo vos la vas a ver.'}</small></span></label>
      {error && <div className="campaign-alert error">{error}</div>}
      <div className="qr-form-actions"><button type="button" className="btn secondary" onClick={onCancel}>Cancelar</button><button className="btn" disabled={busy}>{busy ? 'Guardando…' : reply.id ? 'Guardar cambios' : 'Crear respuesta'}</button></div>
    </form>
  );
}
