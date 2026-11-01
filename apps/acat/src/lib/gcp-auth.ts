import { GoogleAuth } from "google-auth-library";
import { isStandInUrl, standInPipelineToken } from "@/lib/demo/flags";

let auth: GoogleAuth;

/** The slice of an authenticated client the asset-mapping calls use. */
export interface PipelineClient {
  request<T>(opts: { url: string }): Promise<{ status: number; data: T }>;
}

export async function getAuthenticatedClient(targetAudience: string): Promise<PipelineClient> {
  if (isStandInUrl(targetAudience)) return standInClient();
  if (!auth) {
    auth = new GoogleAuth();
  }
  return auth.getIdTokenClient(targetAudience);
}

// Demo only: the statement pipeline's loopback stand-in takes a per-process token instead of a
// Google-signed identity token. Errors carry `response.status`, as the Google client's do.
function standInClient(): PipelineClient {
  return {
    async request<T>({ url }: { url: string }) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${standInPipelineToken()}` }, cache: "no-store" });
      if (!res.ok) {
        await res.body?.cancel();
        throw Object.assign(new Error(`Request failed with status code ${res.status}`), { response: { status: res.status } });
      }
      return { status: res.status, data: (await res.json()) as T };
    },
  };
}
