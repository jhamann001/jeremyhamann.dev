// The demo's sign-in personas: four of Cedar Ridge's staff from the synthetic universe, one per role, the same
// people the other demos use. Visitors sign in as one of them with no password (PERSONA_SIGN_IN=on), and they are
// the only accounts persona sign-in accepts. Nothing in the app can change a user's role or name except an Okta
// sign-in, which the demo doesn't have, so every visitor finds them as the seed left them. Safe to import from
// client code.

export type PersonaRole = "ADMIN" | "OPERATIONS" | "ADVISOR" | "CLIENT_SERVICE";

export interface Persona {
  email: string;
  name: string;
  role: PersonaRole;
  /** The sign-in button's text. */
  label: string;
}

export const PERSONAS: readonly Persona[] = [
  { email: "priya.nair@example.com", name: "Priya Nair", role: "ADMIN", label: "Priya Nair · ADMIN (whole firm)" },
  { email: "jordan.reyes@example.com", name: "Jordan Reyes", role: "OPERATIONS", label: "Jordan Reyes · OPERATIONS (whole firm)" },
  { email: "rachel.moss@example.com", name: "Rachel Moss", role: "ADVISOR", label: "Rachel Moss · ADVISOR (own book)" },
  { email: "helen.carver@example.com", name: "Helen Carver", role: "CLIENT_SERVICE", label: "Helen Carver · CLIENT SERVICE (all households)" },
];

/** Server only: whether persona sign-in is the app's sign-in. */
export const personaSignInEnabled = (): boolean => process.env.PERSONA_SIGN_IN === "on";

/**
 * The canonical (lowercase, trimmed) persona email for `email` in any letter case, or null. Every persona check goes
 * through here, so a case variant can't sign in as anyone else.
 */
export function canonicalPersonaEmail(email: string): string | null {
  const key = email.trim().toLowerCase();
  return PERSONAS.some((p) => p.email === key) ? key : null;
}

/**
 * Server only: the email the dev login may sign in as, or null. With persona sign-in on, only a persona's; otherwise
 * (local dev, the dev instance) any seeded user's, as before.
 */
export function devLoginEmail(raw: unknown): string | null {
  const email = String(raw ?? "").toLowerCase();
  if (!email) return null;
  return personaSignInEnabled() ? canonicalPersonaEmail(email) : email;
}
