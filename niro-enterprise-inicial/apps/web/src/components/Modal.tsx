import { useEffect, type ReactNode } from 'react';

export function Modal({ title, onClose, children, className }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
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
      <div className={`modal ${className || ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="btn secondary small" onClick={onClose} type="button">
            Cerrar
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
