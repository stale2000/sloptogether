import Link from "next/link";
import type { ReactNode } from "react";

export function SiteHeader({ control = false }: { control?: boolean }) {
  return (
    <header className="site-header shell">
      <Link className="brand" href="/" aria-label="SlopTogether home">
        <span className="brand-mark" aria-hidden="true" />
        <span>slop<span style={{ color: "var(--violet)" }}>together</span></span>
      </Link>
      <nav className="nav" aria-label="Main navigation">
        <Link className="optional-link" href="/downloads">Windows worker</Link>
        {control ? <Link className="optional-link" href="/control">Control room</Link> : null}
        <Link className="button secondary small" href="/control">Connect Twitch <span aria-hidden="true">↗</span></Link>
      </nav>
    </header>
  );
}

export function SiteFooter({ compact = false }: { compact?: boolean }) {
  return (
    <footer className="site-footer shell">
      <span>SL<sup>•</sup> Live stories, made together.</span>
      {!compact ? <span>Browser output · OBS window capture · You keep the controls</span> : null}
      <span className="mono">clips.gg/sloptogether</span>
    </footer>
  );
}

export function PageWrap({ children, narrow = false }: { children: ReactNode; narrow?: boolean }) {
  return <main className={narrow ? "narrow page-main" : "shell page-main"}>{children}</main>;
}

export function Breadcrumbs({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`} className="breadcrumb-fragment">
          {index > 0 ? <span className="breadcrumb-divider" aria-hidden="true">/</span> : null}
          {item.href ? <Link href={item.href}>{item.label}</Link> : <span aria-current="page">{item.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export function PageTitle({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-title-row">
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="page-title-action">{action}</div> : null}
    </div>
  );
}

export function LiveBadge({ live, text }: { live?: boolean; text?: string }) {
  const label = text ?? (live ? "SOURCE READY" : "SOURCE OFFLINE");
  return <span className={`live-badge${live ? " is-live" : ""}`}><span />{label}</span>;
}

export function SectionLabel({ children, suffix }: { children: ReactNode; suffix?: ReactNode }) {
  return <div className="section-label-row"><span className="section-label">{children}</span>{suffix}</div>;
}
