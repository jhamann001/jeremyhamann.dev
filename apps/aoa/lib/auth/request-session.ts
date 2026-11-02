import { cache } from "react";
import { auth } from "@/auth";
import { measureRequestPhase } from "@/lib/observability/request-timing";

/** Share one authorization read across server-rendered layout and page segments
 * of the same request. React scopes this cache to the current render request;
 * it never reuses a session or role across navigations or users. */
export const getRequestSession = cache(() =>
  measureRequestPhase("render_session", () => auth()),
);
