import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Trade Request API',
      version: '1.0.0',
      description: 'API for the Cedar Ridge Wealth Trade Request app',
    },
    servers: [{ url: '/', description: 'Current server' }],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: '__session',
          description: 'Session cookie set after Google OAuth login',
        },
        machineAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Google-minted OIDC ID token; aud = app base URL, email = allowlisted service account (machine-to-machine)',
        },
      },
      schemas: {
        Holdings: {
          type: 'object',
          properties: {
            cash: { type: 'number' },
            fixed: { type: 'number' },
            equity: { type: 'number' },
          },
          required: ['cash', 'fixed', 'equity'],
        },
        BaseAllocation: {
          type: 'object',
          properties: {
            equity: { type: 'number' },
            fixed: { type: 'number' },
            cash: { type: 'number' },
          },
        },
        EsgFilters: {
          type: 'object',
          properties: {
            fossilFuels: { type: 'boolean' },
            tobacco: { type: 'boolean' },
            weapons: { type: 'boolean' },
            alcohol: { type: 'boolean' },
            gambling: { type: 'boolean' },
            other: { type: 'boolean' },
            otherDescription: { type: 'string' },
            none: { type: 'boolean' },
          },
        },
        EquityStrategy: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            benchmark: { type: 'string' },
            allocation: { type: 'number' },
            rationale: { type: 'string' },
          },
        },
        ClientExclusion: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            clientId: { type: 'string', maxLength: 100 },
            ticker: { type: 'string', maxLength: 20 },
            kind: { type: 'string', enum: ['advisor', 'client'] },
            reason: { type: 'string' },
            createdByName: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'clientId', 'ticker', 'kind', 'reason', 'createdByName', 'createdAt'],
        },
        CreateClientExclusionPayload: {
          type: 'object',
          properties: {
            ticker: { type: 'string', minLength: 1, maxLength: 20 },
            kind: { type: 'string', enum: ['advisor', 'client'] },
            reason: { type: 'string', maxLength: 500 },
          },
          required: ['ticker', 'kind'],
        },
        AccountData: {
          type: 'object',
          properties: {
            accountNumber: { type: 'string' },
            accountType: { type: 'string', enum: ['Taxable', 'Joint', 'Traditional IRA', 'Roth IRA'] },
            balance: { type: 'number' },
          },
          required: ['accountNumber', 'accountType', 'balance'],
        },
        AuthUser: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            googleId: { type: 'string', nullable: true },
            email: { type: 'string', format: 'email' },
            name: { type: 'string' },
            picture: { type: 'string', nullable: true },
            role: { type: 'string', enum: ['advisor', 'trader'] },
            slackUserId: { type: 'string', nullable: true },
            themePreference: { type: 'string', enum: ['light', 'dark', 'system'] },
            isActive: { type: 'boolean' },
            lastLogin: { type: 'string', nullable: true },
            createdAt: { type: 'string' },
          },
        },
        TradeRequest: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            clientId: { type: 'string' },
            clientName: { type: 'string' },
            clientIds: { type: 'array', items: { type: 'string' }, description: 'Multi-client household support' },
            clientNames: { type: 'array', items: { type: 'string' }, description: 'Names corresponding to clientIds' },
            advisor: { type: 'string' },
            submittedBy: {
              type: 'string',
              description:
                'Name of the user who actually submitted the request. Differs from advisor when an ops user submits on the advisor of record\u2019s behalf.',
            },
            tradeType: {
              type: 'string',
              enum: ['Initial Funding', 'Rebalance', 'Cash Deposit', 'Raise Cash', 'Liquidate'],
            },
            tradeAmount: { type: 'string' },
            depositAccount: { type: 'string' },
            rebalanceAll: { type: 'boolean' },
            status: {
              type: 'string',
              enum: [
                'Pending Review',
                'Needs Info',
                'Pending Current Asset Liquidation',
                'Approved',
                'Rejected',
                'Completed',
              ],
            },
            date: { type: 'string' },
            updatedAt: { type: 'string' },
            selectedAccounts: { type: 'array', items: { type: 'string' } },
            totalValue: { type: 'number' },
            priority: { type: 'string', enum: ['Urgent', 'Standard', 'Low', ''] },
            advisorNotes: { type: 'string' },
            residence: { type: 'string', enum: ['NY', 'CA', 'Other'] },
            liquidationApproval: { type: 'string', enum: ['Yes', 'No', ''] },
            advisorExclusions: { type: 'string' },
            clientExclusions: { type: 'string' },
            esgFilters: { $ref: '#/components/schemas/EsgFilters' },
            riskProfile: { type: 'number', nullable: true },
            baseAllocation: { $ref: '#/components/schemas/BaseAllocation' },
            equityStrategies: { type: 'array', items: { $ref: '#/components/schemas/EquityStrategy' }, maxItems: 3 },
            raiseCashReason: { type: 'string' },
            liquidityDeadline: { type: 'string', nullable: true },
            liquidateOption: { type: 'string', enum: ['Entire Account', 'Specific Positions', ''] },
            liquidatePositions: { type: 'string' },
            executionPlan: { type: 'array', items: { type: 'object' } },
            accountMetadata: { type: 'array', items: { $ref: '#/components/schemas/AccountData' } },
            auditLog: { type: 'array', items: { type: 'object' } },
          },
        },
        Client: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            accounts: { type: 'array', items: { $ref: '#/components/schemas/Account' } },
          },
        },
        Account: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            clientId: { type: 'string' },
            accountNumber: { type: 'string' },
            accountType: { type: 'string', enum: ['Taxable', 'Joint', 'Traditional IRA', 'Roth IRA'] },
            balance: { type: 'number' },
            holdings: { $ref: '#/components/schemas/Holdings' },
          },
        },
        MachineTradeRequest: {
          type: 'object',
          description:
            'Redacted, machine-facing projection of a trade request (account numbers masked, client-name PII dropped).',
          properties: {
            id: { type: 'string' },
            clientId: { type: 'string', description: 'cedar_ridge_user_id' },
            clientIds: { type: 'array', items: { type: 'string' }, description: 'Household legs (cedar_ridge_user_ids)' },
            status: {
              type: 'string',
              enum: [
                'Pending Review',
                'Needs Info',
                'Pending Current Asset Liquidation',
                'Approved',
                'Rejected',
                'Completed',
              ],
            },
            tradeType: {
              type: 'string',
              enum: ['Initial Funding', 'Rebalance', 'Cash Deposit', 'Raise Cash', 'Liquidate'],
            },
            priority: { type: 'string', enum: ['Urgent', 'Standard', 'Low', ''] },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
            totalValue: { type: 'number' },
            advisor: { type: 'string' },
            householdId: { type: 'integer', nullable: true },
            householdName: { type: 'string', nullable: true },
            selectedAccounts: { type: 'array', items: { type: 'string' }, description: 'Masked account numbers' },
            accounts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  accountId: {
                    type: 'string',
                    nullable: true,
                    description: 'Stable Apex custodian_account_id / ULID; null when unresolved',
                  },
                  accountNumber: { type: 'string', description: 'Masked (last 4 only)' },
                  accountType: { type: 'string', enum: ['Taxable', 'Joint', 'Traditional IRA', 'Roth IRA'] },
                  balance: { type: 'number' },
                },
              },
            },
            liquidateOption: { type: 'string', enum: ['Entire Account', 'Specific Positions', ''] },
            liquidationApproval: { type: 'string', enum: ['Yes', 'No', ''] },
            profile: {
              nullable: true,
              description:
                'Approved-only Client Portrait facts. Null for pending, rejected, and non-allocation requests.',
              allOf: [{ $ref: '#/components/schemas/MachineTradeProfile' }],
            },
          },
        },
        MachineTradeProfile: {
          type: 'object',
          properties: {
            decidedAt: { type: 'string', format: 'date-time' },
            riskScore: { type: 'integer', minimum: 1, maximum: 25, nullable: true },
            instructions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  label: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['key', 'label', 'value'],
              },
            },
          },
          required: ['decidedAt', 'riskScore', 'instructions'],
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            requestId: { type: 'string', description: 'Correlation ID for debugging' },
          },
        },
      },
    },
    security: [{ cookieAuth: [] }],
    paths: {
      '/auth/google': {
        get: {
          tags: ['Auth'],
          summary: 'Initiate Google OAuth login',
          responses: { '302': { description: 'Redirect to Google' } },
        },
      },
      '/auth/google/callback': {
        get: {
          tags: ['Auth'],
          summary: 'Google OAuth callback',
          responses: { '302': { description: 'Redirect to app' } },
        },
      },
      '/auth/me': {
        get: {
          tags: ['Auth'],
          summary: 'Get current authenticated user',
          responses: {
            '200': {
              description: 'Current user',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthUser' } } },
            },
            '401': { description: 'Not authenticated' },
          },
        },
      },
      '/auth/logout': {
        post: {
          tags: ['Auth'],
          summary: 'Logout and destroy session',
          responses: { '200': { description: 'Logged out' } },
        },
      },
      '/api/clients': {
        get: {
          tags: ['Clients'],
          summary: 'List all clients with accounts',
          responses: {
            '200': {
              description: 'Client list',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Client' } } },
                  },
                },
              },
            },
            '401': { description: 'Not authenticated' },
          },
        },
      },
      '/api/clients/{clientId}/exclusions': {
        get: {
          tags: ['Clients'],
          summary: 'List standing exclusions for one client',
          parameters: [{ name: 'clientId', in: 'path', required: true, schema: { type: 'string', maxLength: 100 } }],
          responses: {
            '200': {
              description: 'Exclusion list',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { data: { type: 'array', items: { $ref: '#/components/schemas/ClientExclusion' } } },
                  },
                },
              },
            },
            '401': { description: 'Not authenticated' },
          },
        },
        post: {
          tags: ['Clients'],
          summary: 'Add one standing exclusion for a client',
          parameters: [{ name: 'clientId', in: 'path', required: true, schema: { type: 'string', maxLength: 100 } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateClientExclusionPayload' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Created',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { data: { $ref: '#/components/schemas/ClientExclusion' } },
                  },
                },
              },
            },
            '400': { description: 'Validation error' },
            '401': { description: 'Not authenticated' },
            '409': { description: 'Duplicate (ticker + kind already on this client)' },
          },
        },
      },
      '/api/clients/{clientId}/exclusions/{id}': {
        delete: {
          tags: ['Clients'],
          summary: 'Remove one standing exclusion',
          parameters: [
            { name: 'clientId', in: 'path', required: true, schema: { type: 'string', maxLength: 100 } },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': {
              description: 'Removed',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: {
                        type: 'object',
                        properties: { deleted: { type: 'boolean' } },
                      },
                    },
                  },
                },
              },
            },
            '401': { description: 'Not authenticated' },
            '404': { description: 'Exclusion not found' },
          },
        },
      },
      '/api/clients/exclusions/bulk': {
        post: {
          tags: ['Clients'],
          summary: 'Fetch standing exclusions for many clients at once (used by compliance exports)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    clientIds: {
                      type: 'array',
                      items: { type: 'string', maxLength: 100 },
                      minItems: 1,
                      maxItems: 1000,
                    },
                  },
                  required: ['clientIds'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Map keyed by clientId (empty array for IDs with no exclusions)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: {
                        type: 'object',
                        additionalProperties: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/ClientExclusion' },
                        },
                      },
                    },
                  },
                },
              },
            },
            '400': { description: 'Validation error (0 or >1000 clientIds)' },
            '401': { description: 'Not authenticated' },
          },
        },
      },
      '/api/requests': {
        get: {
          tags: ['Requests'],
          summary: 'List trade requests (paginated)',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', default: 50, maximum: 200 },
              description: 'Page size',
            },
            {
              name: 'before',
              in: 'query',
              schema: { type: 'string' },
              description: 'Cursor (ISO timestamp) for next page',
            },
            {
              name: 'all',
              in: 'query',
              schema: { type: 'string', enum: ['true'] },
              description: 'Fetch all requests (traders only, capped at 5000)',
            },
          ],
          responses: {
            '200': {
              description: 'Paginated requests',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: { type: 'array', items: { $ref: '#/components/schemas/TradeRequest' } },
                      nextCursor: { type: 'string', nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ['Requests'],
          summary: 'Create a new trade request',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['clientId', 'clientName', 'tradeType', 'selectedAccounts', 'priority'],
                  properties: {
                    clientId: { type: 'string' },
                    clientName: { type: 'string' },
                    tradeType: {
                      type: 'string',
                      enum: ['Initial Funding', 'Rebalance', 'Cash Deposit', 'Raise Cash', 'Liquidate'],
                    },
                    tradeAmount: { type: 'string' },
                    depositAccount: { type: 'string' },
                    rebalanceAll: { type: 'boolean' },
                    selectedAccounts: { type: 'array', items: { type: 'string' }, minItems: 1 },
                    priority: { type: 'string', enum: ['Urgent', 'Standard', 'Low'] },
                    advisorNotes: { type: 'string' },
                    residence: { type: 'string', enum: ['NY', 'CA', 'Other'] },
                    liquidationApproval: { type: 'string', enum: ['Yes', 'No', ''] },
                    advisorExclusions: { type: 'string' },
                    clientExclusions: { type: 'string' },
                    esgFilters: { $ref: '#/components/schemas/EsgFilters' },
                    riskProfile: { type: 'integer', minimum: 1, maximum: 25, nullable: true },
                    equityStrategies: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/EquityStrategy' },
                      maxItems: 3,
                    },
                    raiseCashReason: { type: 'string' },
                    liquidityDeadline: { type: 'string', nullable: true },
                    liquidateOption: { type: 'string', enum: ['Entire Account', 'Specific Positions', ''] },
                    liquidatePositions: { type: 'string' },
                    accountsData: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/AccountData' },
                      description: 'Account metadata from Warehouse-backed clients',
                    },
                    manualEntry: { type: 'boolean', description: 'True when accounts are entered manually' },
                    manualAccounts: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/AccountData' },
                      description: 'Manually entered account data',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Created request',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/TradeRequest' } } },
                },
              },
            },
            '400': {
              description: 'Validation error',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
      },
      '/api/requests/{id}/status': {
        put: {
          tags: ['Requests'],
          summary: 'Update request status (traders only)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status'],
                  properties: {
                    status: {
                      type: 'string',
                      enum: [
                        'Pending Review',
                        'Needs Info',
                        'Pending Current Asset Liquidation',
                        'Approved',
                        'Rejected',
                        'Completed',
                      ],
                    },
                    note: { type: 'string' },
                    expectedUpdatedAt: { type: 'string', description: 'Optimistic concurrency check' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Updated request' },
            '404': { description: 'Request not found' },
            '409': { description: 'Conflict (terminal status or stale update)' },
          },
        },
      },
      '/api/requests/{id}/run-engine': {
        post: {
          tags: ['Requests'],
          summary: 'Run asset location engine (traders only)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    holdings: {
                      type: 'object',
                      additionalProperties: { $ref: '#/components/schemas/Holdings' },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Updated request with execution plan' },
            '400': { description: 'Validation error or missing accounts' },
          },
        },
      },
      '/api/requests/last-allocation/{clientId}': {
        get: {
          tags: ['Requests'],
          summary: 'Get last approved allocation for a client',
          parameters: [{ name: 'clientId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Last allocation data or null' },
          },
        },
      },
      '/api/machine/trade-requests': {
        get: {
          tags: ['Machine'],
          summary: 'Machine-to-machine read of a client (or household) trade requests (OIDC-gated)',
          description:
            'Returns a redacted projection of trade requests for one cedar_ridge_user_id or a household union. All statuses, most-recent first. Authenticated by a Google OIDC ID token from an allowlisted service account (not the human session).',
          security: [{ machineAuth: [] }],
          parameters: [
            {
              name: 'cedar_ridge_user_id',
              in: 'query',
              schema: {
                type: 'string',
                pattern: '^user-[0-9a-f-]{36}$',
                example: 'user-ae66b3c8-d257-4a6a-a8fd-d1c3641db27b',
              },
              description:
                'Single client id (= cedar_ridge_user_id, format user-<uuid>). Provide this OR cedar_ridge_user_ids.',
            },
            {
              name: 'cedar_ridge_user_ids',
              in: 'query',
              schema: { type: 'string', example: 'user-<uuid>,user-<uuid>' },
              description:
                'Comma-separated household union of 1-50 cedar_ridge_user_ids (user-<uuid>). Provide this OR cedar_ridge_user_id.',
            },
          ],
          responses: {
            '200': {
              description: 'Redacted trade requests (empty array for unknown/absent client)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: { type: 'array', items: { $ref: '#/components/schemas/MachineTradeRequest' } },
                    },
                  },
                },
              },
            },
            '400': { description: 'Validation error (missing/invalid params or > 50 ids)' },
            '401': { description: 'Missing/invalid token, wrong audience, or wrong issuer' },
            '403': { description: 'Principal not on allowlist or email not verified' },
            '503': { description: 'Machine endpoint not configured (env unset)' },
          },
        },
      },
      '/api/machine/engine-use': {
        get: {
          tags: ['Machine'],
          summary: 'Engine-use report for the cutover controller (OIDC-gated)',
          description:
            'Per-day counts of asset location engine use by caller class (mcp, service) and outcome (ran, refused) for the complete days before today, plus today so far. coveredDays counts only complete days after both the counting start and the day plan generation was observed off; it is 0 while plan generation is on. Counts only, no request data.',
          security: [{ machineAuth: [] }],
          parameters: [
            {
              name: 'days',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 31, default: 7 },
              description: 'Window of complete days before today.',
            },
          ],
          responses: {
            '200': {
              description:
                'Per-day engine-use counts by caller class and outcome, covered days and plan-generation state',
            },
            '400': { description: 'Invalid window (days must be an integer from 1 to 31)' },
            '503': { description: 'Engine-use counts could not be written; report unavailable' },
          },
        },
      },
      '/api/machine/service-mode': {
        get: {
          tags: ['Machine'],
          summary: 'Read the service mode and the standalone sender switches (OIDC-gated)',
          security: [{ machineAuth: [] }],
          responses: {
            '200': {
              description:
                'mode (effective), persistedMode, override, digestSender, driftSender, modeChangedAt, writesSettledAt, updatedAt, updatedBy',
            },
            '401': { description: 'Missing/invalid token, wrong audience, or wrong issuer' },
            '403': { description: 'Principal not on allowlist or email not verified' },
            '503': { description: 'Machine endpoint not configured (env unset)' },
          },
        },
        put: {
          tags: ['Machine'],
          summary: "Change the service mode and/or a sender switch (OPS_PORTAL's cutover controller only)",
          security: [{ machineAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['reason'],
                  additionalProperties: false,
                  properties: {
                    mode: { type: 'string', enum: ['active', 'frozen', 'mcp-only'] },
                    digestSender: { type: 'string', enum: ['on', 'off'] },
                    driftSender: { type: 'string', enum: ['on', 'off'] },
                    reason: { type: 'string', minLength: 1, maxLength: 200 },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'The state after the change (the change is recorded with its time and caller)' },
            '400': { description: 'No field to change, an unknown value or field, or no reason' },
            '401': { description: 'Missing/invalid token, wrong audience, or wrong issuer' },
            '403': { description: 'Caller is not the controller identity' },
            '503': { description: 'Machine endpoint or controller identity not configured' },
          },
        },
      },
      '/api/users': {
        get: {
          tags: ['Users'],
          summary: 'List all users (traders only)',
          responses: {
            '200': {
              description: 'User list',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { data: { type: 'array', items: { $ref: '#/components/schemas/AuthUser' } } },
                  },
                },
              },
            },
            '403': { description: 'Insufficient permissions' },
          },
        },
      },
      '/api/users/invite': {
        post: {
          tags: ['Users'],
          summary: 'Invite a new user (traders only)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'name', 'role'],
                  properties: {
                    email: { type: 'string', format: 'email' },
                    name: { type: 'string' },
                    role: { type: 'string', enum: ['advisor', 'trader'] },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Created user. An invite email is sent if SMTP is configured.' },
            '400': { description: 'Validation error' },
            '409': { description: 'Email already exists' },
          },
        },
      },
      '/api/users/{id}/role': {
        patch: {
          tags: ['Users'],
          summary: 'Update user role (traders only)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { role: { type: 'string', enum: ['advisor', 'trader'] } } },
              },
            },
          },
          responses: {
            '200': { description: 'Updated user' },
            '400': { description: 'Cannot change own role / last trader' },
          },
        },
      },
      '/api/users/{id}/deactivate': {
        patch: {
          tags: ['Users'],
          summary: 'Deactivate a user (traders only)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Deactivated user' },
            '400': { description: 'Cannot deactivate self / last trader' },
          },
        },
      },
      '/api/users/{id}/reactivate': {
        patch: {
          tags: ['Users'],
          summary: 'Reactivate a user (traders only)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Reactivated user' } },
        },
      },
      '/api/users/{id}/slack': {
        patch: {
          tags: ['Users'],
          summary: 'Update Slack user ID (traders only)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { type: 'object', properties: { slackUserId: { type: 'string' } } } },
            },
          },
          responses: { '200': { description: 'Updated user' } },
        },
      },
      '/auth/config': {
        get: {
          tags: ['Auth'],
          summary: 'Get app configuration (allowed domain, session TTL)',
          security: [],
          responses: {
            '200': {
              description: 'App config',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      allowedDomains: { type: 'array', items: { type: 'string' } },
                      sessionTtlMs: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/auth/extend-session': {
        post: {
          tags: ['Auth'],
          summary: 'Touch session to extend expiry',
          responses: {
            '200': { description: 'Session extended' },
            '401': { description: 'Not authenticated' },
          },
        },
      },
      '/auth/preferences': {
        patch: {
          tags: ['Auth'],
          summary: 'Update user preferences (theme)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    themePreference: { type: 'string', enum: ['light', 'dark', 'system'] },
                  },
                  required: ['themePreference'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Updated user',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthUser' } } },
            },
            '400': { description: 'Invalid theme preference' },
          },
        },
      },
      '/api/client-errors': {
        post: {
          tags: ['Health'],
          summary: 'Report a client-side error (rate-limited, requires authentication)',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    stack: { type: 'string' },
                    componentStack: { type: 'string' },
                    url: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '204': { description: 'Error logged' } },
        },
      },
      '/api/health/live': {
        get: {
          tags: ['Health'],
          summary: 'Liveness check (no dependencies)',
          security: [],
          responses: {
            '200': {
              description: 'Alive',
              content: {
                'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } },
              },
            },
          },
        },
      },
      '/api/health': {
        get: {
          tags: ['Health'],
          summary: 'Readiness check (includes DB connectivity)',
          security: [],
          responses: {
            '200': {
              description: 'Healthy',
              content: {
                'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } },
              },
            },
            '503': { description: 'Unhealthy' },
          },
        },
      },
    },
  },
  apis: ['./server/src/routes/*.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
