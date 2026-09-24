import { useId, useMemo, useState, type ReactNode } from 'react';
import '../styles/charts.css';

// Paleta categórica validada con el verificador de la guía de visualización (distinguible también con daltonismo).
// El color identifica a la serie, no al tema: los temas cambian fondo, texto y grilla, no la identidad de los datos.
export const SERIES = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)'];

export interface Point { label: string; value: number }
export interface Serie { name: string; color: string; points: Point[] }

const niceMax = (max: number) => {
  if (max <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / magnitude) * magnitude;
};

/** Evolución en el tiempo: una o dos series, con área degradada, guía vertical y globo al pasar el mouse. */
export function TimeSeriesChart({ series, height = 230, formatValue = (v: number) => v.toLocaleString('es') }: {
  series: Serie[]; height?: number; formatValue?: (value: number) => string;
}) {
  const id = useId().replace(/:/g, '');
  const [hover, setHover] = useState<number | null>(null);
  const width = 720;
  const pad = { top: 16, right: 14, bottom: 26, left: 40 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const length = series[0]?.points.length || 0;
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.value))));
  const x = (index: number) => pad.left + (length <= 1 ? innerW / 2 : (index / (length - 1)) * innerW);
  const y = (value: number) => pad.top + innerH - (value / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(max * ratio));
  const labelEvery = Math.max(1, Math.ceil(length / 7));

  if (length === 0) return <p className="viz-empty">Sin datos en este período.</p>;

  return (
    <figure className="viz-figure">
      <svg viewBox={`0 0 ${width} ${height}`} className="viz-svg" role="img"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const ratio = ((event.clientX - box.left) / box.width) * width;
          const index = Math.round(((ratio - pad.left) / innerW) * (length - 1));
          setHover(Math.max(0, Math.min(length - 1, index)));
        }}>
        <defs>
          {series.map((serie, index) => (
            <linearGradient key={serie.name} id={`${id}-fill-${index}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={serie.color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={serie.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {ticks.map((tick) => (
          <g key={tick}>
            <line className="viz-grid" x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} />
            <text className="viz-axis" x={pad.left - 8} y={y(tick) + 4} textAnchor="end">{formatValue(tick)}</text>
          </g>
        ))}

        {series[0].points.map((point, index) => (index % labelEvery === 0 || index === length - 1) && (
          <text key={point.label} className="viz-axis" x={x(index)} y={height - 8} textAnchor="middle">{point.label}</text>
        ))}

        {series.map((serie, index) => {
          const line = serie.points.map((point, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(point.value)}`).join(' ');
          const area = `${line} L${x(length - 1)},${pad.top + innerH} L${x(0)},${pad.top + innerH} Z`;
          return (
            <g key={serie.name}>
              <path d={area} fill={`url(#${id}-fill-${index})`} />
              <path d={line} fill="none" stroke={serie.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}

        {hover !== null && (
          <g>
            <line className="viz-crosshair" x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} />
            {series.map((serie) => (
              <circle key={serie.name} cx={x(hover)} cy={y(serie.points[hover].value)} r="4.5" fill={serie.color} className="viz-dot" />
            ))}
          </g>
        )}
      </svg>

      {hover !== null && (
        <div className="viz-tooltip" style={{ left: `${(x(hover) / width) * 100}%` }}>
          <b>{series[0].points[hover].label}</b>
          {series.map((serie) => (
            <span key={serie.name}><i style={{ background: serie.color }} /> {serie.name}: <b>{formatValue(serie.points[hover].value)}</b></span>
          ))}
        </div>
      )}

      {series.length > 1 && (
        <figcaption className="viz-legend">
          {series.map((serie) => <span key={serie.name}><i style={{ background: serie.color }} /> {serie.name}</span>)}
        </figcaption>
      )}
    </figure>
  );
}

/** Reparto de un total (canales, estados): anillo con el total en el centro y lista al costado. */
export function DonutChart({ data, total, centerLabel }: { data: Point[]; total?: number; centerLabel?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const sum = total ?? data.reduce((acc, item) => acc + item.value, 0);
  const size = 180;
  const radius = 68;
  const stroke = 22;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  if (sum === 0) return <p className="viz-empty">Sin datos en este período.</p>;

  return (
    <div className="viz-donut">
      <svg viewBox={`0 0 ${size} ${size}`} className="viz-donut-svg" role="img">
        <g transform={`translate(${size / 2} ${size / 2}) rotate(-90)`}>
          {data.map((item, index) => {
            const ratio = item.value / sum;
            // 2px de separación entre porciones: se leen como piezas distintas, no como un bloque.
            const dash = Math.max(0, ratio * circumference - 2);
            const circle = (
              <circle key={item.label} r={radius} fill="none" stroke={SERIES[index % SERIES.length]}
                strokeWidth={hover === index ? stroke + 4 : stroke} strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset} className="viz-slice"
                onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(null)} />
            );
            offset += ratio * circumference;
            return circle;
          })}
        </g>
        <text className="viz-donut-value" x={size / 2} y={size / 2 - 2} textAnchor="middle">{sum.toLocaleString('es')}</text>
        <text className="viz-donut-label" x={size / 2} y={size / 2 + 16} textAnchor="middle">{centerLabel || 'total'}</text>
      </svg>
      <ul className="viz-donut-list">
        {data.map((item, index) => (
          <li key={item.label} className={hover === index ? 'on' : ''} onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(null)}>
            <i style={{ background: SERIES[index % SERIES.length] }} />
            <span>{item.label}</span>
            <b>{item.value.toLocaleString('es')}</b>
            <em>{Math.round((item.value / sum) * 100)}%</em>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Comparación entre categorías (agentes, áreas): barras horizontales con el valor al final. */
export function RankedBars({ data, color = 'var(--viz-1)', formatValue = (v: number) => v.toLocaleString('es') }: {
  data: Point[]; color?: string; formatValue?: (value: number) => string;
}) {
  const max = Math.max(1, ...data.map((item) => item.value));
  if (data.length === 0) return <p className="viz-empty">Sin datos en este período.</p>;
  return (
    <ul className="viz-bars">
      {data.map((item) => (
        <li key={item.label} title={`${item.label}: ${formatValue(item.value)}`}>
          <span className="viz-bar-label">{item.label}</span>
          <span className="viz-bar-track"><i style={{ width: `${Math.max(2, (item.value / max) * 100)}%`, background: color }} /></span>
          <b>{formatValue(item.value)}</b>
        </li>
      ))}
    </ul>
  );
}

const WEEKDAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

/** Cuándo escriben los clientes: intensidad por día de la semana y hora. */
export function Heatmap({ cells }: { cells: { weekday: number; hour: number; total: number }[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const byKey = useMemo(() => new Map(cells.map((cell) => [`${cell.weekday}-${cell.hour}`, cell.total])), [cells]);
  const max = Math.max(1, ...cells.map((cell) => cell.total));
  if (cells.length === 0) return <p className="viz-empty">Sin mensajes en este período.</p>;
  return (
    <div className="viz-heatmap">
      <div className="viz-heat-grid">
        {WEEKDAYS.map((day, weekday) => (
          <div className="viz-heat-row" key={day}>
            <span className="viz-heat-day">{day}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const total = byKey.get(`${weekday}-${hour}`) || 0;
              const key = `${weekday}-${hour}`;
              return (
                <i key={hour} className={`viz-heat-cell ${hover === key ? 'on' : ''}`}
                  style={{ opacity: total === 0 ? 0.08 : 0.25 + (total / max) * 0.75 }}
                  onMouseEnter={() => setHover(key)} onMouseLeave={() => setHover(null)}
                  title={`${day} ${String(hour).padStart(2, '0')}:00 · ${total} mensaje${total === 1 ? '' : 's'}`} />
              );
            })}
          </div>
        ))}
      </div>
      <div className="viz-heat-hours"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
    </div>
  );
}

/** Tarjeta de indicador con variación contra el período anterior. */
export function StatTile({ label, value, hint, trend, icon }: {
  label: string; value: ReactNode; hint?: string; trend?: number | null; icon?: ReactNode;
}) {
  return (
    <div className="viz-stat">
      <div className="viz-stat-top"><span>{label}</span>{icon}</div>
      <strong>{value}</strong>
      <div className="viz-stat-foot">
        {typeof trend === 'number' && (
          <span className={`viz-trend ${trend > 0 ? 'up' : trend < 0 ? 'down' : ''}`}>
            {trend > 0 ? '▲' : trend < 0 ? '▼' : '='} {Math.abs(trend)}%
          </span>
        )}
        {hint && <small>{hint}</small>}
      </div>
    </div>
  );
}
