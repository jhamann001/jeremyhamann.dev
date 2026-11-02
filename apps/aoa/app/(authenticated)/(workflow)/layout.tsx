import type { ReactNode } from "react";
import { WorkflowProvider } from "@/components/workflow";
import { demoMode } from "@/lib/demo/mode";
import { demoSampleNow } from "@/lib/demo/samples/clock";

// Route-group layout for /tasks and /smart-nudges. It mounts the single
// ephemeral WorkflowProvider the workflow screens share, so a mutation in one
// re-renders the others (Phase C, TDD ADR-3). In the public demo the sample decisions and nudges are dated from the
// day the database was seeded (lib/demo/samples/clock.ts), handed down so the server and the browser agree.
export default async function WorkflowLayout({ children }: { children: ReactNode }) {
  const now = demoMode() ? (await demoSampleNow()).toISOString() : undefined;
  return <WorkflowProvider now={now}>{children}</WorkflowProvider>;
}
