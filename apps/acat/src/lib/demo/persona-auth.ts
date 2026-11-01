// Persona sign-in's check, kept apart from NextAuth so it can be tested on its own. The signIn and jwt
// callbacks in auth.ts still apply their usual domain, allow-list and role checks afterwards.

import { canonicalPersonaEmail } from "./personas";

export interface PersonaUserRow {
  email: string;
  name: string | null;
  active: boolean;
}

/** The persona to sign in as, or null: only a persona email, and only while its account is active. */
export async function authorizePersona(
  rawEmail: unknown,
  findUser: (email: string) => Promise<PersonaUserRow | null>,
): Promise<{ email: string; name: string } | null> {
  const email = typeof rawEmail === "string" ? canonicalPersonaEmail(rawEmail) : null;
  if (!email) return null;
  const user = await findUser(email);
  if (!user?.active || user.email !== email) return null;
  return { email: user.email, name: user.name ?? email };
}
