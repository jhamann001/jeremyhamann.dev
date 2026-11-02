import type { AoaAcatCandidate, LinkageRecord } from "../acat-link-contract";
import { acatPairIdentityReason, acatPairLifecycleEligible } from "../acat-match";

/** Explains the existing picker predicate without widening matching policy.
 * A listed record still requires review and guarded application. */
export function reviewCandidateChoices(target: AoaAcatCandidate | undefined, records: readonly LinkageRecord[]): {
  records: LinkageRecord[]; message: string | null;
} {
  const empty = (message: string) => ({ records: [], message });
  if (!target) return empty("This AOA transfer is no longer available. Prepare a fresh review.");
  if (target.existingRecordId || target.existingTransferUuid) return empty("This transfer already has an ACAT link or transfer reference. This picker does not replace existing links.");
  if (target.archived) return empty("This transfer is archived. The current picker only supports new links for active transfers in Decision or In Transfer.");
  if (!["DECISION", "IN_TRANSFER"].includes(target.stage)) return empty("This transfer is outside Decision or In Transfer. Historical transfers need a separate evidence review; this picker cannot create a new link for them.");
  if (!["ACAT_FULL", "ACAT_PARTIAL"].includes(target.fundingType ?? "")) return empty("This transfer is not set to full or partial ACAT funding. It is outside this picker's current scope.");
  if (target.identityState === "conflict") return empty("This transfer has conflicting Cedar Ridge identity evidence. Resolve that evidence before selecting an ACAT.");
  if (target.identityState !== "verified" || target.canonicalClientUserIds.length === 0) return empty("This transfer has no verified Cedar Ridge identity. Verify its client identity before selecting an ACAT.");
  if (!records.length) return empty("The complete Tracker snapshot contains no ACAT records.");
  const identityMatches = records.filter((row) => acatPairIdentityReason(target, row) === null);
  const eligible = identityMatches.filter((row) => acatPairLifecycleEligible(target, row));
  if (eligible.length) return { records: eligible, message: null };
  if (identityMatches.length) return empty("Records have matching identity evidence, but none meet the current new-link rules for status, direction, workflow and full or partial transfer type. Deleted and completed history is not offered by this picker.");
  return empty("No Tracker records have sufficient matching identity and receiving-account holder evidence for this transfer. Joint accounts require complete holder proof. This does not establish that no historical counterpart exists.");
}
