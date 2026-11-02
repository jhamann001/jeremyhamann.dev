import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { canReviewSchwabMappings } from "@/lib/schwab/review";
import { listSchwabMappings } from "@/lib/data/schwab-mappings";
import { MappingReview } from "./MappingReview";
import styles from "./page.module.css";

export default async function SchwabMappingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  const identity = { role: (session.user as { role?: string }).role, email: session.user.email };
  if (!canReviewSchwabMappings(identity.role)) notFound();
  const rows = await listSchwabMappings(identity);
  return <>
    <Link href="/crm">← CRM Explorer</Link>
    <h1>Schwab reviewed mappings</h1>
    <p>Operations-only account ownership review. These decisions belong to AOA, not CRM or the n8n balance feed.</p>
    <MappingReview />
    <section className={styles.section}><h2>Saved decisions ({rows.length})</h2>
      <p>Mappings take effect on the next successful snapshot. Saving here does not run or schedule an import.</p>
      {!rows.length ? <p>No reviewed mappings yet.</p> : <div className={styles.tableWrap}><table><thead><tr>
        <th>Schwab</th><th>Classification</th><th>Source contact</th><th>Source household</th><th>Snapshot status</th><th>Reviewed</th>
      </tr></thead><tbody>{rows.map((row) => <tr key={row.accountId}>
        <td>••••{row.accountNumberLast4}</td><td>{row.accountScope === "CLIENT" ? "Client" : "Firm operating"}</td>
        <td>{row.clientSfId ? <><Link href={`/client-portrait/${row.clientSfId}`}>{row.clientName ?? row.clientSfId}</Link><small>{row.clientSfId}</small></> : "—"}</td>
        <td>{row.householdSfId ? <><Link href={`/households/${row.householdSfId}`}>{row.householdName ?? row.householdSfId}</Link><small>{row.householdSfId}</small></> : "—"}</td>
        <td>{row.appliedVersion === row.version ? "Applied" : "Pending next snapshot"}<small>Mapping v{row.version}</small></td>
        <td>{row.reviewedBy}<small>{row.reviewedAt.toISOString()}</small></td>
      </tr>)}</tbody></table></div>}
    </section>
  </>;
}
