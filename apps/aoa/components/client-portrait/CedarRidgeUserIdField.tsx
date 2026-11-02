"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

// Admin/ops-only "default hidden, click to reveal" field for a client's
// cedar_ridge_user_id. The value is ALREADY gated server-side — only ADMIN/OPERATIONS
// receive it (lib/data/client-field-authz.ts → getClientWithHousehold omits the key
// for everyone else), so a non-authorized viewer never even reaches this component.
// This client component only controls VISIBILITY: masked by default, revealed on
// demand — so the id isn't shown over-the-shoulder unless the operator asks for it.
const MASK = "••••••••";

export function CedarRidgeUserIdField({ value }: { value: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}
    >
      <span style={{ color: "var(--muted)", fontSize: 12 }}>
        Cedar Ridge User ID:{" "}
        <code style={{ color: "var(--ink)", fontSize: 12 }}>
          {shown ? value : MASK}
        </code>
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? "Hide Cedar Ridge User ID" : "Show Cedar Ridge User ID"}
      >
        {shown ? "Hide" : "Show"}
      </Button>
    </div>
  );
}
