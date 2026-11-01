import { Router } from 'express';
import type { Client, Account, AccountType } from '@trade-request/shared';
import * as warehouse from '../services/warehouse.js';
import { sendError } from '../middleware/errorHandler.js';
import pool from '../db/pool.js';
import logger from '../lib/logger.js';
import { DEMO_CLIENTS } from '../fixtures/demo-data.js';

const router = Router();

async function fetchLocalClients(): Promise<Client[]> {
  const { rows: clientRows } = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM clients ORDER BY name',
  );
  if (clientRows.length === 0) return [];

  const { rows: accountRows } = await pool.query<{
    id: string;
    client_id: string;
    account_number: string;
    account_type: AccountType;
    balance: string;
    cash_holding: string;
    fixed_holding: string;
    equity_holding: string;
  }>(
    'SELECT id, client_id, account_number, account_type, balance, cash_holding, fixed_holding, equity_holding FROM accounts ORDER BY account_number',
  );

  const accountsByClient = new Map<string, Account[]>();
  for (const row of accountRows) {
    const account: Account = {
      id: row.id,
      clientId: row.client_id,
      accountNumber: row.account_number,
      accountType: row.account_type,
      balance: Number(row.balance),
      holdings: {
        cash: Number(row.cash_holding),
        fixed: Number(row.fixed_holding),
        equity: Number(row.equity_holding),
      },
    };
    const list = accountsByClient.get(row.client_id) ?? [];
    list.push(account);
    accountsByClient.set(row.client_id, list);
  }

  return clientRows.map((c) => ({
    id: c.id,
    name: c.name,
    accounts: accountsByClient.get(c.id) ?? [],
  }));
}

router.get('/', async (_req, res, next) => {
  try {
    if (_req.isDemo) {
      res.json({ data: DEMO_CLIENTS });
      return;
    }

    if (warehouse.isConfigured()) {
      try {
        const clients = await warehouse.getCachedClients();
        res.json({ data: clients });
        return;
      } catch (err) {
        const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        if (isTimeout) {
          logger.error({ err }, 'Warehouse fetch timed out — returning 502');
        } else {
          logger.error({ err }, 'Warehouse fetch failed — returning 502');
        }
        sendError(res, 502, 'Account data source is temporarily unavailable. Please try again.');
        return;
      }
    }

    logger.info('Warehouse not configured — serving clients from local database');
    const clients = await fetchLocalClients();
    res.json({ data: clients });
  } catch (err) {
    next(err);
  }
});

export default router;
