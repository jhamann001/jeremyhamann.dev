import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const operationsSlackNotificationStatusSchema = z.enum([
  "PENDING", "SENDING", "RETRY", "SENT", "FAILED", "UNCERTAIN",
]);

// A last_code is metadata only if it belongs to the sender's fixed vocabulary.
// Never expose arbitrary persisted text, even when it resembles an error code.
export const operationsSlackDiagnosticCodeSchema = z.enum([
  "access_denied", "accesslimited", "account_inactive", "app_access_restricted",
  "channel_not_found", "ekm_access_denied", "enterprise_is_restricted",
  "invalid_arg_name", "invalid_arguments", "invalid_array_arg", "invalid_auth",
  "invalid_blocks", "invalid_blocks_format", "invalid_charset", "invalid_form_data",
  "invalid_post_type", "is_archived", "message_limit_exceeded", "missing_post_type",
  "missing_scope", "no_permission", "no_text", "not_allowed_token_type", "not_authed",
  "not_in_channel", "request_timeout", "restricted_action", "restricted_action_read_only_channel",
  "restricted_action_thread_only_channel", "team_access_not_granted", "token_expired", "token_revoked",
  "retry_after_exceeds_limit", "rate_limited", "delivery_disabled", "invalid_request",
  "http_ambiguous", "http_rejected", "invalid_response", "invalid_receipt", "slack_ambiguous",
  "transport_or_response_ambiguous", "claim_expired", "retry_exhausted", "unrecognized_code",
]);

const receipt = z.object({
  requestId: z.literal("ops195-test-notification-20260926"),
  requestStatus: z.literal("CANCELLED"),
  notificationStatus: operationsSlackNotificationStatusSchema,
  attempts: count,
  channelId: z.literal("C00OBJK6X0W"),
  slackTs: z.string().regex(/^\d{10,16}\.\d{6}$/).nullable(),
  lastCode: operationsSlackDiagnosticCodeSchema.nullable(),
  capturedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  submissionEventCount: z.literal(1),
  cancellationEventCount: z.literal(1),
}).strict().refine((value) =>
  (value.notificationStatus === "SENT") === (value.slackTs !== null)
  && (value.notificationStatus !== "SENT" || (value.attempts > 0 && value.lastCode === null))
  && (value.notificationStatus !== "PENDING" || value.attempts === 0),
);

export const operationsSlackDiagnosticSchema = z.object({
  counts: z.object({
    PENDING: count, SENDING: count, RETRY: count, SENT: count, FAILED: count, UNCERTAIN: count,
  }).strict(),
  needsReviewCount: count,
  delayedRetryCount: count,
  captureEnabled: z.boolean(),
  deliveryEnabled: z.boolean(),
  configurationValid: z.boolean(),
  writesPaused: z.boolean(),
  test: receipt.nullable(),
}).strict().refine((value) =>
  value.needsReviewCount <= value.counts.FAILED + value.counts.UNCERTAIN
  && value.delayedRetryCount <= value.counts.RETRY
  && (value.test === null || value.counts[value.test.notificationStatus] >= 1),
);

export type OperationsSlackDiagnostic = z.infer<typeof operationsSlackDiagnosticSchema>;
