import { expect, test } from "@playwright/test";

test("reports application and database readiness", async ({ request }) => {
  const response = await request.get("/api/health");

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(await response.json()).toEqual({ ok: true, db: true });
});

test("protects application routes and requires Okta sign-in", async ({ page }) => {
  await page.goto("/command-center");

  const destination = new URL(page.url());
  expect(destination.pathname).toBe("/");
  expect(destination.searchParams.get("callbackUrl")).toBe("/command-center");
  await expect(page.getByText("Always-On Advice", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with Okta" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dev sign-in" })).toHaveCount(0);
});
