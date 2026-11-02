// Prints the owner URL the deploy and the nightly reset use (lib/demo/logins.ts, demoOwnerDirectUrl), from the
// repository secret in AOA_DATABASE_URL. For a workflow to capture, never to show:
//
//   owner=$(npm run -s demo:owner-url)     (from apps/aoa; GitHub masks the secret it is made from, and the step
//                                           masks the result too)

import { demoOwnerDirectUrl } from "../lib/demo/logins";

const raw = process.env.AOA_DATABASE_URL;
if (!raw) {
  console.error("AOA_DATABASE_URL (the database owner's connection string) is required.");
  process.exit(1);
}
try {
  process.stdout.write(demoOwnerDirectUrl(raw));
} catch (error) {
  console.error(error instanceof Error ? error.message : "demo_owner_url_invalid");
  process.exit(1);
}
