import { expect, type Page } from "@playwright/test";

export async function signInOperations(page: Page, path: string) {
  await page.goto(`/?callbackUrl=${encodeURIComponent(path)}`);
  await expect(page.getByRole("heading", { name: "Dev sign-in" })).toBeVisible();
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(path.split("?")[0]));
}

export async function manualOperationsLoading(page: Page) {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true }));
}
