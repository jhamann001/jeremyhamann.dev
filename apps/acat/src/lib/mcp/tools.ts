import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { type McpPrincipal } from "@/lib/mcp/access-token";
import { type McpScope } from "@/lib/mcp/scopes";
import { redactAcatDetail, redactAcatListItem, summarizeArgs } from "@/lib/mcp/redaction";
import { loadObservedCustodianTimings } from "@/lib/custodian-timing-data";
import { toCustodianResponse } from "@/lib/custodian-serialization";

const MAX_TOOL_LIMIT = 50;

type ToolHandler = {
  name: string;
  description: string;
  requiredScopes: McpScope[];
  inputSchema: Record<string, unknown>;
  run: (args: unknown, principal: McpPrincipal) => Promise<unknown>;
};

const searchAcatsSchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    status: z.string().trim().max(80).optional(),
    custodianName: z.string().trim().max(120).optional(),
    limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).default(20),
  })
  .strict();

const getAcatRecordSchema = z.object({ id: z.string().min(1).max(120) }).strict();

const getCustodianProfileSchema = z
  .object({
    id: z.string().trim().min(1).max(120).optional(),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.id || value.name), {
    message: "Custodian id or name is required",
  });

const listByStatusSchema = z
  .object({
    status: z.string().trim().min(1).max(80),
    limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).default(20),
  })
  .strict();

const emptySchema = z.object({}).strict();

export const MCP_TOOLS: ToolHandler[] = [
  {
    name: "search_acats",
    description: "Search active ACAT records by client, account, control number, custodian, or status.",
    requiredScopes: ["acats:read"],
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        status: { type: "string" },
        custodianName: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: MAX_TOOL_LIMIT },
      },
      additionalProperties: false,
    },
    async run(args) {
      const parsed = searchAcatsSchema.parse(args ?? {});
      const where: Prisma.AcatRecordWhereInput = { deletedAt: null };
      if (parsed.status) where.status = parsed.status as Prisma.EnumAcatStatusFilter;
      if (parsed.custodianName) {
        where.custodianName = { contains: parsed.custodianName, mode: "insensitive" };
      }
      if (parsed.q) {
        where.OR = [
          { clientName: { contains: parsed.q, mode: "insensitive" } },
          { apexAccountId: { contains: parsed.q, mode: "insensitive" } },
          { statementAccountNumber: { contains: parsed.q, mode: "insensitive" } },
          { controlNumber: { contains: parsed.q, mode: "insensitive" } },
          { acatTransferId: { contains: parsed.q, mode: "insensitive" } },
          { custodianName: { contains: parsed.q, mode: "insensitive" } },
        ];
      }
      const records = await prisma.acatRecord.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: parsed.limit,
      });
      return { items: records.map(redactAcatListItem), limit: parsed.limit };
    },
  },
  {
    name: "get_acat_record",
    description: "Get a single ACAT record with redacted account identifiers and related assets.",
    requiredScopes: ["acats:read"],
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async run(args) {
      const parsed = getAcatRecordSchema.parse(args);
      const record = await prisma.acatRecord.findUnique({
        where: { id: parsed.id, deletedAt: null },
        include: { assets: true },
      });
      if (!record) throw new Error("ACAT record not found");
      return redactAcatDetail(record);
    },
  },
  {
    name: "list_acats_by_status",
    description: "List active ACAT records in a specific operational status.",
    requiredScopes: ["acats:read"],
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: MAX_TOOL_LIMIT },
      },
      required: ["status"],
      additionalProperties: false,
    },
    async run(args) {
      const parsed = listByStatusSchema.parse(args);
      const records = await prisma.acatRecord.findMany({
        where: { deletedAt: null, status: parsed.status as Prisma.EnumAcatStatusFilter },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: parsed.limit,
      });
      return { items: records.map(redactAcatListItem), limit: parsed.limit };
    },
  },
  {
    name: "get_reconciliation_summary",
    description: "Summarize ACAT reconciliation status counts and open exceptions.",
    requiredScopes: ["acats:read"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(args) {
      emptySchema.parse(args ?? {});
      const [statusCounts, assetCounts] = await Promise.all([
        prisma.acatRecord.groupBy({
          by: ["status"],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        prisma.asset.groupBy({
          by: ["mapStatus"],
          where: { acatRecord: { deletedAt: null } },
          _count: { _all: true },
        }),
      ]);
      return {
        byStatus: statusCounts.map((row) => ({ status: row.status, count: row._count._all })),
        byAssetMapStatus: assetCounts.map((row) => ({
          status: row.mapStatus,
          count: row._count._all,
        })),
      };
    },
  },
  {
    name: "list_custodians",
    description:
      "List custodians configured in the Transfer Tracker with configured SLA and observed completion timing.",
    requiredScopes: ["custodians:read"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(args) {
      emptySchema.parse(args ?? {});
      const [custodians, timingByCustodian] = await Promise.all([
        prisma.custodian.findMany({
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            acatFeeAmount: true,
            avgProcessingDays: true,
            contactEmail: true,
            contactMethod: true,
            contactDetails: true,
          },
        }),
        loadObservedCustodianTimings(),
      ]);

      return {
        items: custodians.map(({ avgProcessingDays, ...custodian }) => {
          const timing = timingByCustodian.get(custodian.id);
          return {
            ...custodian,
            configuredExpectedProcessingDays: avgProcessingDays,
            observedAvgProcessingBusinessDays:
              timing?.observedAvgProcessingBusinessDays ?? null,
            observedCompletedTransfers: timing?.observedCompletedTransfers ?? 0,
          };
        }),
      };
    },
  },
  {
    name: "get_custodian_profile",
    description:
      "Get one custodian's complete transfer playbook, nested fee rules, configured SLA, and observed completion timing by ID or exact name. Excludes client-identifying history.",
    requiredScopes: ["custodians:read", "fees:read"],
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
      anyOf: [{ required: ["id"] }, { required: ["name"] }],
      additionalProperties: false,
    },
    async run(args) {
      const parsed = getCustodianProfileSchema.parse(args);
      const custodian = await prisma.custodian.findFirst({
        where: parsed.id
          ? { id: parsed.id }
          : { name: { equals: parsed.name, mode: "insensitive" } },
        select: {
          id: true,
          name: true,
          reviewStatus: true,
          transferType: true,
          documentationStatus: true,
          dtcNumber: true,
          receivingAccountNumber: true,
          signature: true,
          letterOfAcceptance: true,
          medallionRequired: true,
          liquidationMethod: true,
          returnMethod: true,
          watchouts: true,
          paperworkOnFile: true,
          transfersToDate: true,
          avgProcessingDays: true,
          contactEmail: true,
          contactMethod: true,
          contactDetails: true,
          fees: {
            orderBy: { feeType: "asc" },
            select: {
              id: true,
              feeType: true,
              accountType: true,
              transferType: true,
              direction: true,
              amount: true,
              amountText: true,
              notes: true,
              documentation: true,
            },
          },
        },
      });
      if (!custodian) throw new Error("Custodian not found");

      const timing = (await loadObservedCustodianTimings(custodian.id)).get(
        custodian.id
      );
      const { avgProcessingDays, ...profile } = toCustodianResponse(custodian);
      return {
        ...profile,
        configuredExpectedProcessingDays: avgProcessingDays,
        observedAvgProcessingBusinessDays:
          timing?.observedAvgProcessingBusinessDays ?? null,
        observedCompletedTransfers: timing?.observedCompletedTransfers ?? 0,
      };
    },
  },
  {
    name: "get_custodian_fee_rules",
    description: "List custodian fee rules used for ACAT fee reconciliation.",
    requiredScopes: ["fees:read"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(args) {
      emptySchema.parse(args ?? {});
      return {
        items: await prisma.custodian.findMany({
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            fees: {
              orderBy: { feeType: "asc" },
              select: {
                id: true,
                feeType: true,
                accountType: true,
                transferType: true,
                direction: true,
                amount: true,
                amountText: true,
                notes: true,
                documentation: true,
              },
            },
          },
        }),
      };
    },
  },
];

export function listMcpTools() {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export async function callMcpTool(
  name: string,
  args: unknown,
  principal: McpPrincipal,
  requestId?: string
) {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
  const start = Date.now();
  const argInfo = summarizeArgs(args);
  try {
    const result = await tool.run(args, principal);
    await auditToolCall({
      principal,
      requestId,
      toolName: name,
      args: argInfo,
      status: "success",
      durationMs: Date.now() - start,
    });
    return result;
  } catch (err) {
    await auditToolCall({
      principal,
      requestId,
      toolName: name,
      args: argInfo,
      status: "error",
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    });
    throw err;
  }
}

export function requiredScopesForTool(name: string): McpScope[] {
  return MCP_TOOLS.find((tool) => tool.name === name)?.requiredScopes ?? [];
}

async function auditToolCall(input: {
  principal: McpPrincipal;
  requestId?: string;
  toolName: string;
  args: { summary: string; hashInput: string };
  status: string;
  durationMs: number;
  error?: string;
}) {
  await prisma.mcpToolAuditLog.create({
    data: {
      userEmail: input.principal.userEmail,
      connectionId: input.principal.connectionId,
      requestId: input.requestId,
      toolName: input.toolName,
      argumentSummary: input.args.summary,
      argumentHash: createHash("sha256").update(input.args.hashInput).digest("hex"),
      status: input.status,
      durationMs: input.durationMs,
      error: input.error?.slice(0, 500),
    },
  });
}
