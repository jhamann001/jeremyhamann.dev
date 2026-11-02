"use client";

import { useMemo, useState } from "react";
import { Card, CardBody, CardHeader, Pill, SectionLabel } from "@/components/ui";
import type {
  ClientExperienceScenario,
  DualViewInsight,
} from "@/lib/mock/client-experiences";
import { DevPrototypeBanner } from "./DevPrototypeBanner";
import styles from "./DualViewExperience.module.css";

const TONE_LABEL = {
  opportunity: "Opportunity",
  risk: "Risk",
  context: "Context",
  healthy: "On track",
} as const;

type InsightFilter = "all" | DualViewInsight["tone"];

const FILTERS: { id: InsightFilter; label: string }[] = [
  { id: "all", label: "All insights" },
  { id: "opportunity", label: "Opportunities" },
  { id: "risk", label: "Risks" },
  { id: "context", label: "Context" },
  { id: "healthy", label: "On track" },
];

export function DualViewExperience({
  clientName,
  scenarios,
  initialScenarioId,
  clientStory = false,
}: {
  clientName: string;
  scenarios: ClientExperienceScenario[];
  initialScenarioId: string;
  /** The public demo's story written for this client from its own records (lib/demo/samples): no storyline picker. */
  clientStory?: boolean;
}) {
  const [scenarioId, setScenarioId] = useState(initialScenarioId);
  const [filter, setFilter] = useState<InsightFilter>("all");
  const scenario = scenarios.find((item) => item.id === scenarioId) ?? scenarios[0];
  const dualView = scenario.fixture.dualView;
  const visibleInsights = useMemo(
    () => dualView.insights.filter((insight) => filter === "all" || insight.tone === filter),
    [dualView.insights, filter],
  );

  return (
    <>
      <SectionLabel>Client · Foundation layer</SectionLabel>
      <h1>Dual-View Intelligence</h1>
      <p className={styles.subhead}>
        {clientName} · see what is happening now and what has mattered over time.
      </p>
      <DevPrototypeBanner />

      {clientStory ? null : <Card className={styles.scenarioCard}>
        <CardBody className={styles.scenarioBody}>
          <div>
            <span className={styles.controlLabel}>Preview storyline</span>
            <strong>{scenario.label}</strong>
            <p>{scenario.description}</p>
          </div>
          <label>
            <span className={styles.srOnly}>Choose a synthetic storyline</span>
            <select
              value={scenario.id}
              onChange={(event) => {
                setScenarioId(event.target.value);
                setFilter("all");
              }}
            >
              {scenarios.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
        </CardBody>
      </Card>}

      <div className={styles.sampleNotice} role="note">
        {clientStory ? (
          <>
            <strong>Sample story written for this demo client.</strong> It follows {clientName}&apos;s seeded
            records, but Dual-View never ran in production: the real app shows this page only in development,
            and nothing here is synthesized live.
          </>
        ) : (
          <>
            <strong>Mock story applied to this client shell.</strong> None of the activity, balances,
            risk details, or recommendations below come from {clientName}&apos;s record.
          </>
        )}
      </div>

      <section className={styles.brief} aria-labelledby="sample-brief-title">
        <div className={styles.briefIcon} aria-hidden="true">✦</div>
        <div>
          <p className={styles.eyebrow}>{dualView.meetingLabel}</p>
          <h2 id="sample-brief-title">Sample pre-meeting brief</h2>
          <p>{dualView.brief}</p>
        </div>
      </section>

      <div className={styles.dualGrid}>
        <Card>
          <CardHeader>
            <span className={styles.live}><span aria-hidden="true" />LIVE</span>
            <h2>Real-time view</h2>
            <Pill tone="gold">sample signals</Pill>
          </CardHeader>
          <div className={styles.activityList}>
            {dualView.realTime.map((item) => (
              <div className={styles.activity} key={`${item.time}-${item.text}`}>
                <time>{item.time}</time>
                <div>
                  <p>{item.text}</p>
                  <span>{item.source}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader>
            <span className={styles.clock} aria-hidden="true">◷</span>
            <h2>Historical view · {dualView.tenure}</h2>
            <Pill tone="blue">sample history</Pill>
          </CardHeader>
          <div className={styles.activityList}>
            {dualView.historical.map((item) => (
              <div className={styles.activity} key={`${item.time}-${item.text}`}>
                <time>{item.time}</time>
                <div>
                  <p>{item.text}</p>
                  <span>{item.source}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className={styles.sectionHead}>
        <div>
          <SectionLabel>Intelligence layer</SectionLabel>
          <h2>What the advisor should notice</h2>
        </div>
        <Pill tone="gold">synthetic synthesis</Pill>
      </div>
      <div className={styles.filters} role="group" aria-label="Filter sample insights">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={filter === item.id ? styles.filterActive : styles.filterButton}
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className={styles.insightGrid}>
        {visibleInsights.map((insight) => (
          <Card key={insight.title} className={`${styles.insight} ${styles[insight.tone]}`}>
            <CardBody>
              <div className={styles.insightTop}>
                <span className={styles.insightLabel}>{TONE_LABEL[insight.tone]}</span>
                <Pill tone={insight.tone === "risk" ? "red" : insight.tone === "opportunity" ? "gold" : insight.tone === "healthy" ? "green" : "blue"}>
                  {insight.status}
                </Pill>
              </div>
              <h3>{insight.title}</h3>
              <p>{insight.body}</p>
              <div className={styles.provenance}>{insight.provenance}</div>
            </CardBody>
          </Card>
        ))}
      </div>

      <div className={styles.sectionHead}>
        <div>
          <SectionLabel>Discovery</SectionLabel>
          <h2>Discovery snapshot</h2>
        </div>
        <Pill tone="green" dot>sample complete</Pill>
      </div>
      <Card>
        <CardBody className={styles.discovery}>
          <div>
            <span>Risk profile</span>
            <strong>{scenario.risk.tolerance} · {scenario.risk.score}/25</strong>
          </div>
          <div>
            <span>Communication</span>
            <strong>{scenario.portrait.Communication ?? "Not included in sample"}</strong>
          </div>
          <div>
            <span>Planning themes</span>
            <strong>{scenario.portrait.Themes ?? "Not included in sample"}</strong>
          </div>
        </CardBody>
      </Card>
    </>
  );
}
