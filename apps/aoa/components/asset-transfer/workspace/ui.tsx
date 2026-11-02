import type { ReactNode } from "react";
import Link from "next/link";
import { workspaceRoleLabel } from "./WorkspaceShell";

export type BadgeTone = "ready" | "waiting" | "completed" | "blocked" | "progress" | "neutral" | "";

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function cash(value: number | null | undefined): string {
  return value == null ? "Not recorded" : MONEY.format(value);
}

export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

export type BtnStyle = { primary?: boolean; quiet?: boolean; tiny?: boolean; danger?: boolean; className?: string };

export function btnClass({ primary, quiet, tiny, danger, className }: BtnStyle = {}): string {
  return cx("btn", primary && "primary", quiet && "quiet", tiny && "tiny", danger && "danger", className);
}

export function BtnLink({ href, children, ...style }: BtnStyle & { href: string; children: ReactNode }) {
  return <Link href={href} prefetch={false} className={btnClass(style)}>{children}</Link>;
}

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={cx("badge", tone)}>{children}</span>;
}

export function Kicker({ children }: { children: ReactNode }) {
  return <div className="kicker">{children}</div>;
}

export function PageHeading({ kicker, title, text, controls }: {
  kicker: string; title: string; text: ReactNode; controls?: ReactNode;
}) {
  return (
    <header className="workspace-page-heading">
      <div><div className="kicker">{kicker}</div><h1>{title}</h1><p>{text}</p></div>
      {controls}
    </header>
  );
}

export function WorkingAs({ role }: { role: string }) {
  return <span className="small working-as">Working as <span className="select" aria-label="Working as">{workspaceRoleLabel(role)}</span></span>;
}

export function Summary({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("summary", className)}>{children}</div>;
}

export function Metric({ label, value, text }: { label: string; value: ReactNode; text: ReactNode }) {
  return <div className="metric"><span className="kicker">{label}</span><strong>{value}</strong><p>{text}</p></div>;
}

export function Blank({ children }: { children: ReactNode }) {
  return <div className="blank">{children}</div>;
}

export function Notice({ title, tone, role, children }: {
  title: ReactNode; tone?: "success" | "warning" | "danger"; role?: "status" | "alert" | "note"; children?: ReactNode;
}) {
  return <div className={cx("notice", tone)} role={role}><strong>{title}</strong>{children ? <p>{children}</p> : null}</div>;
}

export function Section({ id, title, aside, className, children }: {
  id?: string; title: ReactNode; aside?: ReactNode; className?: string; children: ReactNode;
}) {
  return (
    <section className={cx("section", className)} id={id}>
      <div className="sectionhead"><div><h2>{title}</h2></div>{aside}</div>
      <div className="sectionbody">{children}</div>
    </section>
  );
}

/** The mockup's numbered, collapsible transfer-detail section. */
export function WorkflowSection({ id, kicker, title, description, status, open, related, children }: {
  id: string; kicker?: string; title: string; description?: string;
  status: [BadgeTone, string]; open: boolean; related?: boolean; children: ReactNode;
}) {
  return (
    <details className={cx("section workflow-section", related ? "related-section" : "core-section")} id={id} data-workflow-section={id} open={open}>
      <summary className="sectionhead">
        <div>{kicker ? <div className="kicker">{kicker}</div> : null}<h2>{title}</h2>{description ? <p>{description}</p> : null}</div>
        <span className={cx("workflow-section-status badge", status[0])}>{status[1]}</span>
      </summary>
      {children}
    </details>
  );
}
