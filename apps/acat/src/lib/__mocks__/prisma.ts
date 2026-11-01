import { vi } from "vitest";

const mockPrisma = {
  acatDocument: {
    count: vi.fn(),
    create: vi.fn().mockResolvedValue({ id: "DOC-1" }),
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn(),
  },
  acatRecord: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
  },
  asset: {
    count: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    groupBy: vi.fn(),
  },
  custodian: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  custodianFee: {
    count: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  custodianFeeScheduleDocument: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
  },
  auditLog: {
    findMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
  },
  dataQualityReview: {
    count: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  allowedUser: {
    count: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  mcpSettings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  mcpOAuthClient: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  mcpOAuthAuthorizationCode: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  mcpConnection: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  mcpAccessToken: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  mcpRefreshToken: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  mcpToolAuditLog: {
    findMany: vi.fn(),
    create: vi.fn(),
  },
  mcpPersonalToken: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  cedarRidgeClient: { findUnique: vi.fn(), findMany: vi.fn() },
  cedarRidgeAccount: { findMany: vi.fn(), findUnique: vi.fn() },
  cedarRidgeAccountMember: { findFirst: vi.fn(), findMany: vi.fn() },
  cedarRidgeDirectorySync: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  $queryRaw: vi.fn().mockResolvedValue([{ id: "global" }]),
  $executeRaw: vi.fn(),
  $transaction: vi.fn((args: unknown[] | ((tx: unknown) => unknown)) =>
    typeof args === "function" ? args(mockPrisma) : Promise.all(args)
  ),
};

export const prisma = mockPrisma;
