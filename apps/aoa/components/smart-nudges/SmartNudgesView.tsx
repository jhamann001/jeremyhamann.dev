"use client";

import { useState } from "react";
import {
  Card,
  CardBody,
  CardHeader,
  Kpi,
  Pill,
  PreviewBadge,
  SectionLabel,
} from "@/components/ui";
import { useNudges, useTemplates, useWorkflowActions } from "@/components/workflow";
import { NudgeQueueRow } from "@/components/smart-nudges/NudgeQueueRow";
import { TemplateRow } from "@/components/smart-nudges/TemplateRow";
import { NudgePreviewPanel } from "@/components/smart-nudges/NudgePreviewPanel";
import { RequirementsResolverPanel } from "@/components/smart-nudges/RequirementsResolverPanel";

// Smart Nudges — the outbound layer (TDD §6, ADR-2/3/6). Thin client consumer of
// the C0 ephemeral WorkflowProvider (mounted by the (workflow) route-group
// layout): queued nudges + a channel-aware template library + a preview-before-
// send panel. Send/Schedule/Resend mutate the in-memory store only — a refresh
// re-seeds. Send-counts, response rate, and template usage are FABRICATED demo
// metrics; nudge bodies are fixtures (Phase E will AI-draft them) — both labeled
// via the PreviewBadge + the note below.
//
// The route Server Component (page.tsx) reads the ticket feature flag
// server-side and passes `requirementsResolverEnabled` in; when on, the Template
// Library card also renders the ops-input requirements resolver panel.
export function SmartNudgesView({
  requirementsResolverEnabled,
}: {
  requirementsResolverEnabled: boolean;
}) {
  const nudges = useNudges();
  const templates = useTemplates();
  const { sendNudge, scheduleNudge, resendNudge } = useWorkflowActions();

  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Resolve from the live store each render so a status flip after Send is
  // reflected in the still-open panel (Resend footer, "Sent" pill).
  const openNudge = nudges.find((n) => n.id === openId) ?? null;

  const ready = nudges.filter((n) => n.status === "ready").length;
  const scheduled = nudges.filter((n) => n.status === "scheduled").length;
  const sent = nudges.filter((n) => n.status === "sent").length;
  // Fabricated demo metric (mockup's `sent+14`) — NOT a computed real figure.
  const sentThisWeek = sent + 14;

  return (
    <>
      <SectionLabel>Workflow · Outbound</SectionLabel>
      <h1>Smart Nudges</h1>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
        <PreviewBadge />
      </div>
      <p style={{ color: "var(--muted)", marginTop: 8, maxWidth: 640, fontSize: 13 }}>
        Sample data · resets on refresh. Send-counts, the response rate, and template usage are
        fabricated demo metrics (not computed); nudge bodies are fixtures — Phase E will AI-draft
        them per client.
      </p>

      {/* 4 KPIs */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 16,
          marginTop: 18,
        }}
      >
        <Card>
          <Kpi label="Ready to send" value={ready} />
        </Card>
        <Card>
          <Kpi label="Scheduled" value={scheduled} />
        </Card>
        <Card>
          <Kpi label="Sent this week" value={sentThisWeek} delta="64% response rate" direction="up" />
        </Card>
        <Card>
          <Kpi label="Templates" value={templates.length} />
        </Card>
      </div>

      {notice ? (
        <p
          role="status"
          style={{
            marginTop: 14,
            fontSize: 12.5,
            color: "var(--green-2)",
            fontWeight: 600,
          }}
        >
          {notice}
        </p>
      ) : null}

      {/* 2-col grid: Nudge Queue · Template Library */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 16,
          marginTop: 18,
        }}
      >
        {/* Nudge Queue */}
        <Card>
          <CardHeader>
            <h2>Nudge Queue</h2>
            <span style={{ marginLeft: "auto" }}>
              <Pill tone="amber">{ready} ready</Pill>
            </span>
            <PreviewBadge />
          </CardHeader>
          <CardBody>
            {nudges.map((n) => (
              <NudgeQueueRow key={n.id} nudge={n} onOpen={() => setOpenId(n.id)} />
            ))}
          </CardBody>
        </Card>

        {/* Template Library */}
        <Card>
          <CardHeader>
            <h2>Template Library</h2>
            <span style={{ marginLeft: "auto" }}>
              <Pill tone="gray">{templates.length} templates</Pill>
            </span>
            <PreviewBadge />
          </CardHeader>
          <CardBody>
            {templates.map((t) => (
              <TemplateRow
                key={t.id}
                template={t}
                onSchedule={() =>
                  setNotice(`Select a client to schedule "${t.name}" (stub — no flow wired).`)
                }
              />
            ))}
            {requirementsResolverEnabled ? <RequirementsResolverPanel /> : null}
          </CardBody>
        </Card>
      </div>

      <NudgePreviewPanel
        nudge={openNudge}
        onClose={() => setOpenId(null)}
        onSend={() => {
          if (openId) {
            sendNudge(openId);
            setNotice("Nudge sent (ephemeral — resets on refresh).");
          }
        }}
        onSchedule={() => {
          if (openId) {
            scheduleNudge(openId);
            setNotice("Nudge scheduled (ephemeral — resets on refresh).");
          }
        }}
        onResend={() => {
          if (openId) {
            resendNudge(openId);
            setNotice("Nudge resent (ephemeral — resets on refresh).");
          }
        }}
      />
    </>
  );
}
