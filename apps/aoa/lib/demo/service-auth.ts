import "server-only";
import { GoogleAuth, IdTokenClient } from "google-auth-library";
import { demoMode } from "./mode";
import { standInFetch } from "./stand-ins/fetch";

// The Google identity every outbound service client starts from, in place of `new GoogleAuth()`. Outside the demo it
// is GoogleAuth, unchanged. In the public demo there is no Google identity and nothing leaves the process: an ID-token
// client still runs Google's request pipeline (status checks, JSON and binary bodies, errors), but its last step, the
// network call, is answered by the in-app stand-ins (./stand-ins). Every other Google call (credentials, access tokens,
// signing, requests) goes through getClient, which refuses.

export class DemoOfflineError extends Error {
  constructor() {
    super("Outside services are not reachable in the demo");
    this.name = "DemoOfflineError";
  }
}

const DEMO_ID_TOKEN = "demo-stand-in";

export class ServiceAuth extends GoogleAuth {
  async getIdTokenClient(targetAudience: string): Promise<IdTokenClient> {
    if (!demoMode()) return super.getIdTokenClient(targetAudience);
    return new IdTokenClient({
      targetAudience,
      idTokenProvider: { fetchIdToken: async () => DEMO_ID_TOKEN },
      transporterOptions: { fetchImplementation: standInFetch },
    });
  }

  async getClient(): ReturnType<GoogleAuth["getClient"]> {
    if (demoMode()) throw new DemoOfflineError();
    return super.getClient();
  }
}
