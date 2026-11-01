/**
 * Requester-domain guard — pure, layer L1.
 *
 * WAVE B FOUNDATION STUB. **Owned by slice B11 (import-intake)**, which may widen the policy. The
 * SIGNATURE is the contract: `createTicketCore` already calls `assertRequesterAllowed` before it
 * writes, so B11 changes this file and nothing else. The behaviour below is real from this commit.
 *
 * What it is for. A dev or local instance carries seeded fixtures that look like real clients, and it
 * shares a code path with production: the same `createTicketCore`, the same outbox, the same reply
 * addressing. The only thing standing between a dev instance and a real client's inbox is that no
 * outbound key is set — which is a configuration fact, not a control. `ALLOWED_REQUESTER_DOMAINS`
 * makes it a control: where it is set, an address outside the list cannot become a ticket at all.
 *
 * Deliberately OFF in production. Production's requester domains are every domain Cedar Ridge's clients
 * use, which is not a list anyone can maintain, and a guard that has to be disabled to work is a guard
 * that will be disabled. Unset means no guard; production leaves it unset and Terraform sets it on dev.
 */
import { ValidationError } from "@/lib/errors";

/** Whether `email` sits on one of `domains`. A subdomain does NOT match: `a.example.com` ≠ `example.com`. */
export function isRequesterDomainAllowed(email: string | null | undefined, domains: readonly string[]): boolean {
  if (email === null || email === undefined) return true; // a phone-only ticket has no domain to check
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domains.includes(domain);
}

/**
 * Throws `ValidationError` when the guard is ON and the address is outside it. `domains` is
 * `allowedRequesterDomains(env.ALLOWED_REQUESTER_DOMAINS)`: `undefined` means no guard, and the
 * function is a no-op. The message names the DOMAIN, never the full address — the refusal goes into an
 * error body, and an error body is not a place to echo a client's email back.
 */
export function assertRequesterAllowed(
  email: string | null | undefined,
  domains: readonly string[] | undefined,
): void {
  if (domains === undefined) return;
  if (isRequesterDomainAllowed(email, domains)) return;
  const at = (email ?? "").lastIndexOf("@");
  const domain = at < 0 ? "(none)" : (email ?? "").slice(at + 1).toLowerCase();
  throw new ValidationError(`requester domain is not allowed on this instance: ${domain}`);
}
