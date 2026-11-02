import { smartNudgesRequirementsResolverEnabled } from "@/lib/flags";
import { SmartNudgesView } from "@/components/smart-nudges/SmartNudgesView";

// Route entry (Server Component). Reads the ticket requirements-resolver env
// flag server-side and threads it as a boolean prop into the client view. Kept
// server-side deliberately: a non-NEXT_PUBLIC env var read from a client bundle
// would inline as undefined and the panel could never render. Default off — the
// Template Library renders exactly as before until the env var is set to "1".
export default function Page() {
  return <SmartNudgesView requirementsResolverEnabled={smartNudgesRequirementsResolverEnabled()} />;
}
