import { Pill } from "@/components/ui";
import { CRM_PREVIEW_DOCUMENTS } from "@/lib/mock/crm-ui";
import { CrmPreviewNotice } from "./CrmPreviewNotice";
import styles from "./CrmPreview.module.css";

export function DocumentsPreview() {
  return (
    <section>
      <CrmPreviewNotice>
        These are example document pointers only. No files are stored here, and this tab is not connected to the client record or an external vault.
      </CrmPreviewNotice>
      <div className={`${styles.document} ${styles.documentHeader}`} aria-hidden="true">
        <span>Document</span><span>Category</span><span>Scope</span><span>External access</span><span>Updated</span>
      </div>
      <div className={styles.documents}>
        {CRM_PREVIEW_DOCUMENTS.map((document) => (
          <article key={document.id} className={styles.document}>
            <div className={styles.documentName}>
              <strong>{document.name}</strong>
              <span>{document.vault} · <code>{document.id}</code></span>
            </div>
            <span>{document.category}</span>
            <span><Pill tone={document.scope === "Private" ? "gold" : "green"}>{document.scope}</Pill></span>
            <span>{document.externalAccess}</span>
            <span>{document.updated}</span>
          </article>
        ))}
      </div>
    </section>
  );
}
