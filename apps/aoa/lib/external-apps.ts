// Canonical URLs for the three Operations tools that also run as standalone
// apps outside AOA (ticket). Defined once here so the nav
// (components/shell/nav-config.ts) and the funding-picture card
// (components/transfers/FundingPictureCard.tsx) link out to the SAME place —
// no copy-pasted literals. These open in a new tab from within AOA. In this
// copy they are the public demos of those apps, on the same invented firm.
export const EXTERNAL_APPS = {
  acatTracking: "https://transfers.jeremyhamann.dev/login?callbackUrl=%2F",
  acatCustodians: "https://transfers.jeremyhamann.dev/login?callbackUrl=%2Fadmin%2Fcustodians",
  assetMapping: "https://statements.jeremyhamann.dev/",
  tradeRequests: "https://trade.jeremyhamann.dev/login",
} as const;
