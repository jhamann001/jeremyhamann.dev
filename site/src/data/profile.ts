// Résumé content for the home page: links, proof figures, experience, credentials, about and skills.
// This is the one file allowed to name the real firms and platforms Jeremy has worked with
// (tools/guard/allow.txt); the demos and their case studies stay in the fictional world.

export const LINKS = {
  email: 'jeremy@jeremyhamann.dev',
  linkedin: 'https://www.linkedin.com/in/hamannjeremy',
  github: 'https://github.com/jhamann001',
  resume: '/Jeremy_Hamann_Resume.pdf',
};

export interface Proof { value: string; unit?: string; label: string; sub: string }

export const PROOF: Proof[] = [
  { value: '1,600+', label: 'PRs merged', sub: 'In about a year, across 5 production apps' },
  { value: '640+', label: 'Account transfers tracked', sub: 'Across 37 custodians in the ACAT Tracker' },
  { value: '~$124M', label: 'AUM billed automatically', sub: 'Billing cycle moved from mid-month to the first 4 days' },
  { value: '<60', unit: 'sec', label: 'Per-client statement review', sub: 'Down from 30–45 minutes' },
  { value: 'S65', label: 'Series 65, active', sub: 'Daily ops and trading work, not just code' },
];

export interface Role { title: string; dates?: string; badge?: string; org?: string; bullets: string[] }
export interface Job { company: string; place: string; dates: string; roles: Role[] }

export const JOBS: Job[] = [
  {
    company: 'Evergreen.ai',
    place: 'Raleigh, NC',
    dates: 'Oct 2025 – Present',
    roles: [
      {
        title: 'Brokerage Operations Associate & Internal Tools Engineer',
        org: 'An RIA custodied at Apex · Daily ops across billing, account transfers and trading, and the main builder of the tools behind them',
        bullets: [
          'Support advisors and the ops team day to day across billing, account transfers and trading, and resolve transfer and trade issues directly with Schwab, Apex, and advisor and ops teams.',
          'Built and shipped 5 production internal apps for advisory, trading, client service, operations and compliance, with 1,600+ merged PRs as the primary engineer.',
          'Created and led the ACAT Tracker, the ops team’s system of record for 640+ account transfers across 37 custodians, with a field-level audit trail and position reconciliation against Apex.',
          'Built a Gemini statement pipeline that cut per-client transfer analysis from 30–45 minutes to under 60 seconds.',
          'Sole engineer of the Trade Request platform used daily by the firm’s 4-person trading team, with asset-location and portfolio drift engines.',
          'Owned monthly advisory fee billing across Schwab and Apex on ~$124M AUM and moved the billing cycle from mid-month to the first 4 days.',
          'Lead engineer on Always-On-Advice, the firm’s advisor and operations platform; cut household load time from ~5s to ~2.1s.',
          'Run 16 production n8n workflows connecting Practifi, Schwab and Apex data, Zendesk and Slack to automate withdrawal, funding and mutual fund tasks and CRM sync.',
        ],
      },
    ],
  },
  {
    company: 'Blue Trust',
    place: 'Alpharetta, GA',
    dates: 'Jan 2024 – Oct 2025',
    roles: [
      {
        title: 'Senior Investment Operations Analyst / Team Lead',
        dates: 'Aug 2025 – Oct 2025',
        badge: 'Double promotion',
        bullets: [
          'Led centralized trading and portfolio rebalancing across advisor teams.',
          'Wrote and rolled out the procedures and checklists the trading desk ran on.',
          'Trained and onboarded new centralized trading team members and reviewed their work.',
          'Led the project to bring capital gains budgets into centralized trading workflows.',
        ],
      },
      {
        title: 'Investment Operations Analyst, Trading',
        dates: 'Jan 2024 – Aug 2025',
        bullets: ['Researched, tracked and resolved complex trade discrepancies to reduce firm risk and improve trade accuracy.'],
      },
    ],
  },
  {
    company: 'CAPTRUST',
    place: 'Raleigh, NC',
    dates: 'May 2023 – Dec 2023',
    roles: [
      {
        title: 'Centralized Trading Intern',
        bullets: [
          'Built portfolio rebalance trades for multimillion-dollar and institutional accounts.',
          'Consolidated duplicate data sources into a centralized database.',
        ],
      },
    ],
  },
];

export const ABOUT: string[] = [
  'I work where operations and engineering meet. I started on trading desks, building rebalance trades and resolving trade breaks. Today I still do brokerage ops and trading work every day, and I build the tools for it alongside that work, not instead of it. So when I build something, it’s for a job I’ve done and still do.',
  'I’ve worked day to day in advisor CRMs like Practifi, and I’ve seen how manual a lot of that work still is. Most of what I build replaces spreadsheets, shared inboxes and manual checks with software an ops team uses every day.',
  'I pay attention to the parts of a system that rarely make it into a demo: who is allowed to see what, how a record proves it was never changed, what happens when an upstream feed is late, and how a mistake is caught before a client notices it.',
];

export const SKILLS: [string, string][] = [
  ['Languages', 'TypeScript, Python, SQL'],
  ['Frameworks', 'Next.js, React, Express, FastAPI'],
  ['Data', 'Postgres, Prisma, Redshift, Metabase, Hex'],
  ['Infrastructure', 'Google Cloud, Cloudflare, Terraform, Docker, GitHub Actions'],
  ['Automation & AI', 'n8n, Gemini extraction, MCP servers, Claude Code, Cursor, Codex'],
  ['Wealth platforms', 'Practifi / Salesforce, Schwab, Apex, Orion, RedBlack, Alphathena, Zendesk'],
  ['Ops & trading', 'Centralized trading, rebalancing, ACATs, cost basis, advisory fee billing, Form ADV AUM reporting'],
];
