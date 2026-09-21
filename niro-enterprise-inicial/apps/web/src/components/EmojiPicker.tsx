import { Suspense, lazy, useEffect, useRef } from 'react';
import { useTheme } from '../context/ThemeContext';

// La librería (~400 KB de datos de emojis) se descarga recién cuando alguien abre el selector.
const EmojiMartPanel = lazy(() => import('./emoji/EmojiMartPanel'));

/**
 * Selector profesional de emojis para el chat, las campañas y las reacciones.
 * - popover (por defecto): se cierra al hacer clic afuera o con Esc.
 * - inline: se usa dentro de un modal (sin cerrarse solo).
 */
export function EmojiPicker({ onPick, onClose, inline = false, keepOpen = false }: { onPick: (emoji: string) => void; onClose: () => void; inline?: boolean; keepOpen?: boolean }) {
  const { theme } = useTheme();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (inline) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element;
      if (target.closest?.('[data-emoji-toggle]')) return; // el botón que lo abre/cierra maneja su propio clic
      if (ref.current && !ref.current.contains(target)) onClose();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    // el clic que abrió el selector ya pasó: escuchamos en el siguiente ciclo
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => { window.clearTimeout(timer); document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [inline, onClose]);

  return (
    <div ref={ref} className={`emoji-pro ${inline ? 'inline' : 'popover'}`} role="dialog" aria-label="Selector de emojis">
      <Suspense fallback={<div className="emoji-pro-loading"><span className="emoji-pro-spinner" />Cargando emojis…</div>}>
        <EmojiMartPanel dark={theme !== 'light'} onPick={(emoji) => { onPick(emoji); if (!keepOpen && !inline) onClose(); }} />
      </Suspense>
    </div>
  );
}
