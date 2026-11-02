import { expect, type Page } from "@playwright/test";
import { CLIENT_SERVICE_EMAIL } from "./trade-requests-workspace-fixture";

export const PERSONAS = {
  ADMIN: "admin@example.com", OPERATIONS: "ops@example.com", ADVISOR: "avery@example.com",
  CLIENT_SERVICE: CLIENT_SERVICE_EMAIL, VIEWER: "view@example.com",
} as const;
export type Persona = keyof typeof PERSONAS;
export const TRADE_REQUESTS_EXTERNAL = "https://trade-request-123456789012.us-central1.run.app/login";
export const NO_PERMISSION = "You don't have permission to view this page.";

// Persona-picker labels from app/page.tsx DEV_PERSONAS.
const PICKER_LABELS: Partial<Record<Persona, string>> = {
  ADMIN: "Dana Admin · ADMIN (sees all)", OPERATIONS: "Riley Ops · OPERATIONS (sees all)",
  ADVISOR: "Avery Stone · ADVISOR (own book)", VIEWER: "Val Viewer · VIEWER (sees none)",
};

export async function signInAs(page: Page, role: Persona, path = "/command-center") {
  const label = PICKER_LABELS[role];
  if (label) {
    await page.goto(`/?callbackUrl=${encodeURIComponent(path)}`);
    await expect(page.getByRole("heading", { name: "Dev sign-in" })).toBeVisible();
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path.split("?")[0]}$`));
  } else {
    // The picker has no CLIENT_SERVICE persona; the dev Credentials callback
    // signs in the synthetic fixture user instead.
    const { csrfToken } = await (await page.request.get("/api/auth/csrf")).json();
    const res = await page.request.post("/api/auth/callback/dev", {
      form: { csrfToken, email: PERSONAS[role], callbackUrl: path }, headers: { "X-Auth-Return-Redirect": "1" }, maxRedirects: 0,
    });
    expect(res.status()).toBeLessThan(400);
    await page.goto(path);
  }
  // includeHidden: the mobile layout keeps the main navigation collapsed.
  await expect(page.getByRole("navigation", { name: "Main navigation", includeHidden: true })).toBeAttached();
}
