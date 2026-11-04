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
  { value: 'S65', label: 'Series 65, active', sub: 'Alongside daily ops and trading work' },
];

// The note under the proof figures on why GitHub looks quiet. It names the employer, so it lives here.
export const PRIVATE_WORK = {
  note: 'Most of this work lives in Evergreen Wealth’s private company repos, which is why my GitHub looks pretty quiet. The demos below rebuild these tools on synthetic data and are the best way to see what I’ve built.',
  link: 'See the projects',
};

// A bullet is plain text, or [label, text] for a bullet that leads with a bold label, as on the résumé PDF.
export type Bullet = string | [label: string, text: string];
export interface Role { title: string; dates?: string; badge?: string; org?: string; bullets: Bullet[] }
export interface Job { company: string; place: string; dates: string; roles: Role[] }

export const JOBS: Job[] = [
  {
    company: 'Evergreen Wealth',
    place: 'Raleigh, NC',
    dates: 'Oct 2025 – Present',
    roles: [
      {
        title: 'Brokerage Operations Associate & Internal Tools Builder',
        org: 'An RIA custodied at Apex. I do the daily ops work across billing, account transfers and trading, and I’m the main builder of the tools behind them.',
        bullets: [
          ['Fee billing', 'Owned monthly advisory fee billing across Schwab and Apex for roughly $124M in AUM, moving the cycle from the 14th–15th of each month to the first 4 days and eliminating the need for one full-time role. Maintained fee tiers, validated Alphathena average-daily-balance calculations and checked fees against available cash.'],
          ['Account transfers', 'Created the ACAT Tracker, the Operations team’s system of record for 640+ transfers across 37 custodians, and resolved transfer and trade issues directly with Schwab, Apex and advisor teams.'],
          ['Trading support', 'Prepared unrealized gain/loss spreadsheets that helped advisors plan tax-aware trades, and built the Trade Request platform the firm’s 4-person trading team uses daily.'],
          ['Audits and compliance', 'Helped pull and prepare large datasets for the firm’s 2025 and 2026 SEC custody audits, and led delivery of the CCO’s Form ADV AUM reporting dashboard.'],
          ['Automation', 'Built 16 production n8n workflows that automate withdrawal, funding and mutual fund tasks, and a Gemini-powered pipeline that cut per-client ACAT statement analysis from 30–45 minutes to under 60 seconds.'],
          ['Internal tools', 'Built and shipped 5 internal production apps for advisory, trading, client service, operations and compliance as the primary engineer, with 1,600+ PRs merged.'],
          ['Advisor platform', 'Lead the engineering on Always-On-Advice, the firm’s advisor and operations platform, and cut its household load time from ~5s to ~2.1s.'],
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
        badge: 'Double promotion after 19 months',
        bullets: [
          'Led centralized trading and portfolio rebalancing across advisor teams.',
          'Wrote and rolled out the procedures and checklists the trading desk ran on.',
          'Trained and onboarded new centralized trading team members, taught the concepts behind each trading process and reviewed their work.',
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
  'I started on trading desks, building rebalance trades and resolving trade breaks. I still do brokerage ops and trading work every day, and building the tools for it hasn’t replaced that. Everything I build is for a job I’ve done and still do.',
  'I’ve worked day to day in advisor CRMs like Practifi, and I’ve seen how manual a lot of that work still is. Most of what I build replaces spreadsheets, shared inboxes and manual checks with software an ops team uses every day.',
  'I pay attention to the parts of a system that rarely make it into a demo: who is allowed to see what, how a record proves it was never changed, what happens when an upstream feed is late, and how a mistake is caught before a client notices it.',
];

export const SKILLS: [string, string][] = [
  ['Languages', 'TypeScript, Python, SQL'],
  ['Frameworks', 'Next.js, React, Express, FastAPI'],
  ['Data', 'Postgres, Prisma, Redshift, Metabase, Hex'],
  ['Infrastructure', 'Google Cloud, Cloudflare, Terraform, Docker, GitHub Actions'],
  ['Automation & AI', 'n8n, Gemini extraction, MCP servers, Claude Code, Cursor, Codex'],
  ['Wealth platforms', 'Schwab, Apex, Alphathena, Orion OMS, RedBlack, Practifi / Salesforce, Zendesk'],
  ['Ops & trading', 'Centralized trading, rebalancing, ACATs, cost basis, advisory fee billing, Form ADV AUM reporting'],
];
