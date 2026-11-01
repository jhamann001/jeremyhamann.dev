import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Account, AuthUser, EquityStrategy, Holdings, TradeType, Residence } from '@trade-request/shared';
import { getRiskAllocation } from '@trade-request/shared/allocations';
import { runEngine } from '../services/engineUse.js';
import * as warehouse from '../services/warehouse.js';
import { getRequestCounts, listRequests, getRequestForUser, getLastAllocation } from '../services/requestQueries.js';
import { renderRequestPdf, renderCompliancePdf, type RenderedPdf } from '../services/pdfExports.js';
import { recordDb, withRecordDb } from '../db/recordSource.js';
import { OPS_PORTAL_RECORDS_UNAVAILABLE } from '../db/opsPortalRecords.js';
import { AppError } from '../middleware/errorHandler.js';
import { selectMcpRecordSource, type McpRecordContext } from './recordSource.js';
import logger from '../lib/logger.js';

export type ResolveUser = (extra: RequestHandlerExtra<never, never>) => Promise<AuthUser>;

function asJson(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function asError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** Resolve user, run handler, format errors as MCP tool errors so the LLM can see what went wrong. */
async function withUser<T>(
  resolveUser: ResolveUser,
  extra: RequestHandlerExtra<never, never>,
  fn: (user: AuthUser) => Promise<T>,
) {
  let user: AuthUser;
  try {
    user = await resolveUser(extra);
  } catch (err) {
    return asError(err instanceof Error ? err.message : 'Authentication failed');
  }
  let ctx: McpRecordContext;
  try {
    ctx = await selectMcpRecordSource(user);
  } catch (err) {
    return asError(err instanceof AppError ? err.message : OPS_PORTAL_RECORDS_UNAVAILABLE);
  }
  try {
    const result = await withRecordDb(ctx.db, () => fn(ctx.user));
    return asJson(result);
  } catch (err) {
    if (err instanceof AppError) {
      return asError(err.message);
    }
    logger.error({ err, userId: user.id }, 'MCP tool failed');
    return asError(err instanceof Error ? err.message : 'Internal error');
  }
}

/**
 * Like `withUser`, but the handler returns a fully-formed MCP tool result
 * (content array) instead of a plain value to JSON-encode. Used by tools that
 * emit non-JSON content such as embedded PDF resources.
 */
async function withUserRaw<R>(
  resolveUser: ResolveUser,
  extra: RequestHandlerExtra<never, never>,
  fn: (user: AuthUser) => Promise<R>,
): Promise<R | ReturnType<typeof asError>> {
  let user: AuthUser;
  try {
    user = await resolveUser(extra);
  } catch (err) {
    return asError(err instanceof Error ? err.message : 'Authentication failed');
  }
  let ctx: McpRecordContext;
  try {
    ctx = await selectMcpRecordSource(user);
  } catch (err) {
    return asError(err instanceof AppError ? err.message : OPS_PORTAL_RECORDS_UNAVAILABLE);
  }
  try {
    return await withRecordDb(ctx.db, () => fn(ctx.user));
  } catch (err) {
    if (err instanceof AppError) {
      return asError(err.message);
    }
    logger.error({ err, userId: user.id }, 'MCP tool failed');
    return asError(err instanceof Error ? err.message : 'Internal error');
  }
}

/** Format a rendered PDF as an MCP embedded resource plus a human-readable summary line. */
function asPdf(rendered: RenderedPdf, summary: string) {
  return {
    content: [
      { type: 'text' as const, text: summary },
      {
        type: 'resource' as const,
        resource: {
          uri: `pdf://${rendered.filename}`,
          mimeType: 'application/pdf',
          blob: rendered.base64,
        },
      },
    ],
  };
}

export function registerTools(server: McpServer, resolveUser: ResolveUser): void {
  // ─── Request counts ───────────────────────────────────────────────────────
  server.registerTool(
    'get_request_counts',
    {
      title: 'Trade request counts',
      description:
        'Returns counts of trade requests by status across the whole queue. ' +
        'All authenticated users (advisors and traders) see every request.',
      inputSchema: {},
    },
    async (_args, extra) => withUser(resolveUser, extra, (user) => getRequestCounts(user)),
  );

  // ─── List requests ────────────────────────────────────────────────────────
  server.registerTool(
    'list_my_requests',
    {
      title: 'List trade requests',
      description:
        'List trade requests, most recent first. All authenticated users (advisors and traders) ' +
        'see every request. Supports a free-text search and cursor pagination.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Max requests to return (default 25)'),
        before: z.string().optional().describe('Pagination cursor returned as `nextCursor` from a previous call'),
        q: z
          .string()
          .max(200)
          .optional()
          .describe(
            'Optional free-text search across id, client name, trade type, status, and submitter name. ' +
              'The "advisor" field is currently forced to Rachel Moss on every record and is not a useful filter.',
          ),
      },
    },
    async (args, extra) =>
      withUser(resolveUser, extra, (user) =>
        listRequests(user, { limit: args.limit ?? 25, before: args.before, q: args.q }, 'mcp'),
      ),
  );

  // ─── Get one request ──────────────────────────────────────────────────────
  server.registerTool(
    'get_request',
    {
      title: 'Get trade request by ID',
      description: 'Fetch one trade request including its full audit trail. The id looks like `REQ-XXXXXXXX`.',
      inputSchema: {
        id: z.string().min(1).max(50).describe('The trade request id, e.g. REQ-AB12CD34'),
      },
    },
    async (args, extra) => withUser(resolveUser, extra, (user) => getRequestForUser(user, args.id, 'mcp')),
  );

  // ─── Last allocation ──────────────────────────────────────────────────────
  server.registerTool(
    'get_last_allocation',
    {
      title: 'Last approved allocation for a client',
      description:
        'Return the most recent approved/completed Initial Funding or Rebalance allocation for the given client: ' +
        'risk profile, base allocation (cash/fixed/equity), and equity strategies. Returns null if none.',
      inputSchema: {
        clientId: z.string().min(1).max(100).describe('The client id (Warehouse contact id)'),
      },
    },
    async (args, extra) => withUser(resolveUser, extra, (user) => getLastAllocation(user, args.clientId)),
  );

  // ─── Queue digest ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_queue_digest',
    {
      title: 'Queue digest',
      description:
        'Returns counts plus the most recent open trade requests for the current user, suitable for ' +
        '"what is in my queue?" questions. Combines get_request_counts and list_my_requests in one call.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe('Max requests to include in the list (default 25)'),
      },
    },
    async (args, extra) =>
      withUser(resolveUser, extra, async (user) => {
        const [counts, list] = await Promise.all([
          getRequestCounts(user),
          listRequests(user, { limit: args.limit ?? 25 }, 'mcp'),
        ]);
        return { counts, requests: list.data, nextCursor: list.nextCursor };
      }),
  );

  // ─── Engine what-if preview ───────────────────────────────────────────────
  const previewSchema = {
    clientId: z.string().min(1).max(100).describe('The client id whose accounts to run the engine on'),
    tradeType: z
      .enum(['Initial Funding', 'Rebalance', 'Cash Deposit'])
      .describe('Trade type. Only allocation trade types are supported in preview.'),
    tradeAmount: z
      .string()
      .max(100)
      .optional()
      .describe('Cash deposit amount as a string (only required for Cash Deposit)'),
    depositAccountNumber: z
      .string()
      .max(100)
      .optional()
      .describe('Account number receiving the deposit (only required for Cash Deposit)'),
    rebalanceAll: z
      .boolean()
      .optional()
      .describe('Rebalance every account; defaults to true for Rebalance, false otherwise'),
    riskProfile: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe('Risk profile (1-25). If omitted, uses the last approved allocation for this client.'),
    equityStrategies: z
      .array(
        z.object({
          id: z.number(),
          benchmark: z.string().max(255),
          allocation: z.number().min(0).max(100),
          rationale: z.string().max(5000),
        }),
      )
      .max(3)
      .optional()
      .describe('Override equity strategies. If omitted, uses the last approved strategies for this client.'),
    residence: z
      .enum(['NY', 'CA', 'Other'])
      .optional()
      .describe("Residence used for tax-aware modelling; defaults to 'Other'"),
    holdingsOverride: z
      .record(
        z.string(),
        z.object({
          cash: z.number().min(0),
          fixed: z.number().min(0),
          equity: z.number().min(0),
        }),
      )
      .optional()
      .describe(
        'Override per-account holdings keyed by account number. If omitted, uses live holdings from the stock record.',
      ),
  };

  server.registerTool(
    'preview_engine',
    {
      title: 'Preview the asset location engine',
      description:
        'Runs the asset location engine in preview mode (no DB writes) and returns the proposed per-account ' +
        'execution plan. Accepts overrides for risk profile, equity strategies, residence, and holdings; ' +
        'defaults are pulled from the most recent approved allocation for the client.',
      inputSchema: previewSchema,
    },
    async (args, extra) => withUser(resolveUser, extra, async (user) => previewEngine(user, args)),
  );

  // ─── Single trade request as PDF ──────────────────────────────────────────
  server.registerTool(
    'get_request_pdf',
    {
      title: 'Download a trade request as PDF',
      description:
        'Generate the compliance-formatted PDF for ONE trade request — the same document as the in-app ' +
        '"Download PDF" button, including request details, Reg BI allocation rationale, standing account ' +
        'exclusions, and the full audit trail. Returned as a base64 application/pdf resource. ' +
        'The id looks like REQ-XXXXXXXX.',
      inputSchema: {
        id: z.string().min(1).max(50).describe('The trade request id, e.g. REQ-AB12CD34'),
      },
    },
    async (args, extra) =>
      withUserRaw(resolveUser, extra, async (user) => {
        const request = await getRequestForUser(user, args.id, 'mcp');
        const rendered = await renderRequestPdf(request, { name: user.name, email: user.email });
        return asPdf(
          rendered,
          `Generated ${rendered.filename} (${(rendered.bytes / 1024).toFixed(1)} KB) for ${request.id}.`,
        );
      }),
  );

  // ─── Compliance report (multi-request) as PDF ─────────────────────────────
  server.registerTool(
    'get_compliance_report_pdf',
    {
      title: 'Download the compliance export report as PDF',
      description:
        'Generate the multi-request "Compliance Export Report" PDF — the same document as the in-app ' +
        'compliance PDF export — covering the trade request queue with a cover page, summary-by-status, ' +
        'confidentiality notice, and per-request detail. Returned as a base64 application/pdf resource. ' +
        'Optionally filter with `q`; omit it to include the entire queue.',
      inputSchema: {
        q: z
          .string()
          .max(200)
          .optional()
          .describe(
            'Optional free-text filter across id, client name, trade type, status, and submitter (same ' +
              'semantics as list_my_requests). Omit to include every request.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe('Cap the number of most-recent matching requests included (default: all, up to 5000).'),
      },
    },
    async (args, extra) =>
      withUserRaw(resolveUser, extra, async (user) => {
        const { data, truncated } = await listRequests(user, { limit: 5000, q: args.q, fetchAll: true }, 'mcp');
        const requests = args.limit != null ? data.slice(0, args.limit) : data;
        if (requests.length === 0) {
          return asError(
            args.q
              ? `No trade requests match "${args.q}", so there is nothing to export.`
              : 'There are no trade requests to export.',
          );
        }
        const rendered = await renderCompliancePdf(requests, { name: user.name, email: user.email });
        const truncNote = truncated ? ' (queue exceeds 5000 rows; report may be incomplete)' : '';
        return asPdf(
          rendered,
          `Generated ${rendered.filename} (${(rendered.bytes / 1024).toFixed(1)} KB) covering ` +
            `${requests.length} request${requests.length === 1 ? '' : 's'}${truncNote}.`,
        );
      }),
  );
}

interface PreviewArgs {
  clientId: string;
  tradeType: TradeType;
  tradeAmount?: string;
  depositAccountNumber?: string;
  rebalanceAll?: boolean;
  riskProfile?: number;
  equityStrategies?: EquityStrategy[];
  residence?: Residence;
  holdingsOverride?: Record<string, Holdings>;
}

async function previewEngine(user: AuthUser, args: PreviewArgs) {
  // Access check: advisors must own at least one prior request for this client.
  if (user.role === 'advisor') {
    const { rows } = await recordDb().query(
      `SELECT 1 FROM trade_requests
       WHERE (client_id = $1 OR client_ids @> to_jsonb($1::text))
         AND advisor_id = $2
       LIMIT 1`,
      [args.clientId, user.id],
    );
    if (rows.length === 0) {
      throw new AppError(403, 'You do not have access to this client');
    }
  }

  const accounts = await loadAccounts(args.clientId);
  if (accounts.length === 0) {
    throw new AppError(404, `No accounts found for client ${args.clientId}`);
  }

  if (args.holdingsOverride) {
    for (const acct of accounts) {
      const o = args.holdingsOverride[acct.accountNumber];
      if (o) acct.holdings = o;
    }
  }

  // Resolve risk profile and equity strategies, falling back to last approved allocation.
  let riskProfile = args.riskProfile;
  let equityStrategies: EquityStrategy[] = args.equityStrategies ?? [];

  if (riskProfile == null || equityStrategies.length === 0) {
    const last = await getLastAllocation(user, args.clientId);
    if (riskProfile == null) {
      if (!last) {
        throw new AppError(400, 'riskProfile is required when this client has no prior approved allocation');
      }
      riskProfile = last.riskProfile;
    }
    if (equityStrategies.length === 0 && last) {
      equityStrategies = last.equityStrategies;
    }
  }

  const baseAllocation = getRiskAllocation(riskProfile);

  const totalValue = accounts.reduce((sum, a) => sum + a.balance, 0);
  const rebalanceAll = args.rebalanceAll ?? args.tradeType === 'Rebalance';

  const { plans, validation } = await runEngine('mcp', {
    tradeType: args.tradeType,
    tradeAmount: args.tradeAmount ?? '',
    depositAccountNumber: args.depositAccountNumber ?? '',
    rebalanceAll,
    totalValue,
    baseAllocation,
    riskProfile,
    clientName: '',
    accounts,
    equityStrategies,
    residence: args.residence ?? 'Other',
  });

  return {
    inputs: { riskProfile, baseAllocation, equityStrategies, residence: args.residence ?? 'Other', totalValue },
    plan: plans,
    validation,
  };
}

async function loadAccounts(clientId: string): Promise<Account[]> {
  if (warehouse.isConfigured()) {
    const accounts = await warehouse.getClientAccounts(clientId);
    if (accounts.length > 0) return accounts.map((a) => ({ ...a, holdings: { ...a.holdings } }));
  }
  const { rows } = await recordDb().query(
    `SELECT id, client_id, account_number, account_type, balance, holdings
     FROM accounts WHERE client_id = $1`,
    [clientId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    clientId: r.client_id,
    accountNumber: r.account_number,
    accountType: r.account_type,
    balance: parseFloat(r.balance),
    holdings:
      r.holdings && typeof r.holdings === 'object'
        ? (r.holdings as Holdings)
        : { cash: parseFloat(r.balance) || 0, fixed: 0, equity: 0 },
  }));
}
