import { beforeEach, describe, expect, it, vi } from "vitest";

const { ingestSpy, pausedSpy, verifySpy } = vi.hoisted(() => ({
  ingestSpy: vi.fn(),
  pausedSpy: vi.fn(),
  verifySpy: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/ingest/auth", () => ({ requireIngestToken: ingestSpy }));
vi.mock("@/lib/maintenance", () => ({ appWritesPaused: pausedSpy }));
vi.mock("google-auth-library", () => ({
  OAuth2Client: class { verifyIdToken = verifySpy; },
}));

import { requireReviewQueueCronAuth } from "@/lib/cron/review-queue-auth";

const request = (token = "signed") => new Request("https://ops-portal.example/api/cron/review-queue", {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});

describe("review queue scheduler authentication", () => {
  beforeEach(() => {
    pausedSpy.mockReturnValue(false);
    ingestSpy.mockReturnValue({ ok: false });
    verifySpy.mockReset();
    process.env.REVIEW_QUEUE_SCHEDULER_AUDIENCE = "https://ops-portal.example/api/cron/review-queue";
    process.env.REVIEW_QUEUE_SCHEDULER_SERVICE_ACCOUNT = "service-account@example-project.iam.gserviceaccount.com";
  });

  it("retains the existing ingest bearer for controlled manual runs", async () => {
    ingestSpy.mockReturnValue({ ok: true });
    expect(await requireReviewQueueCronAuth(request())).toBe(true);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it("accepts only the exact Google issuer, audience, and scheduler identity", async () => {
    verifySpy.mockResolvedValue({ getPayload: () => ({
      iss: "https://accounts.google.com",
      email_verified: true,
      email: "service-account@example-project.iam.gserviceaccount.com",
    }) });
    expect(await requireReviewQueueCronAuth(request())).toBe(true);
    expect(verifySpy).toHaveBeenCalledWith({
      idToken: "signed",
      audience: "https://ops-portal.example/api/cron/review-queue",
    });
  });

  it("fails closed for a different service account or maintenance pause", async () => {
    verifySpy.mockResolvedValue({ getPayload: () => ({
      iss: "https://accounts.google.com", email_verified: true,
      email: "other-account@example-project.iam.gserviceaccount.com",
    }) });
    expect(await requireReviewQueueCronAuth(request())).toBe(false);
    pausedSpy.mockReturnValue(true);
    expect(await requireReviewQueueCronAuth(request())).toBe(false);
  });

  it("does not replay a valid scheduler token onto a different route", async () => {
    verifySpy.mockResolvedValue({ getPayload: () => ({
      iss: "https://accounts.google.com", email_verified: true,
      email: "service-account@example-project.iam.gserviceaccount.com",
    }) });
    const otherRoute = new Request("https://ops-portal.example/api/cron/review-queue/validate", {
      method: "POST", headers: { authorization: "Bearer signed" },
    });
    expect(await requireReviewQueueCronAuth(otherRoute)).toBe(false);
    expect(verifySpy).not.toHaveBeenCalled();
  });
});
