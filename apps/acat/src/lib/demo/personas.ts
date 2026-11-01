// The demo's sign-in personas: three of Cedar Ridge's staff from the universe, one per role. Visitors
// sign in as one of them with no password (PERSONA_SIGN_IN=on). They are the only accounts persona
// sign-in accepts, and they are fenced: nobody can change their role, name, status or MCP access, so
// every visitor finds them as the seed left them. Safe to import from client code (the sign-in page
// lists them); a test keeps this list in step with the universe.

export type PersonaRole = "ADMIN" | "USER" | "ADVISOR";

export interface Persona {
  email: string;
  name: string;
  role: PersonaRole;
  label: string;
  blurb: string;
}

export const PERSONAS: readonly Persona[] = [
  { email: "jordan.reyes@example.com", name: "Jordan Reyes", role: "USER", label: "Ops", blurb: "Transfer specialist · works the queue" },
  { email: "marco.ferreira@example.com", name: "Marco Ferreira", role: "ADMIN", label: "Admin", blurb: "Operations · custodians, fees and users" },
  { email: "rachel.moss@example.com", name: "Rachel Moss", role: "ADVISOR", label: "Advisor", blurb: "Advisor · a read-only, redacted view of transfers" },
];

/** Server only: whether the persona sign-in provider is on. */
export const personaSignInEnabled = (): boolean => process.env.PERSONA_SIGN_IN === "on";

/**
 * The canonical (lowercase, trimmed) persona email for `email` in any letter case, or null. Every
 * persona check goes through here, so a case variant can neither sign in as a persona nor slip past
 * the fence.
 */
export function canonicalPersonaEmail(email: string): string | null {
  const key = email.trim().toLowerCase();
  return PERSONAS.some((p) => p.email === key) ? key : null;
}

export const isPersonaEmail = (email: string): boolean => canonicalPersonaEmail(email) !== null;
