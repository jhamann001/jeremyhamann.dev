// Persona sign-in for the public demo: visitors sign in as one of the firm's advisors or traders from
// the universe, with no password. Only those staff accounts are personas, so a user a visitor invites
// never becomes a sign-in button. On when PERSONA_SIGN_IN=on.

import type { Pool } from 'pg';
import pool from '../db/pool.js';
import { appStaff, demoUniverse, staffEmail } from './universe.js';

export const personaSignInEnabled = (): boolean => process.env.PERSONA_SIGN_IN === 'on';

export interface Persona {
  email: string;
  name: string;
  role: 'advisor' | 'trader';
  title: string;
}

/** Persona email → its staff record, from the universe. */
function personaStaff(): Map<string, { name: string; title: string }> {
  return new Map(appStaff(demoUniverse()).map((s) => [staffEmail(s), { name: s.name, title: s.title }]));
}

/** The canonical (lowercase) persona email for `email` in any letter case, or null. Use it for every lookup:
 *  `users.email` is unique only case-sensitively, so a case-variant account must never stand in for a persona. */
export function canonicalPersonaEmail(email: string): string | null {
  const key = email.trim().toLowerCase();
  return personaStaff().has(key) ? key : null;
}

export const isPersonaEmail = (email: string): boolean => canonicalPersonaEmail(email) !== null;

/** The personas that can sign in right now: active users with a persona email. Traders first. */
export async function listPersonas(db: Pool = pool): Promise<Persona[]> {
  const staff = personaStaff();
  const { rows } = await db.query<{ email: string; name: string; role: 'advisor' | 'trader' }>(
    'SELECT email, name, role FROM users WHERE is_active AND email = ANY($1) ORDER BY role DESC, name',
    [[...staff.keys()]],
  );
  return rows.map((r) => ({ email: r.email, name: r.name, role: r.role, title: staff.get(r.email)?.title ?? '' }));
}

/** True when the user with this id is a persona. Personas keep their role and status so every visitor can use them. */
export async function isPersonaUser(id: string, db: Pool = pool): Promise<boolean> {
  // Compare as UUIDs (the route's own queries do too), never as text: '…ABC' and '…abc' are the same user.
  const { rows } = await db.query<{ email: string }>('SELECT email FROM users WHERE id = $1::uuid', [id]);
  // Exact match: a case-variant account a visitor invited is an ordinary user, not a persona.
  return rows.length > 0 && personaStaff().has(rows[0].email);
}
