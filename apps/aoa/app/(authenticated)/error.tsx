"use client";

import { Card, CardBody, CardHeader } from "@/components/ui";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

/** Keep navigation available without rendering server/SQL/identity details. */
export default function AuthenticatedPageError({ reset }: { reset: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Card role="alert">
      <CardHeader><h1>This page could not load</h1></CardHeader>
      <CardBody>
        <p>Try loading it again, or choose another section from the sidebar. Your current address and filters are unchanged.</p>
        <button className="btn" type="button" disabled={pending} aria-busy={pending} onClick={() => startTransition(() => {
          // reset alone can replay the same failed server-component payload.
          // Refresh the current URL under fresh authorization before retrying.
          router.refresh();
          reset();
        })}>{pending ? "Retrying…" : "Try again"}</button>
      </CardBody>
    </Card>
  );
}
