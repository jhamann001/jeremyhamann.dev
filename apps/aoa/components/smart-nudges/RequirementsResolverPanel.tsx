"use client";

import { useMemo, useState } from "react";
import { Pill, SectionLabel } from "@/components/ui";
import { getIntendedActions, resolveRequirements } from "@/lib/data/nudge-requirements";
import type { Registration } from "@/lib/data/workflow-types";

// ticket Phase 1 — ops-input requirements resolver. Pick an intended action
// and enter client state (bank-linked toggle + registration); the resolved
// bundle of Apex forms — with the reason each is required, its signers, and any
// supporting-doc requirement — renders live. Client state is ops-entered (no
// feed). Preview only: it does not mutate Task.docs or the Nudge store.
const REGISTRATIONS: Registration[] = ["individual", "IRA", "joint", "trust"];

export function RequirementsResolverPanel() {
  const actions = useMemo(() => getIntendedActions(), []);
  const [actionId, setActionId] = useState<string>("ira_distribution");
  const [hasLinkedBank, setHasLinkedBank] = useState<boolean>(false);
  const [registration, setRegistration] = useState<Registration>("individual");

  const resolved = useMemo(
    () =>
      resolveRequirements(actionId, {
        hasLinkedBank,
        registration,
        ownership: registration === "joint" ? "joint" : "single",
      }),
    [actionId, hasLinkedBank, registration],
  );

  const labelStyle = { fontSize: 12, color: "var(--muted)", fontWeight: 600 } as const;
  const controlStyle = {
    marginTop: 4,
    padding: "6px 8px",
    fontSize: 13,
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "inherit",
  } as const;

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SectionLabel>Requirements resolver</SectionLabel>
        <Pill tone="gray">ops preview</Pill>
      </div>
      <p style={{ color: "var(--muted)", marginTop: 6, fontSize: 12.5, maxWidth: 520 }}>
        Pick an intended action and enter the client&apos;s state to see the exact forms to send.
        Bank-link and registration are entered manually in Phase 1.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
          marginTop: 12,
        }}
      >
        <label style={labelStyle}>
          Intended action
          <select
            value={actionId}
            onChange={(e) => setActionId(e.target.value)}
            style={{ ...controlStyle, display: "block", width: "100%" }}
          >
            {actions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>

        <label style={labelStyle}>
          Registration
          <select
            value={registration}
            onChange={(e) => setRegistration(e.target.value as Registration)}
            style={{ ...controlStyle, display: "block", width: "100%" }}
          >
            {REGISTRATIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8, marginTop: 18 }}>
          <input
            type="checkbox"
            checked={hasLinkedBank}
            onChange={(e) => setHasLinkedBank(e.target.checked)}
          />
          Bank account linked
        </label>
      </div>

      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>
          Required forms ({resolved.length})
        </div>
        {resolved.map((r) => (
          <div
            key={r.code}
            style={{
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--surface)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{r.name}</span>
              <Pill tone="gray">{r.code}</Pill>
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{r.reason}</div>
            {r.signers.length > 0 ? (
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                Signers: {r.signers.join(", ")}
              </div>
            ) : null}
            {r.supporting ? (
              <div style={{ fontSize: 12, color: "var(--amber, #b8860b)", marginTop: 2 }}>
                Supporting doc: {r.supporting}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
