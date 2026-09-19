import type { ReactNode } from 'react';
import '../styles/page-kit.css';

export type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'violet' | 'neutral';

/** Scrollable page container with consistent padding for every module. */
export function PageShell({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return <div className={`page-shell ${narrow ? 'is-narrow' : ''}`}>{children}</div>;
}

export function PageHeader({
  icon,
  title,
  subtitle,
  actions
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        {icon && <div className="page-header-icon">{icon}</div>}
        <div className="page-header-text">
          <h1 className="page-title">{title}</h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
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
