// Client-safe, bounded source envelope. Never infer parties from message bodies.
export type EmailParty = { name: string | null; address: string | null };
export type EmailEnvelopeState = "MATCHED" | "MISSING" | "UNAVAILABLE" | "AMBIGUOUS";
export type EmailEnvelope = {
  version: 1;
  state: EmailEnvelopeState;
  task_sf_id: string;
  message_sf_id: string | null;
  observed_at: string;
  source_modified_at: string | null;
  sender: EmailParty | null;
  to: EmailParty[];
  cc: EmailParty[];
};
export type EmailEnvelopeCoverage = {
  matched: number; enriched: number; missing: number; unavailable: number; ambiguous: number; unknown: number;
};

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number) => v === null || (typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(v));
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const iso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().replace('.000Z', 'Z') === v.replace('.000Z', 'Z');
const party = (v: unknown): v is EmailParty => object(v) && exact(v, ["name", "address"]) && text(v.name, 255) && text(v.address, 320) && (v.name !== null || v.address !== null);
const parties = (v: unknown): v is EmailParty[] => Array.isArray(v) && v.length <= 200 && v.every(party);
export const sameSourceId = (a: string, b: string) => a.length >= 15 && b.length >= 15 ? a.slice(0, 15) === b.slice(0, 15) : a === b;

export function isEmailEnvelope(value: unknown, taskId?: string): value is EmailEnvelope {
  if (!object(value) || !exact(value, ["version", "state", "task_sf_id", "message_sf_id", "observed_at", "source_modified_at", "sender", "to", "cc"])) return false;
  if (value.version !== 1 || !["MATCHED", "MISSING", "UNAVAILABLE", "AMBIGUOUS"].includes(String(value.state)) ||
    typeof value.task_sf_id !== "string" || !/^00T[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(value.task_sf_id) ||
    (taskId !== undefined && (!/^00T[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(taskId) || !sameSourceId(value.task_sf_id, taskId))) || !iso(value.observed_at) ||
    !(value.source_modified_at === null || iso(value.source_modified_at)) || !parties(value.to) || !parties(value.cc)) return false;
  if (value.state !== "MATCHED") return value.message_sf_id === null && value.source_modified_at === null && value.sender === null && value.to.length === 0 && value.cc.length === 0;
  return typeof value.message_sf_id === "string" && /^02s[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(value.message_sf_id) && (value.sender === null || party(value.sender));
}

export function stripLoggedBcc(body: string | null | undefined): string | null {
  if (typeof body !== "string") return null;
  return body.replace(/\r\n?/g, "\n").replace(/(^|\n)[ \t]*bcc[ \t]*:[^\n]*(?:\n[ \t]+[^\n]*)*/gi, "$1").trim() || null;
}

// Unknown keys on a party or observation are rejected, including every Bcc alias.
export function hasForbiddenBccKey(value: unknown): boolean {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > 24) return true;
    if (Array.isArray(current.value)) for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
    else if (object(current.value)) for (const [key, item] of Object.entries(current.value)) {
      if (/bcc/i.test(key)) return true;
      pending.push({ value: item, depth: current.depth + 1 });
    }
  }
  return false;
}
