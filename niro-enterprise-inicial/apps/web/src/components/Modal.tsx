import { useEffect, useId, useRef, type ReactNode } from 'react';

export function Modal({ title, onClose, children, className }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = dialog.current;
    const selector = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';
    (root?.querySelector<HTMLElement>(selector) || root)?.focus({ preventScroll: true });
    const trap = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (event.key !== 'Tab' || dialogs[dialogs.length - 1] !== root) return;
      const elements = Array.from(root?.querySelectorAll<HTMLElement>(selector) || []).filter((el) => el.getClientRects().length > 0);
      const first = elements[0], last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); root?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  // Esc cierra la ventana. Si hay un selector de emojis abierto, ese lo intercepta primero (stopPropagation).
  // Los asistentes largos (campañas) no se cierran con Esc para no perder lo escrito por accidente.
  const escCloses = !className?.includes('campaign-create-modal');
  useEffect(() => {
    if (!escCloses) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, escCloses]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={`modal ${className || ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 16 }}>
          <h3 id={titleId} style={{ margin: 0 }}>{title}</h3>
          <button className="btn secondary small" onClick={onClose} type="button">
            Cerrar
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
