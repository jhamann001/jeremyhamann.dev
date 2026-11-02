/** Browser-safe canonical task definitions shared by writers and readiness summaries. */
export const PARTIAL_ACAT_EXECUTION_TASKS = [
  {
    key: "prepare-wet-signature-paperwork",
    title: "Prepare partial-ACAT paperwork and arrange the client wet-signature package",
    owner: "CLIENT_SERVICE" as const,
    sort: 20,
  },
  {
    key: "review-submit-partial-acat",
    title: "Review the completed paperwork, then submit the partial ACAT",
    owner: "OPERATIONS" as const,
    sort: 30,
  },
  {
    key: "track-partial-acat",
    title: "Track the partial ACAT through completion",
    owner: "OPERATIONS" as const,
    sort: 40,
  },
] as const;
