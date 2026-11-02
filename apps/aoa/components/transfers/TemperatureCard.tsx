import { Card, CardBody, CardHeader, Pill, PreviewBadge } from "@/components/ui";
import type { TransferContext } from "@/lib/data/transfer-context";
import { temperatureTone } from "./temperature-tone";
import styles from "./TemperatureCard.module.css";

// Client temperature (T4, TDD ADR-10; extraction §1): tone pill + synthesized
// narrative + source chips ("pulled into one record"). The content is a Phase E
// mock seam — the card wears the Phase E PreviewBadge until synthesis is real.
// The PAGE hides the card when getTransferContext returns null (no-context
// client / prospect); this component always has a context. Server component.

export function TemperatureCard({ context }: { context: TransferContext }) {
  return (
    <Card>
      <CardHeader>Client temperature</CardHeader>
      <CardBody>
        <div className={styles.toneRow}>
          <Pill tone={temperatureTone(context.tone)} dot>
            {context.tone}
          </Pill>
          <PreviewBadge label="Preview · Phase E synthesis" />
        </div>
        <p className={styles.narrative}>{context.narrative}</p>
        <div className={styles.sources}>
          <span className={styles.sourcesLabel}>Pulled into one record</span>
          <span className={styles.chips}>
            {context.sources.map((source) => (
              <span key={source} className={styles.chip}>
                {source}
              </span>
            ))}
          </span>
        </div>
      </CardBody>
    </Card>
  );
}
