import type { ClientExclusion, ClientExclusionKind } from '@trade-request/shared';

/**
 * v3.4 — render the DNB/DNS abbreviation pair for a single exclusion. The
 * server's `formatSide` in `routes/exclusions.ts` and `services/slack.ts`
 * must use the exact same vocabulary so the trader sees consistent labels
 * across Slack, the bell notification, the AdvisorForm textarea, and the
 * eventual PDF/CSV export.
 */
export function formatExclusionSide(e: Pick<ClientExclusion, 'noBuy' | 'noSell'>): string {
  if (e.noBuy && e.noSell) return 'DNB+DNS';
  if (e.noBuy) return 'DNB';
  return 'DNS';
}

/**
 * Display-focused reason sanitizer for imported restrictions. Some imported
 * reasons contain noisy file paths or parser metadata; in UI surfaces we only
 * need a concise source tag.
 */
export function formatRestrictionReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  const mentionsAlpha = lower.includes('meridian');
  const mentionsRestrictionsFile = lower.includes('restrictions.csv');
  const looksLikeImportedFileReason =
    /^imported\b/.test(lower) && (lower.includes('.csv') || lower.includes('/') || lower.includes('\\'));

  if (mentionsAlpha || mentionsRestrictionsFile || looksLikeImportedFileReason) {
    return 'Imported from Meridian restrictions file';
  }
  return trimmed;
}

/**
 * Builds the semicolon-delimited string that auto-fills the AdvisorForm's
 * exclusion textareas (one call per kind: 'advisor' or 'client'). With a
 * single client the entries are `TICKER (SIDE - reason)`. With multiple
 * clients (household), each entry is attributed via `– ClientName` inside
 * the parens so the trader can tell which household member each came from.
 *
 * v3.4 prepends a SIDE token (DNB / DNS / DNB+DNS) before the reason; v3.2
 * household attribution is preserved verbatim.
 */
export function formatExclusionsForTextarea(
  byClient: Record<string, ClientExclusion[]>,
  clientsInOrder: Array<{ id: string; name: string }>,
  kind: ClientExclusionKind,
): string {
  const attribute = clientsInOrder.length > 1;
  const parts: string[] = [];
  for (const c of clientsInOrder) {
    const list = byClient[c.id] ?? [];
    for (const e of list) {
      if (e.kind !== kind) continue;
      const side = formatExclusionSide(e);
      if (attribute) {
        parts.push(e.reason ? `${e.ticker} (${side} - ${e.reason} – ${c.name})` : `${e.ticker} (${side} – ${c.name})`);
      } else {
        parts.push(e.reason ? `${e.ticker} (${side} - ${e.reason})` : `${e.ticker} (${side})`);
      }
    }
  }
  return parts.join('; ');
}
