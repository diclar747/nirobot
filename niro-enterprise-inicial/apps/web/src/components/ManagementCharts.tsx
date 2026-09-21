import { useRef, useState, type ReactNode } from 'react';
import { KIND_COLOR, KIND_LABEL, formatCompact, formatGs, type Bucket, type OutcomeKind } from '../lib/management';

// Gráficos de Gestión en SVG/HTML, sin librerías. Marcas finas (barras de hasta 24 px con el extremo redondeado de 4 px,
// separación de 2 px entre segmentos), texto siempre con los colores de texto del tema, leyenda cuando hay varias series
// y tooltip al pasar el mouse. Las tablas de la pantalla son la vista alternativa con los mismos datos.

interface Tip { x: number; y: number; content: ReactNode }

function useTip() {
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (event: { clientX: number; clientY: number }, content: ReactNode) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    setTip({ x: event.clientX - rect.left, y: event.clientY - rect.top, content });
  };
  const hide = () => setTip(null);
  const element = tip ? <div className="viz-tip" style={{ left: tip.x, top: tip.y }} role="status">{tip.content}</div> : null;
  return { box, show, hide, element };
}

function niceMax(value: number) {
  if (value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * pow >= value) || 10;
  return step * pow;
}

export function dayLabel(day: string) {
  const [, month, date] = day.split('-');
  return `${date}/${month}`;
}

// ---- Columnas: monto vendido por día ----
export function ColumnChart({ data, valueLabel = formatGs }: { data: { key: string; label: string; value: number; detail?: string }[]; valueLabel?: (value: number) => string }) {
  const { box, show, hide, element } = useTip();
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 230, L = 54, R = 8, T = 10, B = 28;
  const innerW = W - L - R, innerH = H - T - B;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const band = data.length ? innerW / data.length : innerW;
  const barW = Math.min(24, Math.max(3, band * 0.62));
  const ticks = [0, max / 2, max];
  const every = Math.max(1, Math.ceil(data.length / 8));
  const y = (value: number) => T + innerH - (value / max) * innerH;

  return (
    <div className="viz-box" ref={box} onMouseLeave={() => { hide(); setHover(null); }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Monto vendido por día" className="viz-svg">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="viz-grid" />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" className="viz-axis">{formatCompact(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = L + band * i + (band - barW) / 2;
          const top = y(d.value);
          const h = Math.max(d.value > 0 ? 2 : 0, T + innerH - top);
          const r = Math.min(4, barW / 2, h);
          return (
            <g key={d.key}>
              {d.value > 0 && (
                <path
                  d={`M${x},${T + innerH} V${T + innerH - h + r} Q${x},${T + innerH - h} ${x + r},${T + innerH - h} H${x + barW - r} Q${x + barW},${T + innerH - h} ${x + barW},${T + innerH - h + r} V${T + innerH} Z`}
                  className={`viz-col ${hover === i ? 'is-hover' : ''}`}
                />
              )}
              <rect x={L + band * i} y={T} width={band} height={innerH + B} fill="transparent"
                onMouseMove={(e) => { setHover(i); show(e, <><b>{d.label}</b><span>{valueLabel(d.value)}</span>{d.detail && <small>{d.detail}</small>}</>); }} />
              {i % every === 0 && <text x={L + band * i + band / 2} y={H - 8} textAnchor="middle" className="viz-axis">{d.label}</text>}
            </g>
          );
        })}
      </svg>
      {element}
    </div>
  );
}

// ---- Barras apiladas horizontales: resultado por agente ----
const KIND_ORDER: OutcomeKind[] = ['WON', 'QUOTE', 'LOST', 'OTHER'];
const KIND_FIELD: Record<OutcomeKind, keyof Bucket> = { WON: 'won', QUOTE: 'quotes', LOST: 'lost', OTHER: 'other' };

export function StackedAgentBars({ rows, onPick }: { rows: (Bucket & { name: string; agentId: string | null })[]; onPick?: (agentId: string) => void }) {
  const { box, show, hide, element } = useTip();
  const max = Math.max(1, ...rows.map((r) => r.outcomes));
  return (
    <div className="viz-box" ref={box} onMouseLeave={hide}>
      <ul className="viz-legend" aria-label="Leyenda">
        {KIND_ORDER.map((kind) => <li key={kind}><i style={{ background: KIND_COLOR[kind] }} />{kind === 'WON' ? 'Ventas' : kind === 'QUOTE' ? 'Cotizaciones' : kind === 'LOST' ? 'Perdidas' : 'Otras'}</li>)}
      </ul>
      <div className="viz-rows">
        {rows.map((row) => (
          <div className="viz-row" key={row.agentId || row.name}>
            <button type="button" className="viz-row-name" onClick={() => row.agentId && onPick?.(row.agentId)} disabled={!row.agentId || !onPick} title={row.agentId && onPick ? 'Filtrar por este agente' : undefined}>{row.name}</button>
            <div className="viz-track" style={{ width: `${Math.max(2, (row.outcomes / max) * 100)}%` }}>
              {KIND_ORDER.map((kind) => {
                const value = row[KIND_FIELD[kind]] as number;
                if (!value) return null;
                return (
                  <span key={kind} className="viz-seg" style={{ flexGrow: value, background: KIND_COLOR[kind] }}
                    onMouseMove={(e) => show(e, <><b>{row.name}</b><span>{value} {kind === 'WON' ? (value === 1 ? 'venta' : 'ventas') : kind === 'QUOTE' ? (value === 1 ? 'cotización' : 'cotizaciones') : kind === 'LOST' ? (value === 1 ? 'perdida' : 'perdidas') : 'otras'}</span></>)} />
                );
              })}
            </div>
            <span className="viz-row-total">{row.outcomes}</span>
          </div>
        ))}
      </div>
      {element}
    </div>
  );
}

// ---- Barras simples: por categoría (identidad por el color de la propia categoría) ----
export function CategoryBars({ rows, onPick }: { rows: { categoryId: string | null; name: string; kind: OutcomeKind; color: string; count: number; amount: number }[]; onPick?: (categoryId: string) => void }) {
  const { box, show, hide, element } = useTip();
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="viz-box" ref={box} onMouseLeave={hide}>
      <div className="viz-rows">
        {rows.map((row) => (
          <div className="viz-row" key={row.categoryId || row.name}>
            <button type="button" className="viz-row-name" onClick={() => row.categoryId && onPick?.(row.categoryId)} disabled={!row.categoryId || !onPick} title={row.categoryId && onPick ? 'Filtrar por esta categoría' : undefined}>{row.name}</button>
            <div className="viz-track" style={{ width: `${Math.max(2, (row.count / max) * 100)}%` }}>
              <span className="viz-seg" style={{ flexGrow: 1, background: row.color }}
                onMouseMove={(e) => show(e, <><b>{row.name}</b><span>{row.count} {row.count === 1 ? 'gestión' : 'gestiones'}</span>{row.amount > 0 && <small>{formatGs(row.amount)}</small>}<small>{KIND_LABEL[row.kind]}</small></>)} />
            </div>
            <span className="viz-row-total">{row.count}</span>
          </div>
        ))}
      </div>
      {element}
    </div>
  );
}
