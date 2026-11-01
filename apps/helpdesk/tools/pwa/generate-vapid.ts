/**
 * `npm run pwa:vapid` — mints a VAPID key pair (`pwa-push`).
 *
 * It PRINTS the pair and writes nothing. `VAPID_PRIVATE_KEY` is a signing secret: in a deployment it
 * belongs in Secret Manager and reaches the service as an environment variable, exactly like every
 * other secret this repo handles (the build record). A tool that helpfully appended it to `.env`
 * would be a tool that helpfully committed it.
 *
 * Rotating the pair INVALIDATES EVERY EXISTING SUBSCRIPTION — a browser bakes the application server
 * key into the subscription it created, and a message signed with a different key is refused. Every
 * device has to opt in again, and the stale rows are pruned by the first 410 each one earns. That is
 * not a reason never to rotate; it is a reason to say so before somebody does it on a Friday.
 *
 * Output is base64url in the two shapes the rest of the stack uses: the raw 32-byte private scalar
 * and the raw uncompressed 65-byte public point — the same shapes `src/lib/env.ts` validates and the
 * same ones a browser's `applicationServerKey` takes.
 */
import { createECDH } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CURVE = "prime256v1";

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type VapidKeyPair = { publicKey: string; privateKey: string };

/** A fresh P-256 pair, base64url. Exported so the test can assert the shapes without spawning a CLI. */
export function generateVapidKeys(): VapidKeyPair {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return {
    publicKey: toBase64Url(new Uint8Array(ecdh.getPublicKey())),
    privateKey: toBase64Url(new Uint8Array(ecdh.getPrivateKey())),
  };
}

function main(): number {
  const { publicKey, privateKey } = generateVapidKeys();
  process.stdout.write(
    [
      "# A new VAPID key pair. Store the private key as a secret; never commit it.",
      "# All three keys are required together — set VAPID_SUBJECT too.",
      `VAPID_PUBLIC_KEY=${publicKey}`,
      `VAPID_PRIVATE_KEY=${privateKey}`,
      "VAPID_SUBJECT=mailto:helpdesk@example.invalid",
      "",
      "# Rotating this pair invalidates every existing PushSubscription row; each device must opt in again.",
      "",
    ].join("\n"),
  );
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
