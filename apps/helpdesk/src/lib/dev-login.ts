/**
 * Development personas + kill switch — pure and edge-safe.
 *
 * `process.env` is read LITERALLY here (no env object) so the predicate is identical in the edge
 * middleware, the node auth module, the sign-in RSC and the instrumentation hook.
 *
 * The environment a process SERVES is `APP_ENV`, which Terraform sets explicitly per project (production pins
 * "production", the dev service pins "dev"; unset means local). `NODE_ENV` is deliberately NOT consulted:
 * Cloud Run runs every image, dev included, with NODE_ENV=production, so keying the kill switch on it made a
 * deployed dev instance impossible to sign into before an Okta application exists. We do not claim the branch
 * is compiled out; we claim it cannot be enabled where APP_ENV=production (three independent checks: this
 * predicate, `assertDevLoginNotInProduction` at module load and at boot, and `parseEnv`'s production block).
 */
import type { DevPersona } from "@/types/domain";

/**
 * The demo's four sign-in personas (plan decision D4): staff from the shared synthetic universe, with the ids,
 * names, emails and groups `seedFromUniverse` gives them (prisma/seed-dev.ts), so signing in lands on the
 * seeded account. The desk supervisor is seeded as staff but is not a persona.
 */
export const DEV_PERSONAS: readonly DevPersona[] = [
  {
    key: "ops",
    id: "staff_marco",
    name: "Marco Ferreira",
    email: "marco.ferreira@example.com",
    groups: ["ops_team"],
    title: "Operations · runs the money-movement queue and the desk's admin pages",
  },
  {
    key: "cs",
    id: "staff_helen",
    name: "Helen Carver",
    email: "helen.carver@example.com",
    groups: ["client_services"],
    title: "Client service · answers clients by email and phone",
  },
  {
    key: "advisor",
    id: "staff_rachel",
    name: "Rachel Moss",
    email: "rachel.moss@example.com",
    groups: ["advisors"],
    title: "Advisor · sees only what the advisor group may see",
  },
  {
    key: "compliance",
    id: "staff_priya",
    name: "Priya Nair",
    email: "priya.nair@example.com",
    groups: ["compliance_officers"],
    title: "Compliance · supervisory reviews and the audit log",
  },
];

/** Auth.js provider id of the Credentials-based persona provider. */
export const DEV_PROVIDER_ID = "dev-persona" as const;

/**
 * True only when AUTH_DEV_LOGIN is literally "true" AND the process does not serve production
 * (`APP_ENV !== "production"`; unset APP_ENV is local). NODE_ENV plays no part.
 */
export function isDevLoginEnabled(): boolean {
  return process.env.AUTH_DEV_LOGIN === "true" && process.env.APP_ENV !== "production";
}

/** Throws when a process labelled APP_ENV=production carries AUTH_DEV_LOGIN=true (module load of auth.ts, `next start`). */
export function assertDevLoginNotInProduction(): void {
  if (process.env.APP_ENV === "production" && process.env.AUTH_DEV_LOGIN === "true") {
    throw new Error("AUTH_DEV_LOGIN must not be enabled in production");
  }
}

export function findDevPersona(key: string): DevPersona | null {
  return DEV_PERSONAS.find((p) => p.key === key) ?? null;
}

/**
 * Whether `userId` is one of the sign-in personas' accounts, compared canonically (trimmed, lower case) so a
 * variant spelling cannot slip past the fence that keeps the shared demo accounts unchanged.
 */
export function isPersonaUserId(userId: string): boolean {
  const key = userId.trim().toLowerCase();
  return DEV_PERSONAS.some((p) => p.id === key);
}
