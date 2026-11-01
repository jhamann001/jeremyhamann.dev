import { z } from "zod";

export const RECEIVING_REGISTRATIONS = [
  "Individual",
  "Joint tenants with rights of survivorship",
  "Joint tenants in common",
  "Community Property",
  "Traditional IRA",
  "Roth IRA",
  "Inherited Traditional IRA",
  "Inherited Roth IRA",
  "SEP IRA",
  "SIMPLE IRA",
  "Trust",
] as const;

export type ReceivingRegistration = (typeof RECEIVING_REGISTRATIONS)[number];
// New confirmations accept only a deliberate choice from the shared dropdown.
export const receivingRegistrationSchema = z.enum(RECEIVING_REGISTRATIONS);

const aliases: Readonly<Record<string, ReceivingRegistration>> = {
  "brokerage / individual": "Individual",
  "individual brokerage": "Individual",
  "joint account (jtwros - rights of survivorship)": "Joint tenants with rights of survivorship",
  "joint account (tic - tenants in common)": "Joint tenants in common",
  "jt wros": "Joint tenants with rights of survivorship",
  jtwros: "Joint tenants with rights of survivorship",
  "jt tic": "Joint tenants in common",
  tic: "Joint tenants in common",
  "community property registration": "Community Property",
  "inherited traditional ira (w/ beneficiaries)": "Inherited Traditional IRA",
};

/** Suggest an exact, unambiguous historical equivalent without rewriting the
 * stored evidence. Ambiguous labels (IRA, Joint, Inherited IRA) stay unresolved. */
export function suggestedReceivingRegistration(value: string | null | undefined): ReceivingRegistration | "" {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "";
  const alias = Object.hasOwn(aliases, normalized) ? aliases[normalized] : undefined;
  return RECEIVING_REGISTRATIONS.find((registration) => registration.toLowerCase() === normalized) ?? alias ?? "";
}
