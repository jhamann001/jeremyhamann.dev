/**
 * Typed error hierarchy shared by every layer.
 * Pure and edge-safe: imports only types from @/types/domain.
 */
import type { ActionError, ActionErrorCode } from "@/types/domain";

export class AppError extends Error {
  readonly code: ActionErrorCode;
  readonly status: number;
  constructor(code: ActionErrorCode, message: string, status: number) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super("UNAUTHORIZED", message, 401);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  readonly ticketId: string | null;
  constructor(message: string, ticketId?: string | null) {
    super("FORBIDDEN", message, 403);
    this.name = "ForbiddenError";
    this.ticketId = ticketId ?? null;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super("NOT_FOUND", message, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "The record changed since you loaded it") {
    super("CONFLICT", message, 409);
    this.name = "ConflictError";
  }
}

export class ValidationError extends AppError {
  readonly fieldErrors?: Record<string, string[]>;
  constructor(message: string, fieldErrors?: Record<string, string[]>) {
    super("VALIDATION", message, 400);
    this.name = "ValidationError";
    this.fieldErrors = fieldErrors;
  }
}

/** Thrown by the Prisma client extension when code attempts to mutate an append-only ledger. */
export class AuditImmutabilityError extends Error {
  readonly code = "AUDIT_IMMUTABLE" as const;
  readonly operation: string;
  constructor(operation: string) {
    super(`${operation} is forbidden: the ledger is append-only`);
    this.name = "AuditImmutabilityError";
    this.operation = operation;
  }
}

/** Thrown when the client-facing path would read or return something it must not. */
export class IsolationViolationError extends Error {
  readonly code = "ISOLATION_VIOLATION" as const;
  constructor(message: string) {
    super(message);
    this.name = "IsolationViolationError";
  }
}

/** Thrown by recordView when a router prefetch reaches a content read. */
export class PrefetchNotAllowedError extends Error {
  readonly code = "PREFETCH_NOT_ALLOWED" as const;
  constructor() {
    super("Prefetch requests must not read ticket content");
    this.name = "PrefetchNotAllowedError";
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Maps any thrown value to an ActionError. Never leaks the message of an unknown error. */
export function toActionError(e: unknown): ActionError {
  if (isAppError(e)) {
    const base: ActionError = { ok: false, code: e.code, message: e.message };
    if (e instanceof ValidationError && e.fieldErrors) {
      return { ...base, fieldErrors: e.fieldErrors };
    }
    return base;
  }
  return { ok: false, code: "INTERNAL", message: "Unexpected error" };
}
