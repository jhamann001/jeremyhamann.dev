import Link from "next/link";
import { Card, CardBody, SectionLabel } from "@/components/ui";
import { DevPrototypeBanner } from "./DevPrototypeBanner";
import styles from "./ClientExperienceEmpty.module.css";

export function ClientExperienceEmpty({
  clientId,
  clientName,
  title,
  showcase,
}: {
  clientId: string;
  clientName: string;
  title: string;
  /** The public demo's clients that have a written sample story (lib/demo/samples), offered in place of this one. */
  showcase?: Array<{ id: string; name: string }>;
}) {
  return (
    <>
      <SectionLabel>Client · Development prototype</SectionLabel>
      <h1>{title}</h1>
      <p className={styles.subhead}>{clientName}</p>
      <DevPrototypeBanner />
      <Card>
        <CardBody className={styles.empty}>
          {showcase ? (
            <>
              <h2>No sample story for {clientName}</h2>
              <p>
                {title} never ran in production, so this demo shows it only with stories written for its
                showcase clients from their own records.{showcase.length ? " Open one of theirs:" : ""}
              </p>
              {showcase.length ? (
                <ul className={styles.showcase}>
                  {showcase.map((c) => (
                    <li key={c.id}>
                      <Link href={`/client-portrait/${encodeURIComponent(c.id)}/dual-view`}>{c.name}</Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <>
              <h2>No synthetic scenario is configured</h2>
              <p>
                This prototype never invents a fallback story for an unrecognized client. Add an
                approved development fixture before using this page.
              </p>
            </>
          )}
          <Link href={`/client-portrait/${encodeURIComponent(clientId)}`}>Return to portrait →</Link>
        </CardBody>
      </Card>
    </>
  );
}
