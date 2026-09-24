import type { ReactNode } from 'react';
import { Ui, type UiIconName } from './Ui';
import '../styles/page-kit.css';

export type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'violet' | 'neutral';

/** Scrollable page container with consistent padding for every module. */
export function PageShell({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return <div className={`page-shell ${narrow ? 'is-narrow' : ''}`}>{children}</div>;
}

/** Color de cada módulo: pinta el ícono del encabezado y el banner. Todos dentro de la paleta del sistema. */
export type ModuleTone = 'emerald' | 'sky' | 'blue' | 'indigo' | 'violet' | 'fuchsia' | 'rose' | 'amber' | 'teal' | 'cyan' | 'slate';

export interface PageHeroProps {
  eyebrow: string;
  title: string;
  text?: ReactNode;
  /** Hasta 3-4 puntos destacados con ícono. */
  features?: { icon: UiIconName; label: string }[];
  /** Tres íconos para el arte de la derecha (el del medio va resaltado). */
  art?: [UiIconName, UiIconName, UiIconName];
  /** Algo vivo a la derecha en vez del arte (ej. "Seguimiento en tiempo real"). */
  badge?: ReactNode;
  /** Variante baja para pantallas de trabajo (tablero, constructor): sin puntos ni arte. */
  compact?: boolean;
}

export function PageHero({ tone = 'sky', eyebrow, title, text, features, art, badge, compact }: PageHeroProps & { tone?: ModuleTone }) {
  return (
    <section className={`page-hero ${compact ? 'is-compact' : ''}`} data-tone={tone} aria-label={eyebrow}>
      <div className="page-hero-copy">
        <span className="page-hero-eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        {text && <p>{text}</p>}
        {!compact && features && features.length > 0 && (
          <div className="page-hero-features">
            {features.map((feature) => <span key={feature.label}><Ui name={feature.icon} size={15} /> {feature.label}</span>)}
          </div>
        )}
      </div>
      {badge ? <div className="page-hero-badge">{badge}</div> : !compact && art && (
        <div className="page-hero-art" aria-hidden="true">
          <Ui name={art[0]} size={28} /><Ui name={art[1]} size={34} /><Ui name={art[2]} size={26} />
        </div>
      )}
    </section>
  );
}

export function PageHeader({
  icon,
  title,
  subtitle,
  actions,
  tone,
  hero,
  className
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  tone?: ModuleTone;
  /** Banner del módulo, debajo del título, con el mismo color. */
  hero?: PageHeroProps;
  className?: string;
}) {
  return (
    <>
      <header className={`page-header ${className || ''}`} data-tone={tone}>
        <div className="page-header-main">
          {icon && <div className="page-header-icon">{icon}</div>}
          <div className="page-header-text">
            <h1 className="page-title">{title}</h1>
            {subtitle && <p className="page-subtitle">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="page-header-actions">{actions}</div>}
      </header>
      {hero && <PageHero tone={tone} {...hero} />}
    </>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="page-stat-grid">{children}</div>;
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'primary'
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className={`page-stat tone-${tone}`}>
      <div className="page-stat-top">
        <span className="page-stat-label">{label}</span>
        {icon && <span className="page-stat-icon">{icon}</span>}
      </div>
      <div className="page-stat-value">{value}</div>
      {hint && <div className="page-stat-hint">{hint}</div>}
    </div>
  );
}

export function Panel({ title, actions, children, flush }: { title?: string; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className={`page-panel ${flush ? 'is-flush' : ''}`}>
      {(title || actions) && (
        <div className="page-panel-head">
          {title && <h2 className="page-panel-title">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Pill({ tone = 'neutral', children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`page-pill tone-${tone}`}>
      {dot && <span className="page-pill-dot" />}
      {children}
    </span>
  );
}

export function PersonCell({ name, detail, avatarUrl }: { name: string; detail?: ReactNode; avatarUrl?: string | null }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <div className="page-person">
      <span className={`page-person-avatar${avatarUrl ? ' has-image' : ''}`}>
        {avatarUrl ? <img src={avatarUrl} alt="" referrerPolicy="no-referrer" /> : letters || '?'}
      </span>
      <div className="page-person-text">
        <div className="page-person-name">{name}</div>
        {detail && <div className="page-person-detail">{detail}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="page-empty">
      {icon && <div className="page-empty-icon">{icon}</div>}
      <div className="page-empty-title">{title}</div>
      {text && <p className="page-empty-text">{text}</p>}
      {action}
    </div>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="page-skeleton">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="page-skeleton-row" />
      ))}
    </div>
  );
}
