import type { ReactNode } from 'react';

export function Modal({ title, onClose, children, className }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
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
