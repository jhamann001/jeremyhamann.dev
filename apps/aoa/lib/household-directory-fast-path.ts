// Keep this flag separate from shared flags.ts so the narrow Households release
// can be promoted without copying unrelated development flags to production.
export function householdDirectoryFastPathEnabled(): boolean {
  return process.env.HOUSEHOLD_DIRECTORY_FAST_PATH === "1";
}
