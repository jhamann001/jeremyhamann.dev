import React, { useState, useMemo, useEffect, useCallback, useRef, createContext, useContext } from 'react';
import { csvRow } from './csv.js';
import {
  Users, AlertTriangle, CheckCircle, Clock, Search,
  Activity, ShieldAlert, Briefcase, FileText, Ban, Loader2, RefreshCw, LogOut,
  Trash2, UserPlus, Undo2, X, ChevronRight, Download, Link2, FileDown, ScanSearch, Cloud,
  Key, Copy, Check, Layers, HelpCircle, Minus, ArrowRight, ArrowLeft, ChevronDown,
  PanelLeftClose, PanelLeftOpen, Inbox, MessageSquare, Sun, Moon
} from 'lucide-react';


const API_BASE = '/api';

// Demo mode (server DEMO_MODE=on) signs in with an HttpOnly session cookie the page can't read. This value
// stands in for the Google token, so every `if (!token)` guard keeps working; it is never sent as a header.
const SESSION_COOKIE = 'session-cookie';

// { demo: boolean } for the whole tree: what the demo captures or switches off.
const DemoContext = createContext({ demo: false });

function authHeaders(token) {
  return token && token !== SESSION_COOKIE ? { 'Authorization': `Bearer ${token}` } : {};
}

// The theme: light or dark, remembered in localStorage "theme" and applied before paint by public/theme.js.
// With nothing saved it follows the system setting, including changes to it while the page is open.
function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return undefined;
    const follow = () => {
      let saved = null;
      try { saved = localStorage.getItem('theme'); } catch { /* storage unavailable */ }
      if (saved === 'light' || saved === 'dark') return;
      document.documentElement.classList.toggle('dark', media.matches);
      setDark(media.matches);
    };
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, []);

  const toggle = useCallback(() => {
    const next = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem('theme', next ? 'dark' : 'light'); } catch { /* storage unavailable */ }
    setDark(next);
  }, []);
  return [dark, toggle];
}

function ThemeToggle({ className = '', style }) {
  const [dark, toggle] = useTheme();
  const label = dark ? 'Switch to the light theme' : 'Switch to the dark theme';
  return (
    <button type="button" onClick={toggle} className={className} style={style} aria-label={label} title={label}>
      {dark ? <Sun className="w-4 h-4" aria-hidden /> : <Moon className="w-4 h-4" aria-hidden />}
    </button>
  );
}

// How the demo protects data, under the sign-in. Ink mixed into the cream rather than --brand-faint, which is too faint
// to read. It links to the case study's security section when the image is built with VITE_PORTFOLIO_URL.
function SecurityNote() {
  const url = import.meta.env.VITE_PORTFOLIO_URL;
  return (
    <p
      className="mt-3 max-w-md mx-auto text-xs leading-relaxed animate-[fadeUp_0.8s_ease-out_0.6s_both]"
      style={{ color: 'color-mix(in srgb, var(--brand-ink) 75%, var(--brand-cream))', fontFamily: "'DM Sans', sans-serif" }}
    >
      <strong className="font-semibold">Security:</strong> Every page is served over HTTPS with HSTS. The demo never
      reads a real statement or sends one to a model, account numbers show only their last four digits, and the sign-in
      cookie is signed with HMAC. The database accepts only encrypted connections and keeps its data encrypted at rest.
      {url && (
        <>
          {' '}
          <a href={new URL('/projects/statement-analyzer#security', url).href} className="whitespace-nowrap underline underline-offset-2">
            How the production app handles it&nbsp;→
          </a>
        </>
      )}
    </p>
  );
}

// The public demo's way back to the portfolio site. The image is built with VITE_PORTFOLIO_URL; anywhere else
// it is unset and nothing renders.
function PortfolioLink({ className = '' }) {
  const url = import.meta.env.VITE_PORTFOLIO_URL;
  if (!url) return null;
  return (
    <a
      href={url}
      aria-label={`Back to ${new URL(url).host}`}
      className={`inline-flex items-center gap-1.5 min-h-11 md:min-h-8 px-3 rounded-full text-[13px] font-medium whitespace-nowrap transition-colors ${className}`}
      style={{ border: '1px solid var(--brand-line)', color: 'var(--brand-muted)', background: 'var(--brand-card)' }}
    >
      <ArrowLeft className="w-3.5 h-3.5" aria-hidden />
      <span className="sm:hidden">Back</span>
      <span className="hidden sm:inline">Back to {new URL(url).host}</span>
    </a>
  );
}

const toNum = (val) => (val != null ? parseFloat(val) || 0 : 0);

const formatCurrency = (val) =>
  val != null
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(toNum(val))
    : '—';

// ---------------------------------------------------------------------------
// Cost basis helpers (display-only — gain/loss + holding period are derived
// client-side from stored basis + acquisition dates; nothing is persisted)
// ---------------------------------------------------------------------------

const hasCostBasis = (asset) =>
  asset && (asset.cost_basis != null || (asset.lots || []).some(l => l.cost_basis != null));

// True/false-ish: does this asset look like a cash line (no basis expected)?
const isCashAsset = (asset) => {
  const sym = (asset.symbol || '').toUpperCase().trim();
  return sym === 'CASH' || /cash|sweep|free credit|credit balance/i.test(asset.description || '');
};

// Long-term if acquired > 1 year before the statement date.
const lotTerm = (acqDate, stmtDate) => {
  if (!acqDate) return null;
  const acq = new Date(acqDate);
  const ref = stmtDate ? new Date(stmtDate) : new Date();
  if (isNaN(acq) || isNaN(ref)) return null;
  const oneYear = new Date(acq); oneYear.setFullYear(oneYear.getFullYear() + 1);
  return ref > oneYear ? 'long' : 'short';
};

const COST_BASIS_BADGE = {
  COMPLETE:       { cls: 'bg-green-100 text-green-800 border-green-200', label: 'Cost basis: complete' },
  PARTIAL:        { cls: 'bg-amber-100 text-amber-800 border-amber-200', label: 'Cost basis: partial' },
  MISSING:        { cls: 'bg-amber-100 text-amber-800 border-amber-200', label: 'Cost basis: missing' },
  NOT_APPLICABLE: { cls: 'bg-slate-100 text-slate-500 border-slate-200', label: 'Cost basis: n/a' },
};

const CostBasisBadge = ({ account }) => {
  const status = account.cost_basis_status;
  if (!status) return null;
  const meta = COST_BASIS_BADGE[status];
  if (!meta) return null;
  const securities = (account.assets || []).filter(a => !isCashAsset(a));
  const missing = securities.filter(a => !hasCostBasis(a)).length;
  let label = meta.label;
  if (status === 'PARTIAL') label = `Cost basis: partial · ${missing} missing`;
  else if (status === 'NOT_APPLICABLE') label = 'Cost basis: n/a · tax-advantaged';
  return (
    <span className={`ml-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full border ${meta.cls}`} title={label}>
      {label}
    </span>
  );
};

const acctTypeLabel = (acc) =>
  acc.account_type === 'Other' && acc.account_type_other
    ? `Other (${acc.account_type_other})`
    : acc.account_type;

const OwnerLine = ({ account, className = '' }) => (
  <p className={`text-sm flex items-center ${className}`}>
    <Users className="w-3.5 h-3.5 mr-1.5 text-slate-400" />
    {account.account_holder
      ? <span className="font-medium text-slate-700">{account.account_holder}</span>
      : <span className="italic text-slate-400">Owner not identified</span>}
  </p>
);

const GranularityPill = ({ asset }) => {
  if (asset.cost_basis_granularity === 'lot') {
    return (
      <span className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 text-[10px] font-semibold rounded-full bg-blue-50 text-blue-700">
        <Layers className="w-2.5 h-2.5" />lot · {(asset.lots || []).length}
      </span>
    );
  }
  if (asset.cost_basis_granularity === 'position') {
    return (
      <span className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 text-[10px] font-semibold rounded-full bg-slate-100 text-slate-500">
        position
      </span>
    );
  }
  return null;
};

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function exportHouseholdCSV(household) {
  const headers = [
    'Client Name','Custodian','Account Type','Account Owner','Account Number',
    'Symbol','Description','Shares','Market Value',
    'Cost Basis','Cost Basis Granularity','Cost Basis Status','Classification',
    'Transfer Status','Transferring','Routing Notes','Has Override',
  ];

  const rows = [csvRow(headers)];
  for (const acc of household.accounts || []) {
    for (const pos of acc.assets || []) {
      rows.push(csvRow([
        household.client_name,
        acc.custodian,
        acc.account_type,
        acc.account_holder,
        acc.account_number,
        pos.symbol,
        pos.description,
        pos.quantity,
        pos.market_value,
        pos.cost_basis,
        pos.cost_basis_granularity,
        acc.cost_basis_status,
        pos.asset_type || pos.type,
        pos.effective_status || pos.transfer_eligible,
        pos.transferring === 'YES' ? 'Yes' : pos.transferring === 'NO' ? 'No' : '',
        pos.effective_notes || pos.transfer_notes,
        pos.override_status ? 'Yes' : 'No',
      ]));
    }
  }

  // Accounts to be Opened at Apex — destination mapping section
  const dests = household.destinations || [];
  if (dests.length) {
    const accByKey = {};
    for (const acc of household.accounts || []) {
      accByKey[`${acc.custodian || ''}|${acc.account_number || ''}`] = acc;
    }
    const stmtStatus = (acc) => acc && acc.is_stale
      ? `NEW STATEMENT NEEDED${acc.statement_age_days != null ? ` (${acc.statement_age_days}d old)` : ''}`
      : 'Current';
    rows.push('');
    rows.push('Accounts to be Opened at Apex');
    rows.push(csvRow([
      'Transferring In - Account #', 'Transferring In - Account Type', 'Transferring In - Owner',
      'Transfers To - Owner', 'Transfers To - Account Type', 'Transfers To - Apex #',
      'Needs to be Opened at Apex', 'Statement Status',
    ]));
    for (const d of dests) {
      const apex = d.existing_apex_number || (d.suggestion || {}).suggested_apex_number || '';
      const needsOpen = d.needs_to_be_opened ? 'Yes' : 'No';
      const sources = d.sources || [];
      if (!sources.length) {
        rows.push(csvRow(['', '', '', d.owner, d.target_account_type, apex, needsOpen, '']));
        continue;
      }
      for (const s of sources) {
        const acc = accByKey[`${s.custodian || ''}|${s.account_number || ''}`];
        rows.push(csvRow([
          s.account_number || (acc ? acc.account_number : ''),
          acc ? acc.account_type : '',
          acc ? acc.account_holder : '',
          d.owner,
          d.target_account_type,
          apex,
          needsOpen,
          stmtStatus(acc),
        ]));
      }
    }
  }

  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const name = `${(household.client_name || 'export').replace(/\s+/g, '_')}_positions_${new Date().toISOString().slice(0, 10)}.csv`;
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// PDF export (server-side generation)
// ---------------------------------------------------------------------------

async function exportHouseholdPDF(householdId, clientName, token) {
  const resp = await fetch(`${API_BASE}/households/${householdId}/pdf`, {
    headers: authHeaders(token),
  });
  if (!resp.ok) throw new Error(`PDF export failed (${resp.status})`);
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const name = `${(clientName || 'export').replace(/\s+/g, '_')}_report_${new Date().toISOString().slice(0, 10)}.pdf`;
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportAllHouseholdsPDF(token) {
  const resp = await fetch(`${API_BASE}/households/export/pdf`, {
    headers: authHeaders(token),
  });
  if (!resp.ok) throw new Error(`PDF export failed (${resp.status})`);
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const name = `all_clients_report_${new Date().toISOString().slice(0, 10)}.pdf`;
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function saveHouseholdToDrive(householdId, token) {
  const resp = await fetch(`${API_BASE}/households/${householdId}/save-to-drive`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Save to Drive failed (${resp.status})${text ? `: ${text}` : ''}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function authFetch(url, token, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      ...authHeaders(token),
      'Content-Type': 'application/json',
    },
  });
}

function getTokenExpiry(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Schedule status indicator (live / asleep)
// ---------------------------------------------------------------------------

function ScheduleStatusBadge({ token }) {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const fetchStatus = () => {
      authFetch(`${API_BASE}/schedule-status`, token)
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (!cancelled && data) setStatus(data); })
        .catch(() => {});
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [token]);

  if (!status) return null;

  const active = status.active;

  return (
    <div
      className="flex items-center space-x-2 px-2.5 py-1.5 rounded-lg text-[11px] font-medium"
      style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}
      title={active
        ? `Scans run every ${status.scan_interval_minutes} min during ${status.business_days} ${status.business_hours}`
        : `Scans paused outside business hours (${status.business_days} ${status.business_hours})`}
    >
      <span className="relative flex h-2 w-2">
        {active && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${active ? 'bg-emerald-400' : 'bg-white/25'}`} />
      </span>
      <span style={{ color: active ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.35)' }}>
        {active ? `Live · every ${status.scan_interval_minutes} min` : `Asleep · resumes ${status.business_days} ${status.business_hours.split(' – ')[0]}`}
      </span>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Status badge components
// ---------------------------------------------------------------------------

const StatusBadge = ({ status }) => {
  const styles = {
    ACAT: 'bg-green-100 text-green-800 border-green-200',
    LIQUIDATE: 'bg-orange-100 text-orange-800 border-orange-200',
    UNSUPPORTED: 'bg-slate-800 text-white border-slate-900',
    REVIEW: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    'ACH/WIRE': 'bg-blue-100 text-blue-800 border-blue-200',
  };

  const icon = {
    ACAT: <CheckCircle className="w-3 h-3 mr-1" />,
    LIQUIDATE: <AlertTriangle className="w-3 h-3 mr-1" />,
    UNSUPPORTED: <Ban className="w-3 h-3 mr-1 text-red-400" />,
    REVIEW: <Clock className="w-3 h-3 mr-1" />,
    'ACH/WIRE': <Activity className="w-3 h-3 mr-1" />,
  };

  return (
    <span className={`px-2.5 py-1 inline-flex items-center text-xs font-semibold rounded-full border shadow-sm ${styles[status] || 'bg-gray-100 text-gray-800'}`}>
      {icon[status]}
      {status}
    </span>
  );
};

const ACCOUNT_TYPE_OPTIONS = [
  'Individual', 'Joint', 'Trust', 'Custodial',
  'IRA', 'Roth IRA', 'SEP IRA', 'SIMPLE IRA',
  'Inherited IRA', 'Inherited Roth IRA',
  '401k', '403b', '457b', 'TSP',
  'Profit-Sharing Plan', 'Money Purchase Plan', 'Defined Benefit Plan',
  '529',
  'Savings', 'Checking', 'CMA',
  'Annuity',
  'Employee Stock Plan',
  'Other',
];

const InteractiveAccountTypeBadge = ({ currentType, currentOther, onChange, isUpdating }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [otherMode, setOtherMode] = useState(false);
  const [otherDraft, setOtherDraft] = useState('');
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const [menuStyle, setMenuStyle] = useState({});

  useEffect(() => {
    if (!isOpen || !btnRef.current || !menuRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const menuH = menuRef.current.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < menuH + 8 && rect.top > spaceBelow;
    const left = Math.min(rect.left, window.innerWidth - 240);
    setMenuStyle(openUp
      ? { position: 'fixed', left, bottom: window.innerHeight - rect.top + 4, top: 'auto' }
      : { position: 'fixed', left, top: rect.bottom + 4, bottom: 'auto' }
    );
  }, [isOpen, otherMode]);

  const close = () => { setIsOpen(false); setOtherMode(false); };

  if (isUpdating) {
    return (
      <span className="inline-flex items-center text-base font-bold text-slate-500">
        <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
        Reclassifying…
      </span>
    );
  }

  const label = (currentType === 'Other' && currentOther)
    ? <>Other <span className="text-slate-400 font-normal">· {currentOther}</span></>
    : (currentType || 'Unknown');

  const submitOther = () => {
    onChange('Other', otherDraft.trim() || null);
    close();
  };

  return (
    <span className="inline-block relative">
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); otherMode ? close() : setIsOpen(!isOpen); }}
        className="inline-flex items-center text-base font-bold text-slate-900 hover:text-blue-600 hover:underline decoration-dotted underline-offset-4 focus:outline-none transition-colors"
        title="Click to change account classification (re-runs the rule engine)"
      >
        {label}
        <ChevronRight className={`w-3.5 h-3.5 ml-1 text-slate-400 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); close(); }} />
          <div
            ref={menuRef}
            style={menuStyle}
            onClick={(e) => e.stopPropagation()}
            className="bg-white border border-slate-200 shadow-xl rounded-md z-20 w-64 py-1 overflow-hidden max-h-96 overflow-y-auto"
          >
            <div className="px-3 py-1.5 bg-slate-50 border-b border-slate-100 text-[10px] font-bold text-slate-500 uppercase tracking-wider sticky top-0">
              Override Account Type
            </div>
            {otherMode ? (
              <div className="p-3">
                <label className="block text-[11px] font-semibold text-slate-500 mb-1.5">Describe the account type</label>
                <input
                  autoFocus
                  type="text"
                  value={otherDraft}
                  onChange={(e) => setOtherDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitOther(); if (e.key === 'Escape') close(); }}
                  placeholder="e.g. Donor-Advised Fund"
                  className="w-full px-2.5 py-1.5 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400"
                />
                <p className="mt-1.5 text-[10px] text-slate-400 leading-snug">Saved as a label. Routing treats it as “Other” (per-asset rules apply).</p>
                <div className="mt-2.5 flex items-center justify-end gap-2">
                  <button onClick={(e) => { e.stopPropagation(); setOtherMode(false); }} className="px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-slate-700">Back</button>
                  <button onClick={(e) => { e.stopPropagation(); submitOther(); }} className="px-3 py-1 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md">Save</button>
                </div>
              </div>
            ) : ACCOUNT_TYPE_OPTIONS.map(t => (
              <button
                key={t}
                className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 transition-colors ${t === currentType ? 'font-semibold text-blue-700 bg-blue-50' : 'text-slate-700'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (t === 'Other') { setOtherDraft(currentOther || ''); setOtherMode(true); return; }
                  onChange(t, null);
                  close();
                }}
              >
                {t}{t === 'Other' ? '…' : ''}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
};

const InteractiveStatusBadge = ({ currentStatus, onChange, isUpdating }) => {
  const [isOpen, setIsOpen] = useState(false);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const [menuStyle, setMenuStyle] = useState({});
  const statuses = ['ACAT', 'LIQUIDATE', 'UNSUPPORTED', 'REVIEW', 'ACH/WIRE'];

  useEffect(() => {
    if (!isOpen || !btnRef.current || !menuRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const menuH = menuRef.current.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < menuH + 8 && rect.top > spaceBelow;
    const left = Math.min(rect.left, window.innerWidth - 160);
    setMenuStyle(openUp
      ? { position: 'fixed', left, bottom: window.innerHeight - rect.top + 4, top: 'auto' }
      : { position: 'fixed', left, top: rect.bottom + 4, bottom: 'auto' }
    );
  }, [isOpen]);

  if (isUpdating) {
    return (
      <span className="px-2.5 py-1 inline-flex items-center text-xs font-semibold rounded-full border shadow-sm bg-slate-100 text-slate-500 border-slate-200">
        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
        Updating…
      </span>
    );
  }

  return (
    <div className="relative inline-block">
      <button
        ref={btnRef}
        onClick={() => setIsOpen(!isOpen)}
        className="focus:outline-none hover:opacity-80 transition-opacity"
        title="Click to override engine status"
      >
        <StatusBadge status={currentStatus} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div ref={menuRef} style={menuStyle} className="bg-white border border-slate-200 shadow-xl rounded-md z-20 w-36 py-1 overflow-hidden">
            <div className="px-3 py-1.5 bg-slate-50 border-b border-slate-100 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
              Override Status
            </div>
            {statuses.map(s => (
              <button
                key={s}
                className="block w-full text-left px-3 py-2 hover:bg-slate-50 transition-colors"
                onClick={() => { onChange(s); setIsOpen(false); }}
              >
                <StatusBadge status={s} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// Ops "Transferring?" flag — a manual Yes/No decision, independent of the
// rule-engine status. Unset shows a dashed "Set…" prompt.
const TransferringBadge = ({ value }) => {
  if (value === 'YES')
    return <span className="px-2.5 py-1 inline-flex items-center text-xs font-semibold rounded-full border bg-green-100 text-green-800 border-green-200">Yes</span>;
  if (value === 'NO')
    return <span className="px-2.5 py-1 inline-flex items-center text-xs font-semibold rounded-full border bg-rose-100 text-rose-700 border-rose-200">No</span>;
  return <span className="px-2.5 py-1 inline-flex items-center text-xs font-semibold rounded-full border border-dashed bg-slate-50 text-slate-400 border-slate-300">Set…</span>;
};

const InteractiveTransferringBadge = ({ value, onChange, isUpdating }) => {
  const [isOpen, setIsOpen] = useState(false);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const [menuStyle, setMenuStyle] = useState({});
  const options = [{ label: 'Yes', val: 'YES' }, { label: 'No', val: 'NO' }, { label: 'Clear', val: null }];

  useEffect(() => {
    if (!isOpen || !btnRef.current || !menuRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const menuH = menuRef.current.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < menuH + 8 && rect.top > spaceBelow;
    const left = Math.min(rect.left, window.innerWidth - 160);
    setMenuStyle(openUp
      ? { position: 'fixed', left, bottom: window.innerHeight - rect.top + 4, top: 'auto' }
      : { position: 'fixed', left, top: rect.bottom + 4, bottom: 'auto' }
    );
  }, [isOpen]);

  if (isUpdating) {
    return (
      <span className="px-2.5 py-1 inline-flex items-center text-xs font-semibold rounded-full border shadow-sm bg-slate-100 text-slate-500 border-slate-200">
        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
        Saving…
      </span>
    );
  }

  return (
    <div className="relative inline-block">
      <button
        ref={btnRef}
        onClick={() => setIsOpen(!isOpen)}
        className="focus:outline-none hover:opacity-80 transition-opacity"
        title="Set whether this position is transferring"
      >
        <TransferringBadge value={value} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div ref={menuRef} style={menuStyle} className="bg-white border border-slate-200 shadow-xl rounded-md z-20 w-36 py-1 overflow-hidden">
            <div className="px-3 py-1.5 bg-slate-50 border-b border-slate-100 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
              Transferring?
            </div>
            {options.map(o => (
              <button
                key={o.label}
                className="block w-full text-left px-3 py-2 hover:bg-slate-50 transition-colors"
                onClick={() => { onChange(o.val); setIsOpen(false); }}
              >
                {o.val === null
                  ? <span className="text-xs text-slate-500 italic">Clear</span>
                  : <TransferringBadge value={o.val} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Login screen
// ---------------------------------------------------------------------------

const CedarRidgeLogo = ({ className = '', size = 'text-xl', color = 'text-[var(--brand-ink)]' }) => (
  <span className={`inline-flex items-start ${className}`} style={{ fontFamily: "'DM Sans', sans-serif", letterSpacing: '-0.01em' }}>
    <span className={`${size} font-normal ${color}`}>cedarRidge</span>
  </span>
);

// The `?signin_error=` codes POST /auth/persona can send back, as fixed copy. The raw parameter is never shown.
const SIGNIN_ERRORS = {
  persona: 'That persona could not be signed in. Pick one of the two below.',
  config: "Sign-in isn't available right now. Try again in a minute.",
};

const PERSONA_ROLE_LINES = {
  ops: 'Operations view: overrides, deletes, account types, users and the Outbox',
  advisor: 'Client Service view: read-only, bucketed for the client conversation',
};

// Where a persona returns after signing in: a run's deep link survives, anything else is the dashboard.
function signInReturnPath() {
  return parseRunIdFromUrl() ? window.location.pathname : '/';
}

// Demo sign-in: one plain form post per persona. The server sets the session cookie and answers 303.
function PersonaPicker({ personas }) {
  const next = signInReturnPath();
  return (
    <div className="flex flex-col gap-3 max-w-sm mx-auto text-left">
      {personas.map(p => (
        <form key={p.key} method="post" action="/auth/persona">
          <input type="hidden" name="persona" value={p.key} />
          <input type="hidden" name="next" value={next} />
          <button
            type="submit"
            className="w-full min-h-11 flex items-center justify-between gap-4 px-5 py-3.5 rounded-xl text-left transition-[filter] hover:brightness-105 dark:hover:brightness-125"
            style={{ background: 'var(--brand-card)', border: '1px solid var(--brand-line)', fontFamily: "'DM Sans', sans-serif" }}
          >
            <span className="min-w-0">
              <span className="block text-sm font-semibold" style={{ color: 'var(--brand-ink)' }}>{p.name}</span>
              <span className="block text-xs mt-0.5" style={{ color: 'var(--brand-muted)' }}>{p.title} · {PERSONA_ROLE_LINES[p.role]}</span>
            </span>
            <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--brand-muted)' }} aria-hidden />
          </button>
        </form>
      ))}
    </div>
  );
}

function LoginScreen({ gsiReady, personas = null, signInError = null }) {
  const btnRef = useRef(null);

  useEffect(() => {
    if (personas || !gsiReady || !window.google?.accounts?.id || !btnRef.current) return;

    window.google.accounts.id.renderButton(btnRef.current, {
      theme: 'outline',
      size: 'large',
      text: 'signin_with',
      shape: 'pill',
      width: 300,
    });
    window.google.accounts.id.prompt();
  }, [gsiReady, personas]);

  const features = [
    { num: '01', title: 'AI-Powered Extraction', desc: 'Gemini reads every position from brokerage statements in minutes' },
    { num: '02', title: '15-Layer Classification', desc: 'Deterministic rule engine for ACAT, liquidation, and transfer routing' },
    { num: '03', title: 'Real-Time Readiness', desc: 'Instant visibility into transfer eligibility across all accounts' },
  ];

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--brand-cream)' }}>

      {/* Top bar */}
      <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between gap-4 px-4 sm:px-8 lg:px-12 py-5" style={{ background: 'var(--brand-glass)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' }}>
        <CedarRidgeLogo size="text-xl" />
        <div className="flex items-center gap-2">
          <ThemeToggle
            className="inline-flex items-center justify-center min-h-11 min-w-11 md:min-h-8 md:min-w-8 rounded-full transition-colors"
            style={{ border: '1px solid var(--brand-line)', color: 'var(--brand-muted)', background: 'var(--brand-card)' }}
          />
          {personas && <PortfolioLink />}
        </div>
      </div>

      {/* Hero */}
      <div className="flex-1 flex items-center justify-center px-8 pt-28 pb-16 lg:pt-24 lg:pb-20">
        <div className="w-full max-w-xl text-center">
          <p className="text-[11px] font-semibold tracking-[0.15em] uppercase mb-6 animate-[fadeUp_0.8s_ease-out_both]" style={{ color: 'var(--brand-muted)', fontFamily: "'DM Sans', sans-serif" }}>
            Asset Intelligence
          </p>
          <h1
            className="text-4xl lg:text-5xl xl:text-[56px] leading-[1.15] mb-5 animate-[fadeUp_0.8s_ease-out_0.15s_both]"
            style={{ fontFamily: "'Playfair Display', serif", fontWeight: 400, color: 'var(--brand-ink)' }}
          >
            Intelligent<br />
            <em style={{ color: 'var(--brand-muted)' }}>Asset Transfer</em><br />
            Routing
          </h1>
          <p className="text-base leading-relaxed mb-12 max-w-md mx-auto animate-[fadeUp_0.8s_ease-out_0.3s_both]" style={{ color: 'var(--brand-muted)', fontFamily: "'DM Sans', sans-serif" }}>
            Automated ACAT analysis powered by AI.<br />
            From brokerage statements to transfer-ready plans in minutes.
          </p>

          {personas ? (
            <div className="animate-[fadeUp_0.8s_ease-out_0.45s_both]">
              {signInError && (
                <p role="alert" className="max-w-sm mx-auto mb-4 px-4 py-3 rounded-lg text-sm text-left bg-red-50 border border-red-200 text-red-700">
                  {signInError}
                </p>
              )}
              <p className="text-sm mb-4" style={{ color: 'var(--brand-muted)', fontFamily: "'DM Sans', sans-serif" }}>
                Sign in as one of two staff at an invented firm. Each sees and does only what their role allows.
              </p>
              <PersonaPicker personas={personas} />
            </div>
          ) : (
            <div className="animate-[fadeUp_0.8s_ease-out_0.45s_both]">
              <div className="flex justify-center">
                <div ref={btnRef} />
              </div>
              {!gsiReady && (
                <div className="flex justify-center mt-4">
                  <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--brand-faint)' }} />
                </div>
              )}
            </div>
          )}

          <div className="mt-10 flex items-center justify-center space-x-2 animate-[fadeUp_0.8s_ease-out_0.6s_both]" style={{ color: 'var(--brand-muted)', fontFamily: "'DM Sans', sans-serif" }}>
            <ShieldAlert className="w-3.5 h-3.5 opacity-50 flex-shrink-0" />
            <span className="text-xs">
              {personas
                ? 'Every person, account and statement here is invented. Nothing you do leaves the demo, and it resets daily at 07:00 UTC.'
                : 'Protected by Google Authentication'}
            </span>
          </div>
          {personas && <SecurityNote />}
        </div>
      </div>

      {/* Features section. Its small text is 70% white (APCA Lc 62 on #0A0A0A); the step numbers stay faint, as decoration. */}
      <div className="px-8 lg:px-12 py-20 lg:py-24" style={{ background: '#0A0A0A' }}>
        <div className="max-w-[960px] mx-auto grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-20 items-center">
          <div>
            <h2
              className="text-3xl lg:text-4xl leading-[1.2] mb-4"
              style={{ fontFamily: "'Playfair Display', serif", fontWeight: 400, color: '#fff' }}
            >
              Transfer analysis<br />
              <em style={{ color: 'rgba(255,255,255,0.6)' }}>in minutes.</em>
            </h2>
          </div>
          <div className="flex flex-col gap-10">
            {features.map((f) => (
              <div key={f.num} className="flex gap-5">
                <span className="text-xs font-semibold tracking-wide flex-shrink-0 pt-1" style={{ color: 'rgba(255,255,255,0.2)' }}>{f.num}</span>
                <div>
                  <h3 className="text-lg mb-1.5" style={{ fontFamily: "'Playfair Display', serif", fontWeight: 400, color: '#fff' }}>{f.title}</h3>
                  <p className="text-sm leading-relaxed" style={{ color: 'rgba(255,255,255,0.7)' }}>{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-8 lg:px-12 py-8" style={{ background: '#0A0A0A', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <CedarRidgeLogo size="text-base" color="text-white" />
        <span className="text-xs" style={{ color: 'rgba(255,255,255,0.7)', fontFamily: "'DM Sans', sans-serif" }}>Cedar Ridge Wealth</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main application
// ---------------------------------------------------------------------------

const formatRelativeDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

// ---------------------------------------------------------------------------
// Deep link helpers
// ---------------------------------------------------------------------------

function parseRunIdFromUrl() {
  const match = window.location.pathname.match(/^\/run\/([0-9a-f-]{36})$/i);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// User management panel (ops only)
// ---------------------------------------------------------------------------

function MCPTokensSection({ token, users }) {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);

  const [newUserEmail, setNewUserEmail] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  // Holds the freshly-minted token until the user dismisses the banner.
  // The raw value is only ever shown here; once dismissed it's gone for good.
  const [justCreated, setJustCreated] = useState(null);
  const [copied, setCopied] = useState(false);

  const fetchTokens = useCallback(() => {
    setFetchError(null);
    authFetch(`${API_BASE}/mcp-tokens`, token)
      .then(r => {
        if (!r.ok) throw new Error(`Failed to load tokens (${r.status})`);
        return r.json();
      })
      .then(data => { setTokens(data); setLoading(false); })
      .catch(err => { setFetchError(err.message); setLoading(false); });
  }, [token]);

  useEffect(() => { fetchTokens(); }, [fetchTokens]);

  // Default the user dropdown to the first available user once users load.
  useEffect(() => {
    if (!newUserEmail && users && users.length > 0) {
      setNewUserEmail(users[0].email);
    }
  }, [users, newUserEmail]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreateError(null);
    if (!newUserEmail) return;
    setCreating(true);
    try {
      const r = await authFetch(`${API_BASE}/mcp-tokens`, token, {
        method: 'POST',
        body: JSON.stringify({
          user_email: newUserEmail,
          description: newDescription.trim() || null,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || `Failed (${r.status})`);
      setJustCreated(data);
      setCopied(false);
      setNewDescription('');
      fetchTokens();
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!justCreated) return;
    try {
      await navigator.clipboard.writeText(justCreated.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can be blocked; fall back to selecting the field.
      setCopied(false);
    }
  };

  const handleRevoke = async (tokenId, last4, email) => {
    if (!confirm(`Revoke token ending in ${last4} for ${email}? This cannot be undone.`)) return;
    try {
      const r = await authFetch(`${API_BASE}/mcp-tokens/${tokenId}`, token, {
        method: 'DELETE',
      });
      if (!r.ok) {
        const data = await r.json();
        throw new Error(data.detail || `Failed (${r.status})`);
      }
      fetchTokens();
    } catch (err) {
      setCreateError(err.message);
    }
  };

  const computeStatus = (t) => {
    if (t.revoked_at) return { label: 'Revoked', cls: 'bg-slate-100 text-slate-500' };
    if (t.expires_at && new Date(t.expires_at) < new Date()) return { label: 'Expired', cls: 'bg-slate-100 text-slate-500' };
    return { label: 'Active', cls: 'bg-green-100 text-green-700' };
  };

  return (
    <div className="mt-12">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-bold text-slate-900 flex items-center">
            <Key className="w-4 h-4 mr-2" /> MCP Tokens
          </h3>
          <p className="text-slate-500 text-xs mt-1">
            Long-lived bearer tokens for Claude Code / Claude.ai. Default lifetime 90 days. Revoke any time.
          </p>
        </div>
      </div>

      {/* Just-minted token banner */}
      {justCreated && (
        <div className="mb-6 bg-amber-50 border border-amber-200 rounded-xl p-5 shadow-sm">
          <div className="flex items-start justify-between mb-3">
            <div>
              <div className="text-sm font-semibold text-amber-900">Token created — copy it now</div>
              <div className="text-xs text-amber-700 mt-0.5">
                This is the only time you'll see this value. Save it somewhere safe before dismissing this banner.
              </div>
            </div>
            <button
              onClick={() => setJustCreated(null)}
              className="text-amber-700 hover:text-amber-900 p-1"
              title="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center space-x-2">
            <input
              type="text"
              readOnly
              value={justCreated.token}
              onFocus={e => e.target.select()}
              className="flex-1 font-mono text-xs px-3 py-2 bg-white border border-amber-200 rounded-md"
            />
            <button
              onClick={handleCopy}
              className="px-3 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium rounded-md flex items-center space-x-1.5 transition-colors"
            >
              {copied ? <><Check className="w-3.5 h-3.5" /><span>Copied</span></> : <><Copy className="w-3.5 h-3.5" /><span>Copy</span></>}
            </button>
          </div>
          <div className="text-xs text-amber-700 mt-3">
            Use it from Claude Code: <code className="bg-white px-1.5 py-0.5 rounded font-mono">claude mcp add --scope user --transport http acat &lt;url&gt;/mcp/ --header "Authorization: Bearer &lt;paste&gt;"</code>
          </div>
        </div>
      )}

      {/* Create form */}
      <form onSubmit={handleCreate} className="mb-6 bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
        <h4 className="text-sm font-bold text-slate-700 uppercase tracking-wider mb-4">Issue Token</h4>
        <div className="flex items-end space-x-3">
          <div className="w-64">
            <label className="block text-xs font-medium text-slate-500 mb-1.5">User</label>
            <select
              value={newUserEmail}
              onChange={e => setNewUserEmail(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {(users || []).map(u => (
                <option key={u.id} value={u.email}>{u.email} ({u.role})</option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Description (optional)</label>
            <input
              type="text"
              value={newDescription}
              onChange={e => setNewDescription(e.target.value)}
              placeholder="e.g. My laptop"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            type="submit"
            disabled={creating || !newUserEmail}
            className="px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {creating ? 'Issuing...' : 'Issue'}
          </button>
        </div>
        {createError && (
          <div className="mt-3 text-sm text-red-600">{createError}</div>
        )}
      </form>

      {/* Token list — overflow-x-auto so narrow viewports get a horizontal scrollbar */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-x-auto">
        <table className="w-full min-w-[720px]">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="text-left px-3 py-2.5 text-xs font-bold text-slate-500 uppercase tracking-wider">User</th>
              <th className="text-left px-3 py-2.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Description</th>
              <th className="text-left px-3 py-2.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Token</th>
              <th className="text-left px-3 py-2.5 text-xs font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">Expires</th>
              <th className="text-left px-3 py-2.5 text-xs font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">Last Used</th>
              <th className="text-left px-3 py-2.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Status</th>
              <th className="text-right px-3 py-2.5 text-xs font-bold text-slate-500 uppercase tracking-wider w-12"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={7} className="text-center py-8"><Loader2 className="w-5 h-5 animate-spin text-slate-400 mx-auto" /></td></tr>
            ) : fetchError ? (
              <tr><td colSpan={7} className="text-center py-8 text-red-600 text-sm">{fetchError}</td></tr>
            ) : tokens.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-8 text-slate-400 text-sm">No tokens issued yet</td></tr>
            ) : tokens.map(t => {
              const status = computeStatus(t);
              const fmtShort = (v) => v ? new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
              const fmtFull = (v) => v ? new Date(v).toLocaleString() : '';
              return (
                <tr key={t.id} className="hover:bg-slate-50/50 transition-colors">
                  <td className="px-3 py-2.5 text-sm font-medium text-slate-900 whitespace-nowrap">{t.user_email}</td>
                  <td className="px-3 py-2.5 text-sm text-slate-600">{t.description || '—'}</td>
                  <td className="px-3 py-2.5 text-xs font-mono text-slate-500 whitespace-nowrap" title={`Created ${fmtFull(t.created_at)}`}>…{t.last4}</td>
                  <td className="px-3 py-2.5 text-sm text-slate-500 whitespace-nowrap" title={fmtFull(t.expires_at)}>{fmtShort(t.expires_at)}</td>
                  <td className="px-3 py-2.5 text-sm text-slate-500 whitespace-nowrap" title={fmtFull(t.last_used_at)}>{fmtShort(t.last_used_at)}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${status.cls}`}>
                      {status.label}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {!t.revoked_at && (
                      <button
                        onClick={() => handleRevoke(t.id, t.last4, t.user_email)}
                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                        title="Revoke"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UserManagementPanel({ token }) {
  const { demo } = useContext(DemoContext);
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('advisor');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const [fetchError, setFetchError] = useState(null);

  const fetchUsers = useCallback(() => {
    setFetchError(null);
    authFetch(`${API_BASE}/users`, token)
      .then(r => {
        if (!r.ok) throw new Error(`Failed to load users (${r.status})`);
        return r.json();
      })
      .then(data => { setUsers(data); setLoadingUsers(false); })
      .catch(err => { setFetchError(err.message); setLoadingUsers(false); });
  }, [token]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const clearMessages = () => { setError(null); setSuccess(null); };

  const handleAddUser = async (e) => {
    e.preventDefault();
    clearMessages();
    if (!newEmail.trim()) return;
    setSaving(true);
    try {
      const r = await authFetch(`${API_BASE}/users`, token, {
        method: 'POST',
        body: JSON.stringify({ email: newEmail.trim().toLowerCase(), role: newRole }),
      });
      if (!r.ok) {
        const data = await r.json();
        throw new Error(data.detail || 'Failed to add user');
      }
      setNewEmail('');
      setNewRole('advisor');
      setSuccess(`Added ${newEmail.trim()}`);
      fetchUsers();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleRoleChange = async (userId, role, email) => {
    clearMessages();
    try {
      const r = await authFetch(`${API_BASE}/users/${userId}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      if (!r.ok) {
        const data = await r.json();
        throw new Error(data.detail || 'Failed to update role');
      }
      setSuccess(`Updated ${email} to ${role}`);
      fetchUsers();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (userId, email) => {
    clearMessages();
    if (!confirm(`Remove ${email}? They will no longer be able to sign in.`)) return;
    try {
      const r = await authFetch(`${API_BASE}/users/${userId}`, token, {
        method: 'DELETE',
      });
      if (!r.ok) {
        const data = await r.json();
        throw new Error(data.detail || 'Failed to remove user');
      }
      setSuccess(`Removed ${email}`);
      fetchUsers();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-8">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">User Management</h2>
            <p className="text-slate-500 text-sm mt-1">Add, remove, or change roles for team members</p>
          </div>
          <div className="text-sm text-slate-400">
            {users.filter(u => u.role === 'ops').length} ops &middot; {users.filter(u => u.role === 'advisor').length} advisor
          </div>
        </div>

        {(error || success) && (
          <div className={`mb-6 px-4 py-3 rounded-lg text-sm font-medium ${error ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-green-50 text-green-700 border border-green-200'}`}>
            {error || success}
          </div>
        )}

        {/* Add user form */}
        <form onSubmit={handleAddUser} className="mb-8 bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <h3 className="text-sm font-bold text-slate-700 uppercase tracking-wider mb-4 flex items-center">
            <UserPlus className="w-4 h-4 mr-2" /> Add User
          </h3>
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Email address</label>
              <input
                type="email"
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                placeholder="name@example.com"
                required
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="sm:w-36">
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Role</label>
              <select
                value={newRole}
                onChange={e => setNewRole(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="advisor">Advisor</option>
                <option value="ops">Operations</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={saving || !newEmail.trim()}
              className="px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Adding...' : 'Add'}
            </button>
          </div>
        </form>

        {/* Users table */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-x-auto">
          <table className="w-full min-w-[34rem]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Email</th>
                <th className="text-left px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Role</th>
                <th className="text-left px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Added</th>
                <th className="text-right px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider w-20"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loadingUsers ? (
                <tr><td colSpan={4} className="text-center py-8"><Loader2 className="w-5 h-5 animate-spin text-slate-400 mx-auto" /></td></tr>
              ) : fetchError ? (
                <tr><td colSpan={4} className="text-center py-8 text-red-600 text-sm">{fetchError}</td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan={4} className="text-center py-8 text-slate-400 text-sm">No users found</td></tr>
              ) : users.map(u => (
                <tr key={u.id} className="hover:bg-slate-50/50 transition-colors">
                  <td className="px-5 py-3.5 text-sm font-medium text-slate-900">
                    {u.email}
                    {u.persona && (
                      <span className="ml-2 align-middle text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                        Sign-in persona
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <select
                      value={u.role}
                      onChange={e => handleRoleChange(u.id, e.target.value, u.email)}
                      disabled={u.persona}
                      title={u.persona ? "The demo's sign-in personas keep their roles" : undefined}
                      className="text-sm px-2.5 py-1 border border-slate-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      <option value="ops">Operations</option>
                      <option value="advisor">Advisor</option>
                    </select>
                  </td>
                  <td className="px-5 py-3.5 text-sm text-slate-500">
                    {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    {!u.persona && (
                      <button
                        onClick={() => handleDelete(u.id, u.email)}
                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                        title={`Remove ${u.email}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-slate-400 mt-4 text-center">
          At least one Operations user must exist at all times to prevent lockout.
        </p>

        {demo ? (
          <div className="mt-10 bg-white rounded-xl border border-slate-200 p-5 text-sm text-slate-600">
            <p className="font-semibold text-slate-800 mb-1 flex items-center"><Key className="w-4 h-4 mr-2" /> MCP tokens and machine APIs</p>
            <p>
              Switched off in this demo. The real app issues MCP tokens here and serves positions to other
              services over Google-signed service-account calls; the demo refuses those routes.
            </p>
          </div>
        ) : (
          <MCPTokensSection token={token} users={users} />
        )}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Outbox (demo mode, ops only): what the app would have sent
// ---------------------------------------------------------------------------

const OUTBOX_KINDS = {
  slack: { label: 'Slack', Icon: MessageSquare },
  drive: { label: 'Google Drive', Icon: Cloud },
};

function OutboxPanel({ token }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);

  const fetchEntries = useCallback(() => {
    setError(null);
    authFetch(`${API_BASE}/outbox`, token)
      .then(r => { if (!r.ok) throw new Error(`Failed to load the Outbox (${r.status})`); return r.json(); })
      .then(setEntries)
      .catch(err => setError(err.message));
  }, [token]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-8 py-10">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h2 className="text-2xl font-bold text-slate-900 flex items-center">
              <Inbox className="w-6 h-6 mr-2.5 text-slate-500" /> Outbox
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              The scan summary the app posts to Slack, and the reports it saves to Google Drive. In this demo they
              are kept here instead of leaving the app.
            </p>
          </div>
          <button
            onClick={fetchEntries}
            className="flex-shrink-0 inline-flex items-center min-h-11 md:min-h-0 px-3 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
          >
            <RefreshCw className="w-4 h-4 mr-1.5" /> Refresh
          </button>
        </div>

        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : entries === null ? (
          <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
        ) : entries.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">
            Nothing yet. Run a statement or press Mark as Completed, and what would have been sent appears here.
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {entries.map(e => {
              const kind = OUTBOX_KINDS[e.kind] || { label: e.kind, Icon: FileText };
              return (
                <li key={e.id} className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <span className="inline-flex items-center text-xs font-bold uppercase tracking-wider text-slate-500">
                      <kind.Icon className="w-3.5 h-3.5 mr-1.5" /> {kind.label}
                    </span>
                    <span className="text-xs text-slate-400" title={e.created_at}>{formatRelativeDate(e.created_at)}</span>
                  </div>
                  <p className="text-sm font-semibold text-slate-900 break-words">{e.title}</p>
                  <p className="text-sm text-slate-600 mt-1.5 whitespace-pre-wrap break-words">{e.body}</p>
                  {e.created_by && <p className="text-xs text-slate-400 mt-2">By {e.created_by}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Sample statements (demo mode, ops only): the demo's intake, in place of the Drive input folder
// ---------------------------------------------------------------------------

const SAMPLE_RESULT_LABELS = {
  success: 'Analyzed',
  skipped: 'Nothing to extract',
  error: 'Failed',
};

// The server answers at once; the panel shows its progress for 45 to 60 seconds first, about what the real
// pipeline spends waiting on the model to read a statement.
const SAMPLE_RUN_SECONDS = { min: 45, max: 60 };

// What a run does, in the pipeline's order, as { title, detail } steps: each statement is pre-screened, then
// parsed (or set aside), then each household goes through the rules, and the run ends with the write and the
// scan summary. The steps are paced evenly across the run; the work itself has already happened on the server.
function sampleRunSteps(samples) {
  const steps = [];
  for (const s of samples) {
    for (const name of s.documents) {
      steps.push({ title: `Pre-screening ${name}`, detail: `${s.client_name} · is it an account statement, and how recent?` });
      if ((s.screened_out || []).includes(name)) {
        steps.push({ title: `Setting aside ${name}`, detail: `${s.client_name} · the pre-screen found it isn't an account statement` });
      } else {
        steps.push({ title: `Parsing ${name}`, detail: `${s.client_name} · ${s.custodian} · reading accounts, positions and tax lots` });
        steps.push({ title: 'Extracting symbols and values', detail: `${s.client_name} · ${name}` });
      }
    }
    steps.push({ title: 'Identifying asset types', detail: `${s.client_name} · ticker table first, then the app's own patterns` });
    steps.push({ title: 'Checking fund restrictions and custodian rules', detail: `${s.client_name} · ${s.custodian}` });
    steps.push({ title: 'Identifying the processing path for each position', detail: `${s.client_name} · ACAT, liquidate, review or unsupported` });
    steps.push({ title: 'Reconciling totals', detail: `${s.client_name} · positions against each statement's printed total` });
  }
  steps.push({ title: 'Saving the results', detail: 'Each household as a new run; earlier runs are kept and marked superseded' });
  steps.push({ title: 'Posting the scan summary', detail: 'To the Outbox, in place of Slack' });
  return steps;
}

function SampleStatementsDialog({ token, onClose, onRan, onOpen }) {
  const [samples, setSamples] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(null);
  const [progress, setProgress] = useState(null);   // { steps, started, duration, now }
  const listRef = useRef(null);

  useEffect(() => {
    authFetch(`${API_BASE}/samples`, token)
      .then(r => { if (!r.ok) throw new Error(`Failed to load the sample statements (${r.status})`); return r.json(); })
      .then(setSamples)
      .catch(err => setError(err.message));
  }, [token]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !running) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, running]);

  const runnable = samples || [];
  const allSelected = runnable.length > 0 && runnable.every(s => selected.has(s.key));
  const toggle = (key) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const run = async () => {
    const chosen = runnable.filter(s => selected.has(s.key));
    const steps = sampleRunSteps(chosen);
    const { min, max } = SAMPLE_RUN_SECONDS;
    const duration = (min + Math.random() * (max - min)) * 1000;
    const started = Date.now();
    setRunning(true);
    setError(null);
    setResults(null);
    setProgress({ steps, started, duration, now: started });
    const ticker = setInterval(() => setProgress(p => p && { ...p, now: Date.now() }), 500);
    try {
      const request = authFetch(`${API_BASE}/samples/run`, token, {
        method: 'POST', body: JSON.stringify({ keys: chosen.map(s => s.key) }),
      }).then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Run failed (${r.status})`);
        return data;
      });
      // A refusal shows at once; results wait out the run's progress.
      const [data] = await Promise.all([request, new Promise(resolve => setTimeout(resolve, duration))]);
      setResults(data.results);
      listRef.current?.scrollTo({ top: 0 });
      await onRan(data.results);
    } catch (err) {
      setError(err.message);
    } finally {
      clearInterval(ticker);
      setProgress(null);
      setRunning(false);
    }
  };

  const fraction = progress ? Math.min(1, (progress.now - progress.started) / progress.duration) : 0;
  const stepIndex = progress ? Math.min(progress.steps.length - 1, Math.floor(fraction * progress.steps.length)) : 0;
  const currentStep = progress ? progress.steps[stepIndex] : null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-end sm:items-center justify-center sm:p-4" onClick={() => { if (!running) onClose(); }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="samples-title"
        onClick={e => e.stopPropagation()}
        className="bg-white w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92vh] flex flex-col"
      >
        <div className="flex items-start justify-between gap-4 px-5 sm:px-6 pt-5 pb-3 border-b border-slate-100">
          <div>
            <h2 id="samples-title" className="text-lg font-bold text-slate-900 flex items-center">
              <ScanSearch className="w-5 h-5 mr-2 text-slate-500" /> Sample statements
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              In the real app, statements arrive in a Drive folder per household and Gemini reads each one. This
              demo has no live model: each statement's extraction is prepared from the statement itself, in the
              JSON the model returns, and the app's own code does the rest: the pre-screen gate, the asset types,
              the transfer rules, the totals check and the write. A run takes about a minute.
            </p>
          </div>
          <button onClick={onClose} disabled={running} className="p-2 -mr-2 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-40" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Outside the scrolling list, so the progress stays in view wherever the list is scrolled. */}
        {(error || progress) && (
          <div className="px-5 sm:px-6 pt-3 flex flex-col gap-2">
            {error && <p role="alert" className="px-3 py-2 rounded-lg text-sm bg-red-50 border border-red-200 text-red-700">{error}</p>}
            {progress && (
              <div className="p-3.5 rounded-xl bg-blue-50 border border-blue-100" aria-live="polite">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center min-w-0 font-medium text-blue-900">
                    <Loader2 className="w-4 h-4 mr-2 flex-shrink-0 animate-spin" />
                    <span className="truncate">{currentStep.title}</span>
                  </span>
                  <span className="flex-shrink-0 text-xs text-blue-700 tabular-nums">
                    {Math.max(0, Math.ceil((progress.duration - (progress.now - progress.started)) / 1000))}s
                  </span>
                </div>
                <p className="mt-0.5 pl-6 text-xs text-blue-800/80 truncate">{currentStep.detail}</p>
                <div className="mt-2.5 h-1.5 rounded-full bg-blue-100 overflow-hidden" role="progressbar"
                     aria-label="Run progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
                  <div className="h-full bg-blue-600 transition-[width] duration-500" style={{ width: `${fraction * 100}%` }} />
                </div>
                <p className="mt-1.5 text-[11px] text-blue-700/80 tabular-nums">
                  Step {stepIndex + 1} of {progress.steps.length}
                </p>
              </div>
            )}
          </div>
        )}

        <div ref={listRef} className="flex-1 overflow-y-auto px-5 sm:px-6 py-4">
          {results && (
            <ul className="mb-4 flex flex-col gap-1.5" aria-live="polite">
              {results.map(r => (
                <li key={r.sample} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-slate-50 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium text-slate-900">{r.client}</span>
                    <span className={`ml-2 text-xs font-semibold ${r.status === 'success' ? 'text-green-700' : r.status === 'error' ? 'text-red-700' : 'text-amber-700'}`}>
                      {SAMPLE_RESULT_LABELS[r.status] || r.status}
                    </span>
                    {r.error && <span className="block text-xs text-red-700 mt-0.5">{r.error}</span>}
                  </span>
                  {r.status === 'success' && (
                    <button onClick={() => onOpen(r)} className="flex-shrink-0 inline-flex items-center min-h-8 text-xs font-semibold text-blue-700 hover:underline">
                      Open <ArrowRight className="w-3.5 h-3.5 ml-1" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {samples === null && !error ? (
            <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {(samples || []).map(s => (
                <li key={s.key} className={`border rounded-xl p-3.5 transition-colors ${selected.has(s.key) ? 'border-blue-300 bg-blue-50/40' : 'border-slate-200'}`}>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 flex-shrink-0"
                      checked={selected.has(s.key)}
                      disabled={running}
                      onChange={() => toggle(s.key)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm font-semibold text-slate-900">{s.client_name}</span>
                        <span className="text-xs text-slate-500">{s.custodian}</span>
                      </span>
                      <span className="block text-sm text-slate-600 mt-1">{s.shows}</span>
                    </span>
                  </label>
                  <div className="mt-1.5 pl-7 flex flex-wrap gap-x-4">
                    {s.documents.map(name => (
                      <a
                        key={name}
                        href={`${API_BASE}/samples/${s.key}/documents/${encodeURIComponent(name)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center min-h-8 text-xs font-medium text-blue-700 hover:underline break-all"
                      >
                        <FileText className="w-3.5 h-3.5 mr-1 flex-shrink-0" /> {name}
                      </a>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 sm:px-6 py-3.5 border-t border-slate-100">
          <button
            onClick={() => setSelected(allSelected ? new Set() : new Set(runnable.map(s => s.key)))}
            disabled={running || runnable.length === 0}
            className="min-h-11 md:min-h-0 px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 disabled:opacity-40"
          >
            {allSelected ? 'Clear' : 'Select all'}
          </button>
          <button
            onClick={run}
            disabled={running || selected.size === 0}
            className="min-h-11 md:min-h-0 inline-flex items-center px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {running ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ScanSearch className="w-4 h-4 mr-2" />}
            {running ? 'Running…' : `Run ${selected.size || ''} ${selected.size === 1 ? 'household' : 'households'}`}
          </button>
        </div>
      </div>
    </div>
  );
}


export default function App() {
  // /api/config: { demo, personas, google_client_id }. Nothing renders until it answers.
  const [config, setConfig] = useState(null);
  const demo = !!config?.demo;
  const demoContext = useMemo(() => ({ demo }), [demo]);
  const [token, setToken] = useState(() => sessionStorage.getItem('auth_token'));
  const [currentUser, setCurrentUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [signInError] = useState(() => SIGNIN_ERRORS[new URLSearchParams(window.location.search).get('signin_error')] || null);

  const [role, setRole] = useState('ops');
  const [householdList, setHouseholdList] = useState([]);
  const [selectedClient, setSelectedClient] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [household, setHousehold] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  // On a phone, a run's deep link opens on the household, not the list.
  const [sidebarOpen, setSidebarOpen] = useState(() => !(parseRunIdFromUrl() && window.matchMedia?.('(max-width: 767px)').matches));
  const [linkCopied, setLinkCopied] = useState(false);
  const [allPdfLoading, setAllPdfLoading] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanMessage, setScanMessage] = useState(null);
  const pendingRunIdRef = useRef(parseRunIdFromUrl());

  const handleLogin = useCallback((credential) => {
    sessionStorage.setItem('auth_token', credential);
    setToken(credential);
    setAuthLoading(true);
    setAuthError(null);
  }, []);

  const handleLogout = useCallback(() => {
    sessionStorage.removeItem('auth_token');
    setToken(null);
    setCurrentUser(null);
    setAuthError(null);
    setSessionWarning(null);
    window.history.replaceState(null, '', '/');
    if (window.google?.accounts?.id) {
      window.google.accounts.id.disableAutoSelect();
    }
  }, []);

  // ---- Session expiry warning ----
  const [sessionWarning, setSessionWarning] = useState(null);

  useEffect(() => {
    if (!token) { setSessionWarning(null); return; }

    const expiry = getTokenExpiry(token);
    if (!expiry) return;

    const WARN_BEFORE_MS = 5 * 60 * 1000;
    let warnTimer, expireTimer, countdownInterval;

    const startCountdown = () => {
      const updateRemaining = () => {
        const remaining = Math.max(0, expiry - Date.now());
        if (remaining <= 0) {
          setSessionWarning(null);
          handleLogout();
          return;
        }
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        setSessionWarning(`${mins}:${secs.toString().padStart(2, '0')}`);
      };
      updateRemaining();
      countdownInterval = setInterval(updateRemaining, 1000);
    };

    const msUntilWarn = expiry - Date.now() - WARN_BEFORE_MS;
    const msUntilExpire = expiry - Date.now();

    if (msUntilWarn <= 0) {
      startCountdown();
    } else {
      warnTimer = setTimeout(startCountdown, msUntilWarn);
    }

    expireTimer = setTimeout(() => {
      setSessionWarning(null);
      handleLogout();
    }, Math.max(0, msUntilExpire));

    return () => {
      clearTimeout(warnTimer);
      clearTimeout(expireTimer);
      clearInterval(countdownInterval);
    };
  }, [token, handleLogout]);

  // Public config first: it says whether this is the demo (cookie sign-in, personas) or Google sign-in.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/config`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => {
        if (cancelled) return;
        setConfig(data);
        // The cookie can't be read here; /api/me says whether it holds a session.
        if (data.demo) setToken(SESSION_COOKIE);
      })
      .catch(() => { if (!cancelled) setConfig({ demo: false, google_client_id: '' }); });
    return () => { cancelled = true; };
  }, []);

  // Initialize Google Identity Services at the App level so the OAuth
  // callback is registered even when LoginScreen is not mounted (returning
  // users who skip straight to the dashboard). Google's script loads only
  // outside the demo.
  const [gsiReady, setGsiReady] = useState(false);

  useEffect(() => {
    const cid = config && !config.demo ? config.google_client_id : '';
    if (!cid) return;
    let cancelled = false;
    const init = () => {
      if (cancelled || !window.google?.accounts?.id) return;
      window.google.accounts.id.initialize({
        client_id: cid,
        callback: (response) => handleLogin(response.credential),
      });
      setGsiReady(true);
    };
    if (window.google?.accounts?.id) {
      init();
    } else {
      const script = Object.assign(document.createElement('script'), {
        src: 'https://accounts.google.com/gsi/client', async: true,
      });
      script.onload = init;
      document.head.appendChild(script);
    }
    return () => { cancelled = true; };
  }, [config, handleLogin]);

  const handleRenewSession = useCallback(() => {
    if (!gsiReady || !window.google?.accounts?.id) return;
    window.google.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        handleLogout();
      }
    });
  }, [gsiReady, handleLogout]);

  useEffect(() => {
    if (!config) return;
    if (!token) { setAuthLoading(false); return; }

    authFetch(`${API_BASE}/me`, token)
      .then(r => {
        // Demo: a 401 just means no session yet, so the personas show without an error.
        if (config.demo && r.status === 401) throw new Error('SIGNED_OUT');
        if (!r.ok) throw new Error(r.status === 403 ? 'NOT_AUTHORIZED' : 'Authentication failed.');
        return r.json();
      })
      .then(user => {
        setCurrentUser(user);
        setRole(user.role === 'ops' ? 'ops' : 'advisor');
        setAuthLoading(false);
      })
      .catch(err => {
        if (err.message !== 'SIGNED_OUT') setAuthError(err.message);
        sessionStorage.removeItem('auth_token');
        setToken(null);
        setAuthLoading(false);
        if (err.message === 'NOT_AUTHORIZED' && window.google?.accounts?.id) {
          window.google.accounts.id.disableAutoSelect();
        }
      });
  }, [token, config]);

  const clientGroups = useMemo(() => {
    const groups = {};
    householdList.forEach(hh => {
      const name = hh.client_name;
      if (!groups[name]) groups[name] = [];
      groups[name].push(hh);
    });
    Object.values(groups).forEach(runs =>
      runs.sort((a, b) => new Date(b.processed_at) - new Date(a.processed_at))
    );
    return groups;
  }, [householdList]);

  const clientNames = useMemo(() => {
    const names = Object.keys(clientGroups);
    if (!searchQuery.trim()) return names;
    const q = searchQuery.toLowerCase();
    return names.filter(n => n.toLowerCase().includes(q));
  }, [clientGroups, searchQuery]);

  const selectedRuns = selectedClient ? (clientGroups[selectedClient] || []) : [];

  const fetchHouseholds = useCallback(() => {
    if (!token || !currentUser) return;
    setLoading(true);
    setError(null);
    authFetch(`${API_BASE}/households?include_superseded=true&per_page=500`, token)
      .then(r => { if (!r.ok) throw new Error(`Failed to load households (${r.status})`); return r.json(); })
      .then(data => { setHouseholdList(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [token, currentUser]);

  useEffect(() => { fetchHouseholds(); }, [fetchHouseholds]);

  const scanClearTimerRef = useRef(null);
  const handleManualScan = useCallback(async () => {
    if (scanClearTimerRef.current) {
      clearTimeout(scanClearTimerRef.current);
      scanClearTimerRef.current = null;
    }
    setScanMessage(null);
    setScanBusy(true);
    try {
      const r = await authFetch(`${API_BASE}/scan`, token, { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      if (r.status === 409) {
        setScanMessage({ text: 'A scan is already in progress.', variant: 'warn' });
      } else if (!r.ok) {
        setScanMessage({
          text: typeof data.detail === 'string' ? data.detail : `Scan failed (${r.status})`,
          variant: 'error',
        });
      } else {
        setScanMessage({
          text: `Scan finished — ${data.clients_processed ?? 0} client(s) processed.`,
          variant: 'success',
        });
        const hl = await authFetch(`${API_BASE}/households?include_superseded=true&per_page=500`, token);
        if (hl.ok) setHouseholdList(await hl.json());
        if (selectedId) {
          const dr = await authFetch(`${API_BASE}/households/${selectedId}`, token);
          if (dr.ok) setHousehold(await dr.json());
        }
      }
    } catch (err) {
      setScanMessage({ text: err.message || 'Scan request failed', variant: 'error' });
    } finally {
      setScanBusy(false);
      scanClearTimerRef.current = setTimeout(() => {
        setScanMessage(null);
        scanClearTimerRef.current = null;
      }, 6000);
    }
  }, [token, selectedId]);

  // Resolve deep link after household list loads
  useEffect(() => {
    const pendingId = pendingRunIdRef.current;
    if (!pendingId || householdList.length === 0) return;
    pendingRunIdRef.current = null;

    const match = householdList.find(hh => hh.id === pendingId);
    if (match) {
      setSelectedClient(match.client_name);
      setSelectedId(match.id);
    } else {
      authFetch(`${API_BASE}/households/${pendingId}`, token)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data) {
            setSelectedClient(data.client_name);
            setSelectedId(pendingId);
          }
        });
    }
  }, [householdList, token]);

  // Browser back/forward
  useEffect(() => {
    const handlePopState = () => {
      const id = parseRunIdFromUrl();
      if (id) {
        const match = householdList.find(hh => hh.id === id);
        if (match) {
          setSelectedClient(match.client_name);
          setSelectedId(match.id);
        }
      } else {
        setSelectedClient(null);
        setSelectedId(null);
        setHousehold(null);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [householdList]);

  useEffect(() => {
    if (!selectedId || !token) return;
    setLoading(true);
    authFetch(`${API_BASE}/households/${selectedId}`, token)
      .then(r => { if (!r.ok) throw new Error(`Failed to load household detail (${r.status})`); return r.json(); })
      .then(data => { setHousehold(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [selectedId, token]);

  const selectClient = useCallback((name) => {
    if (window.matchMedia?.('(max-width: 767px)').matches) setSidebarOpen(false);
    setSelectedClient(name);
    const runs = clientGroups[name] || [];
    if (runs.length > 0) {
      setSelectedId(runs[0].id);
      window.history.pushState(null, '', `/run/${runs[0].id}`);
    }
  }, [clientGroups]);

  // Demo intake: after a sample run, reload the households and open the first one it analyzed.
  const [samplesOpen, setSamplesOpen] = useState(false);
  const openSampleResult = useCallback((result) => {
    if (window.matchMedia?.('(max-width: 767px)').matches) setSidebarOpen(false);
    setRole(r => (r === 'users' || r === 'outbox' ? 'ops' : r));
    setSelectedClient(result.client);
    setSelectedId(result.household_id);
    window.history.pushState(null, '', `/run/${result.household_id}`);
  }, []);
  const handleSamplesRan = useCallback(async (results) => {
    const hl = await authFetch(`${API_BASE}/households?include_superseded=true&per_page=500`, token);
    if (hl.ok) setHouseholdList(await hl.json());
    const first = results.find(r => r.status === 'success');
    if (first) openSampleResult(first);
  }, [token, openSampleResult]);

  const [overrideError, setOverrideError] = useState(null);
  const [updatingPositionId, setUpdatingPositionId] = useState(null);
  const [updatingTransferringId, setUpdatingTransferringId] = useState(null);
  const [updatingAccountId, setUpdatingAccountId] = useState(null);
  const [undoToast, setUndoToast] = useState(null);
  const undoTimerRef = useRef(null);

  const showUndoToast = useCallback((message, onUndo) => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoToast({ message, onUndo });
    undoTimerRef.current = setTimeout(() => setUndoToast(null), 8000);
  }, []);

  const dismissUndoToast = useCallback(() => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoToast(null);
  }, []);

  const refreshHousehold = useCallback(async () => {
    if (!token) return;
    if (selectedId) {
      const r = await authFetch(`${API_BASE}/households/${selectedId}`, token);
      if (r.ok) setHousehold(await r.json());
    }
    const hl = await authFetch(`${API_BASE}/households?include_superseded=true&per_page=500`, token);
    if (hl.ok) setHouseholdList(await hl.json());
  }, [selectedId, token]);

  const destAction = useCallback(async (fn) => {
    setOverrideError(null);
    try {
      const resp = await fn();
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.detail || `Request failed (${resp.status})`);
      }
      await refreshHousehold();
    } catch (err) {
      setOverrideError(err.message);
      setTimeout(() => setOverrideError(null), 5000);
    }
  }, [refreshHousehold]);

  const handleNeedsToOpen = useCallback((destId, needs) => destAction(() =>
    authFetch(`${API_BASE}/destinations/${destId}`, token, {
      method: 'PATCH', body: JSON.stringify({ needs_to_be_opened: needs }),
    })), [token, destAction]);

  const handleSetDestinationType = useCallback((destId, type) => destAction(() =>
    authFetch(`${API_BASE}/destinations/${destId}`, token, {
      method: 'PATCH', body: JSON.stringify({ target_account_type: type }),
    })), [token, destAction]);

  const handleReassignSource = useCallback((linkId, opts) => destAction(() =>
    authFetch(`${API_BASE}/source-accounts/reassign`, token, {
      method: 'POST', body: JSON.stringify({ link_id: linkId, ...opts }),
    })), [token, destAction]);

  const handleAddDestination = useCallback((sourceFolderId, owner, type) => destAction(() =>
    authFetch(`${API_BASE}/clients/${encodeURIComponent(sourceFolderId)}/destinations`, token, {
      method: 'POST', body: JSON.stringify({ owner, target_account_type: type }),
    })), [token, destAction]);

  const handleDeleteDestination = useCallback((destId) => destAction(() =>
    authFetch(`${API_BASE}/destinations/${destId}`, token, { method: 'DELETE' })), [token, destAction]);

  const handleStatusChange = useCallback(async (positionId, newStatus) => {
    setOverrideError(null);
    setUpdatingPositionId(positionId);
    try {
      const resp = await authFetch(`${API_BASE}/positions/${positionId}/status`, token, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus, notes: `Manual override to ${newStatus}` }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.detail || `Failed to update status (${resp.status})`);
      }
      await refreshHousehold();
    } catch (err) {
      setOverrideError(err.message);
      setTimeout(() => setOverrideError(null), 5000);
    } finally {
      setUpdatingPositionId(null);
    }
  }, [token, refreshHousehold]);

  const handleTransferringChange = useCallback(async (positionId, value) => {
    setOverrideError(null);
    setUpdatingTransferringId(positionId);
    try {
      const resp = await authFetch(`${API_BASE}/positions/${positionId}/transferring`, token, {
        method: 'PATCH',
        body: JSON.stringify({ value }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.detail || `Failed to update transferring (${resp.status})`);
      }
      await refreshHousehold();
    } catch (err) {
      setOverrideError(err.message);
      setTimeout(() => setOverrideError(null), 5000);
    } finally {
      setUpdatingTransferringId(null);
    }
  }, [token, refreshHousehold]);

  const handleDeletePosition = useCallback(async (positionId, label) => {
    try {
      const resp = await authFetch(`${API_BASE}/positions/${positionId}`, token, { method: 'DELETE' });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.detail || `Failed to delete position (${resp.status})`);
      }
      await refreshHousehold();
      showUndoToast(`Deleted position ${label}`, async () => {
        await authFetch(`${API_BASE}/positions/${positionId}/restore`, token, { method: 'PATCH' });
        await refreshHousehold();
      });
    } catch (err) {
      setOverrideError(err.message);
      setTimeout(() => setOverrideError(null), 5000);
    }
  }, [token, refreshHousehold, showUndoToast]);

  const handleDeleteAccount = useCallback(async (accountId, label) => {
    if (!confirm(`Delete "${label}" and all its positions? You can undo this.`)) return;
    try {
      const resp = await authFetch(`${API_BASE}/accounts/${accountId}`, token, { method: 'DELETE' });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.detail || `Failed to delete account (${resp.status})`);
      }
      await refreshHousehold();
      showUndoToast(`Deleted account ${label}`, async () => {
        await authFetch(`${API_BASE}/accounts/${accountId}/restore`, token, { method: 'PATCH' });
        await refreshHousehold();
      });
    } catch (err) {
      setOverrideError(err.message);
      setTimeout(() => setOverrideError(null), 5000);
    }
  }, [token, refreshHousehold, showUndoToast]);

  const handleAccountTypeChange = useCallback(async (accountId, newType, currentType, otherText = null, currentOther = null) => {
    const otherNorm = (otherText || '').trim() || null;
    const currentOtherNorm = (currentOther || '').trim() || null;
    // No-op only when both the type AND the "Other" label are unchanged.
    if (newType === currentType && (newType !== 'Other' || otherNorm === currentOtherNorm)) return;
    const toLabel = newType === 'Other' && otherNorm ? `Other (${otherNorm})` : newType;
    const confirmMsg =
      `Change account classification from "${currentType || 'Unknown'}" to "${toLabel}"?\n\n` +
      `This will re-run the rule engine for every position in this account. ` +
      `Manual position-level overrides will be preserved.`;
    if (!confirm(confirmMsg)) return;

    setOverrideError(null);
    setUpdatingAccountId(accountId);
    try {
      const resp = await authFetch(`${API_BASE}/accounts/${accountId}/type`, token, {
        method: 'PATCH',
        body: JSON.stringify({ account_type: newType, account_type_other: otherNorm }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.detail || `Failed to update account type (${resp.status})`);
      }
      await refreshHousehold();
    } catch (err) {
      setOverrideError(err.message);
      setTimeout(() => setOverrideError(null), 5000);
    } finally {
      setUpdatingAccountId(null);
    }
  }, [token, refreshHousehold]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
      </div>
    );
  }

  if (!token || !currentUser) {
    if (demo) {
      return (
        <LoginScreen
          personas={config.personas}
          signInError={signInError || (authError ? SIGNIN_ERRORS.config : null)}
        />
      );
    }
    if (authError === 'NOT_AUTHORIZED') {
      return (
        <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--brand-cream)' }}>
          <div className="max-w-md text-center p-8">
            <div className="bg-red-100 p-4 rounded-full inline-block mb-6">
              <ShieldAlert className="w-8 h-8 text-red-500" />
            </div>
            <h2
              className="text-2xl font-bold text-slate-900 mb-3"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              Access Required
            </h2>
            <p className="text-slate-600 text-sm mb-8" style={{ fontFamily: "'DM Sans', sans-serif" }}>
              Your Google account is not authorized to use this application.
              Please contact the Operations team for access.
            </p>
            <button
              onClick={() => { setAuthError(null); }}
              className="inline-flex items-center px-5 py-2.5 text-sm font-medium rounded-lg transition-colors"
              style={{ background: '#0A0A0A', color: '#fff' }}
            >
              <LogOut className="w-4 h-4 mr-2" />
              Try Another Account
            </button>
          </div>
        </div>
      );
    }
    return (
      <>
        <LoginScreen gsiReady={gsiReady} />
        {authError && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-red-50 border border-red-200 text-red-700 px-6 py-3 rounded-lg shadow-lg text-sm font-medium">
            {authError}
          </div>
        )}
      </>
    );
  }

  const isOps = currentUser.role === 'ops';

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="bg-white p-8 rounded-xl shadow-lg border border-red-200 max-w-md text-center">
          <h2 className="text-lg font-bold text-red-700 mb-2">Connection Error</h2>
          <p className="text-slate-600 text-sm">{error}</p>
          <p className="text-slate-500 text-xs mt-4">Make sure the FastAPI server is running on port 8080.</p>
          <button
            onClick={() => { setError(null); setHousehold(null); setSelectedClient(null); setSelectedId(null); window.history.replaceState(null, '', '/'); fetchHouseholds(); }}
            className="mt-6 inline-flex items-center px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <DemoContext.Provider value={demoContext}>
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-900">

      {/* Manual scan feedback (ops) */}
      {scanMessage && (
        <div
          className={`px-4 py-2.5 flex items-center justify-center space-x-3 text-sm font-medium shadow-md z-50 ${
            scanMessage.variant === 'success'
              ? 'bg-emerald-700 text-white'
              : scanMessage.variant === 'warn'
                ? 'bg-amber-600 text-white'
                : 'bg-red-600 text-white'
          }`}
        >
          <ScanSearch className="w-4 h-4 flex-shrink-0 opacity-90" />
          <span>{scanMessage.text}</span>
          <button
            type="button"
            onClick={() => {
              if (scanClearTimerRef.current) clearTimeout(scanClearTimerRef.current);
              scanClearTimerRef.current = null;
              setScanMessage(null);
            }}
            className="text-white/70 hover:text-white text-xs ml-1"
          >
            ✕
          </button>
        </div>
      )}

      {/* Session expiry warning */}
      {sessionWarning && (
        <div className="bg-amber-500 text-white px-4 py-2.5 flex items-center justify-center space-x-4 text-sm font-medium shadow-md z-50">
          <div className="flex items-center space-x-2">
            <Clock className="w-4 h-4" />
            <span>Your session expires in <strong>{sessionWarning}</strong></span>
          </div>
          <button
            onClick={handleRenewSession}
            className="bg-white/20 hover:bg-white/30 px-3 py-1 rounded text-xs font-semibold transition-colors"
          >
            Renew Session
          </button>
        </div>
      )}

      {/* Override error toast */}
      {overrideError && (
        <div className="bg-red-600 text-white px-4 py-2.5 flex items-center justify-center space-x-3 text-sm font-medium shadow-md z-50">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{overrideError}</span>
          <button onClick={() => setOverrideError(null)} className="text-white/70 hover:text-white text-xs ml-2">✕</button>
        </div>
      )}

      {/* Undo toast */}
      {undoToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-3 rounded-xl shadow-2xl flex items-center space-x-4 z-50 animate-[slideUp_0.2s_ease-out]">
          <Trash2 className="w-4 h-4 text-slate-400 flex-shrink-0" />
          <span className="text-sm font-medium">{undoToast.message}</span>
          <button
            onClick={async () => { dismissUndoToast(); await undoToast.onUndo(); }}
            className="flex items-center space-x-1.5 bg-white/15 hover:bg-white/25 px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors"
          >
            <Undo2 className="w-3.5 h-3.5" />
            <span>Undo</span>
          </button>
          <button onClick={dismissUndoToast} className="text-white/40 hover:text-white/80 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Header */}
      <header className="text-white px-4 md:px-6 py-2 md:py-0 md:h-[60px] flex flex-wrap md:flex-nowrap justify-between items-center gap-x-4 gap-y-2 shadow-md" style={{ background: '#0A0A0A', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center space-x-4 min-w-0">
          <CedarRidgeLogo size="text-[17px]" color="text-white" />
          <div className="hidden xl:block h-5 w-px" style={{ background: 'rgba(255,255,255,0.12)' }} />
          <span className="hidden xl:inline text-[13px] font-medium" style={{ color: 'rgba(255,255,255,0.35)', fontFamily: "'DM Sans', sans-serif" }}>Asset Intelligence</span>
          {!demo && <ScheduleStatusBadge token={token} />}
        </div>
        <div className="order-last md:order-none w-full md:w-auto md:ml-auto flex items-center gap-2 md:gap-4 overflow-x-auto">
          {isOps && !demo && (
            <button
              type="button"
              onClick={handleManualScan}
              disabled={scanBusy}
              className="inline-flex items-center space-x-2 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none text-white/90 hover:bg-white/10"
              style={{ border: '1px solid rgba(255,255,255,0.12)' }}
              title="Run Drive input folder scan now"
            >
              {scanBusy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ScanSearch className="w-4 h-4" />
              )}
              <span>Run scan</span>
            </button>
          )}
          {isOps && demo && (
            <button
              type="button"
              onClick={() => setSamplesOpen(true)}
              className="hidden md:inline-flex items-center space-x-2 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors text-white/90 hover:bg-white/10"
              style={{ border: '1px solid rgba(255,255,255,0.12)' }}
              title="Run sample statements through the pipeline"
              aria-label="Sample statements"
            >
              <ScanSearch className="w-4 h-4 flex-shrink-0" />
              <span className="hidden xl:inline whitespace-nowrap">Sample statements</span>
            </button>
          )}
          {isOps && (
            <div className="flex flex-1 md:flex-none items-center rounded-[10px] p-[3px]" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <button
                onClick={() => setRole('ops')}
                className={`flex-1 md:flex-none whitespace-nowrap px-2 md:px-4 py-[7px] text-[12px] md:text-[13px] font-medium rounded-lg transition-colors ${role === 'ops' ? 'bg-[#fff] text-[#0A0A0A] shadow' : 'text-white/40 hover:text-white/70'}`}
              >
                Operations
              </button>
              <button
                onClick={() => setRole('advisor')}
                className={`flex-1 md:flex-none whitespace-nowrap px-2 md:px-4 py-[7px] text-[12px] md:text-[13px] font-medium rounded-lg transition-colors ${role === 'advisor' ? 'bg-[#fff] text-[#0A0A0A] shadow' : 'text-white/40 hover:text-white/70'}`}
              >
                Client Service
              </button>
              <button
                onClick={() => setRole('users')}
                className={`flex-1 md:flex-none whitespace-nowrap px-2 md:px-4 py-[7px] text-[12px] md:text-[13px] font-medium rounded-lg transition-colors ${role === 'users' ? 'bg-[#fff] text-[#0A0A0A] shadow' : 'text-white/40 hover:text-white/70'}`}
              >
                <span className="flex items-center justify-center space-x-1.5"><Users className="hidden sm:block w-3.5 h-3.5" /><span>Users</span></span>
              </button>
              {demo && (
                <button
                  onClick={() => setRole('outbox')}
                  className={`flex-1 md:flex-none whitespace-nowrap px-2 md:px-4 py-[7px] text-[12px] md:text-[13px] font-medium rounded-lg transition-colors ${role === 'outbox' ? 'bg-[#fff] text-[#0A0A0A] shadow' : 'text-white/40 hover:text-white/70'}`}
                >
                  <span className="flex items-center justify-center space-x-1.5"><Inbox className="hidden sm:block w-3.5 h-3.5" /><span>Outbox</span></span>
                </button>
              )}
            </div>
          )}
          {!isOps && (
            <span className="px-3 py-1.5 text-[13px] font-medium text-white/60 rounded-lg" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}>
              Client Service View
            </span>
          )}
        </div>
        <div className="flex items-center space-x-2 md:space-x-3 md:pl-4 md:border-l md:border-white/10">
            {currentUser.picture && (
              <img src={currentUser.picture} alt="" className="w-8 h-8 rounded-full" referrerPolicy="no-referrer" />
            )}
            <div className="text-right hidden xl:block">
              <p className="text-sm font-medium leading-tight">{currentUser.name || currentUser.email}</p>
              <p className="text-[10px] uppercase tracking-wider font-bold" style={{ color: 'rgba(255,255,255,0.35)' }}>{currentUser.role}</p>
            </div>
            {isOps && demo && (
              <button
                type="button"
                onClick={() => setSamplesOpen(true)}
                className="md:hidden p-2 rounded-md text-white/70 hover:text-white"
                aria-label="Sample statements"
                title="Sample statements"
              >
                <ScanSearch className="w-4 h-4" />
              </button>
            )}
            <ThemeToggle className="p-2 rounded-md transition-colors text-white/30 hover:text-white/70" />
            {demo ? (
              // A plain form post: the server clears the HttpOnly cookie and answers 303 to the sign-in screen.
              <form method="post" action="/auth/sign-out">
                <button
                  type="submit"
                  className="p-2 rounded-md transition-colors text-white/30 hover:text-white/70"
                  title="Sign out"
                  aria-label="Sign out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </form>
            ) : (
              <button
                onClick={handleLogout}
                className="p-2 rounded-md transition-colors text-white/30 hover:text-white/70"
                style={{ ':hover': { background: 'rgba(255,255,255,0.06)' } }}
                title="Sign out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            )}
        </div>
      </header>

      {role === 'users' && isOps ? (
        <UserManagementPanel token={token} />
      ) : role === 'outbox' && isOps && demo ? (
        <OutboxPanel token={token} />
      ) : (
      <div className="flex flex-1 overflow-hidden">

        {/* Sidebar — collapsible. Collapsed = a thin rail with a pop-out button. On a phone the open list takes
            the whole screen and the rail is replaced by a "Households" button above the household. */}
        {!sidebarOpen ? (
          <div className="hidden md:flex w-12 flex-shrink-0 bg-white border-r border-slate-200 py-4 flex-col items-center">
            <button
              onClick={() => setSidebarOpen(true)}
              title="Show households"
              className="p-2 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            >
              <PanelLeftOpen className="w-5 h-5" />
            </button>
          </div>
        ) : (
        <div className="w-full md:w-80 flex-shrink-0 bg-white md:border-r border-slate-200 p-4 flex flex-col overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Households</h2>
            <button
              onClick={() => setSidebarOpen(false)}
              title="Collapse sidebar"
              className="p-1.5 -mr-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </div>
          <div className="relative mb-4">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search clients..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="space-y-1 flex-1">
            {clientNames.map(name => {
              const runs = clientGroups[name];
              return (
                <button
                  key={name}
                  onClick={() => selectClient(name)}
                  className={`w-full text-left px-3 py-2.5 rounded-md text-sm transition-colors ${selectedClient === name ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-600 hover:bg-slate-50'}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center">
                      <Users className="w-4 h-4 mr-2 flex-shrink-0" />
                      <span className="truncate">{name}</span>
                    </span>
                    {runs.length > 1 && (
                      <span className="ml-2 px-1.5 py-0.5 bg-slate-200 text-slate-600 text-[10px] font-bold rounded-full flex-shrink-0">
                        {runs.length}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          {householdList.length > 0 && (
            <div className="pt-3 mt-3 border-t border-slate-200">
              <button
                onClick={async () => {
                  setAllPdfLoading(true);
                  try { await exportAllHouseholdsPDF(token); }
                  catch (err) { alert(`Export failed: ${err.message}`); }
                  finally { setAllPdfLoading(false); }
                }}
                disabled={allPdfLoading}
                className="w-full flex items-center justify-center space-x-2 px-3 py-2.5 text-sm font-medium text-slate-600 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 hover:border-slate-300 transition-colors disabled:opacity-50"
              >
                {allPdfLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
                <span>{allPdfLoading ? 'Generating...' : 'Export All Clients PDF'}</span>
              </button>
            </div>
          )}
        </div>
        )}

        {/* Main content */}
        <main className={`${sidebarOpen ? 'hidden md:block' : 'block'} flex-1 min-w-0 overflow-y-auto p-4 md:p-8`}>
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden mb-4 inline-flex items-center min-h-11 text-sm font-medium text-slate-600"
          >
            <ArrowLeft className="w-4 h-4 mr-1.5" /> Households
          </button>
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
            </div>
          ) : !household ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-md">
                <div className="bg-slate-100 p-5 rounded-full inline-block mb-5">
                  <FileText className="w-10 h-10 text-slate-400" />
                </div>
                <h2 className="text-xl font-bold text-slate-700 mb-2">
                  {householdList.length === 0 ? 'No asset mapping results' : 'Select a household'}
                </h2>
                <p className="text-slate-500 text-sm">
                  {householdList.length === 0
                    ? (demo
                      ? 'No statements have been analyzed yet.'
                      : 'Upload client brokerage statements to the Google Drive input folder. Results will appear here after the next scan.')
                    : 'Choose a client from the sidebar to view their asset mapping results.'}
                </p>
                {demo && isOps && householdList.length === 0 && (
                  <button
                    onClick={() => setSamplesOpen(true)}
                    className="mt-5 inline-flex items-center min-h-11 px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    <ScanSearch className="w-4 h-4 mr-2" /> Run sample statements
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3 md:flex-row md:justify-between md:items-end mb-6">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-y-2">
                    <h2 className="text-2xl md:text-3xl font-bold text-slate-900">{household.client_name}</h2>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(`${window.location.origin}/run/${selectedId}`);
                        setLinkCopied(true);
                        setTimeout(() => setLinkCopied(false), 2000);
                      }}
                      className={`ml-4 inline-flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                        linkCopied
                          ? 'bg-green-50 text-green-700 border-green-200'
                          : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50 hover:text-blue-600'
                      }`}
                      title="Copy shareable link"
                    >
                      <Link2 className="w-3.5 h-3.5" />
                      <span>{linkCopied ? 'Copied!' : 'Share'}</span>
                    </button>
                  </div>
                  <p className="text-slate-500 mt-1 flex items-center text-sm font-medium">
                    <FileText className="w-4 h-4 mr-1" />
                    {demo
                      ? 'Extraction prepared from the statements (no live model in this demo)'
                      : <>Statements ingested &amp; parsed by Vertex AI</>}
                    {household.processed_at && (
                      <span className="ml-3 text-slate-400">&middot; {formatRelativeDate(household.processed_at)}</span>
                    )}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-slate-500 uppercase tracking-wider">Total Household Value</p>
                  <p className="text-3xl font-bold text-slate-900">
                    {formatCurrency((household.accounts || []).reduce((sum, acc) => sum + toNum(acc.total_value), 0))}
                  </p>
                </div>
              </div>

              {selectedRuns.length > 1 && (
                <div className="mb-6 flex items-center space-x-2 overflow-x-auto pb-1">
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap mr-1">Runs:</span>
                  {selectedRuns.map((run, idx) => (
                    <button
                      key={run.id}
                      onClick={() => { setSelectedId(run.id); window.history.pushState(null, '', `/run/${run.id}`); }}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
                        selectedId === run.id
                          ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                          : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      {idx === 0 ? 'Latest' : `Run ${selectedRuns.length - idx}`}
                      <span className="ml-1.5 opacity-75">{formatRelativeDate(run.processed_at)}</span>
                      <span className="ml-1.5 opacity-60">&middot; {run.total_accounts} acct{run.total_accounts !== 1 ? 's' : ''}, {run.total_positions} pos</span>
                    </button>
                  ))}
                </div>
              )}

              {role === 'ops' && isOps
                ? <OpsView household={household} onStatusChange={handleStatusChange} updatingPositionId={updatingPositionId} onTransferringChange={handleTransferringChange} updatingTransferringId={updatingTransferringId} onDeletePosition={handleDeletePosition} onDeleteAccount={handleDeleteAccount} onAccountTypeChange={handleAccountTypeChange} updatingAccountId={updatingAccountId} onNeedsToOpen={handleNeedsToOpen} onSetDestinationType={handleSetDestinationType} onReassignSource={handleReassignSource} onAddDestination={handleAddDestination} onDeleteDestination={handleDeleteDestination} token={token} householdId={selectedId} refreshHousehold={refreshHousehold} />
                : <AdvisorView household={household} token={token} householdId={selectedId} isOps={isOps} />}
            </>
          )}
        </main>
      </div>
      )}
      {samplesOpen && isOps && demo && (
        <SampleStatementsDialog
          token={token}
          onClose={() => setSamplesOpen(false)}
          onRan={handleSamplesRan}
          onOpen={(result) => { openSampleResult(result); setSamplesOpen(false); }}
        />
      )}
    </div>
    </DemoContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Validation badge
// ---------------------------------------------------------------------------

const ValidationBadge = ({ status }) => {
  if (!status || status === 'VALID') return null;
  const styles = status === 'WARNING'
    ? 'bg-yellow-100 text-yellow-800 border-yellow-200'
    : 'bg-red-100 text-red-800 border-red-200';
  return (
    <span className={`ml-3 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full border ${styles}`}>
      {status}
    </span>
  );
};

// Freshness flag: shown when a statement is older than the freshness window.
// Non-blocking — the account is still processed; this just signals "as of N days ago".
const StalenessBadge = ({ account }) => {
  if (!account || !account.is_stale) return null;
  const age = account.statement_age_days;
  const label = age != null ? `${age}d old` : 'stale';
  const title = account.statement_date
    ? `Statement dated ${account.statement_date} — ${age} days old. Holdings/values may be out of date; verify before relying on them.`
    : 'Statement is older than the freshness window; verify values are current.';
  return (
    <span
      title={title}
      className="ml-3 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full border bg-amber-100 text-amber-800 border-amber-200 inline-flex items-center"
    >
      <Clock className="w-3 h-3 mr-1" />
      {label}
    </span>
  );
};

// ---------------------------------------------------------------------------
// Document ingestion panel
// ---------------------------------------------------------------------------

function DocIngestionPanel({ household }) {
  const docResults = household.doc_results || [];
  if (docResults.length === 0) return null;

  const extracted = docResults.filter(d => d.status === 'extracted');
  const rejected = docResults.filter(d => d.status === 'rejected');
  const stale = docResults.filter(d => d.status === 'stale');

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 mb-6">
      <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center">
        <FileText className="w-4 h-4 mr-1.5" />
        Document Ingestion — {household.docs_total || 0} total, {household.docs_extracted || 0} extracted
      </h3>
      <div className="grid grid-cols-1 gap-2">
        {docResults.map((doc, idx) => {
          const statusColors = {
            extracted: 'text-green-700 bg-green-50 border-green-200',
            rejected: 'text-red-700 bg-red-50 border-red-200',
            stale: 'text-orange-700 bg-orange-50 border-orange-200',
            pending: 'text-slate-500 bg-slate-50 border-slate-200',
          };
          return (
            <div key={idx} className={`flex items-center justify-between px-3 py-2 rounded-lg border text-sm ${statusColors[doc.status] || statusColors.pending}`}>
              <span className="font-medium truncate mr-4">{doc.filename}</span>
              <div className="flex items-center space-x-3 flex-shrink-0">
                {doc.status === 'extracted' && (
                  <span className="text-xs opacity-75">{doc.accounts_extracted} acct, {doc.positions_extracted} pos</span>
                )}
                {doc.reason && <span className="text-xs opacity-75 max-w-[200px] truncate">{doc.reason}</span>}
                <span className="text-xs font-bold uppercase">{doc.status}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ops view
// ---------------------------------------------------------------------------

const ATO_TYPES = [
  'Individual',
  'JWROS', 'JTIC', 'Joint Community Property',
  'Roth IRA', 'Traditional IRA',
  'Beneficiary Roth IRA', 'Beneficiary Traditional IRA',
];

function Dropdown({ label, className, children }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  // Position the menu with fixed coords from the button's screen rect so it
  // escapes any `overflow-hidden` ancestor (e.g. the account card) instead of
  // being clipped, and flips upward when there isn't room below.
  const [style, setStyle] = useState({ position: 'fixed', visibility: 'hidden' });
  useEffect(() => {
    if (!open || !btnRef.current || !menuRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const menuH = menuRef.current.offsetHeight;
    const menuW = menuRef.current.offsetWidth;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < menuH + 8 && rect.top > spaceBelow;
    const left = Math.min(Math.max(8, rect.right - menuW), window.innerWidth - menuW - 8);
    setStyle(openUp
      ? { position: 'fixed', left, bottom: window.innerHeight - rect.top + 4, top: 'auto' }
      : { position: 'fixed', left, top: rect.bottom + 4, bottom: 'auto' });
  }, [open]);
  const close = () => { setStyle({ position: 'fixed', visibility: 'hidden' }); setOpen(false); };
  return (
    <span className="inline-block">
      <button ref={btnRef} type="button" onClick={() => setOpen(o => !o)} className={className}>{label}</button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div ref={menuRef} style={style} onClick={(e) => e.stopPropagation()}
               className="z-50 bg-white border border-slate-200 rounded-lg shadow-xl min-w-[190px] py-1 overflow-hidden max-h-96 overflow-y-auto">
            {children(close)}
          </div>
        </>
      )}
    </span>
  );
}

const NeedsPill = ({ needs }) => (
  <span className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-full ${needs ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>
    Needs to be opened? {needs ? 'Yes' : 'No'} <ChevronRight className="w-3 h-3 rotate-90" />
  </span>
);

function DestinationsPanel({ household, onNeedsToOpen, onSetDestinationType, onReassignSource, onAddDestination, onDeleteDestination }) {
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newOwner, setNewOwner] = useState('');
  const [newType, setNewType] = useState('Individual');
  const dests = household.destinations || [];
  const sfid = household.source_folder_id;
  const toOpen = dests.filter(d => d.needs_to_be_opened).length;
  const menuItem = "block w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50";

  return (
    <div className="mb-6">
      <button onClick={() => setOpen(o => !o)} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-left text-base font-semibold text-slate-900 mb-3">
        <ChevronRight className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Briefcase className="w-5 h-5 text-slate-500" />
        Accounts to be opened at Apex
        <span className="ml-1 text-[10px] font-bold uppercase tracking-wider bg-blue-100 text-blue-800 rounded px-2 py-0.5">New</span>
        <span className="ml-2 text-xs font-normal text-slate-400">{dests.length} destinations · {toOpen} to open</span>
      </button>
      {open && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-2">
          <div className="flex items-center justify-between px-2 py-2 gap-2 flex-wrap">
            <span className="text-xs text-slate-500 flex items-center gap-1.5"><Activity className="w-3.5 h-3.5" /> Suggestions checked against each owner's open accounts at Apex</span>
            <button onClick={() => setAdding(a => !a)} className="flex items-center gap-1.5 text-sm border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50 text-slate-700">+ Add new account</button>
          </div>
          {adding && (
            <div className="flex items-center gap-2 px-2 pb-2 flex-wrap">
              <input value={newOwner} onChange={e => setNewOwner(e.target.value)} placeholder="Owner name" className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
              <select value={newType} onChange={e => setNewType(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                {ATO_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <button onClick={() => { onAddDestination(sfid, newOwner, newType); setAdding(false); setNewOwner(''); }} className="text-sm bg-slate-900 text-white rounded-lg px-3 py-1.5">Add</button>
            </div>
          )}
          {dests.length === 0 && <p className="px-3 py-6 text-center text-sm text-slate-400">No destinations yet — they auto-seed when the client is scanned.</p>}
          <div className="space-y-2">
            {dests.map(d => {
              const sug = d.suggestion || {};
              const existing = (sug.existing_count || 0) > 0;
              const apexNum = d.existing_apex_number || sug.suggested_apex_number;
              const sources = d.sources || [];
              const others = dests.filter(o => o.id !== d.id);
              const typeOptions = ATO_TYPES.includes(d.target_account_type) ? ATO_TYPES : [d.target_account_type, ...ATO_TYPES];
              return (
                <div key={d.id} className="border border-slate-200 rounded-xl p-4">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 font-semibold text-[15px]">
                      <Briefcase className="w-4 h-4 text-slate-500" />
                      <span>{d.owner || '—'} ·</span>
                      <Dropdown label={<span className="inline-flex items-center gap-1 text-blue-700 hover:underline decoration-dotted underline-offset-4" title="Change the account type to open">{d.target_account_type}<ChevronDown className="w-3 h-3 text-slate-400" /></span>} className="focus:outline-none">
                        {(close) => (<>
                          <div className="px-3 py-1.5 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-400">Account type to open</div>
                          {typeOptions.map(t => (
                            <button key={t} className={`${menuItem} ${t === d.target_account_type ? 'font-semibold bg-slate-50' : ''}`} onClick={() => { if (t !== d.target_account_type) onSetDestinationType(d.id, t); close(); }}>{t}</button>
                          ))}
                        </>)}
                      </Dropdown>
                      <span className="text-[11px] font-medium rounded px-2 py-0.5 bg-blue-100 text-blue-800">{d.needs_to_be_opened ? 'new account' : (apexNum ? `existing · ${apexNum}` : 'existing')}</span>
                    </div>
                    <Dropdown label={<NeedsPill needs={d.needs_to_be_opened} />} className="focus:outline-none hover:opacity-80">
                      {(close) => (<>
                        <div className="px-3 py-1.5 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-400">Needs to be opened?</div>
                        <button className={menuItem} onClick={() => { onNeedsToOpen(d.id, true); close(); }}>Yes — new account</button>
                        <button className={menuItem} onClick={() => { onNeedsToOpen(d.id, false); close(); }}>No — use existing</button>
                      </>)}
                    </Dropdown>
                  </div>

                  {existing
                    ? <div className="mt-2.5 flex items-center gap-1.5 text-xs bg-green-100 text-green-800 rounded-lg px-2.5 py-1.5"><CheckCircle className="w-3.5 h-3.5" /> {sug.existing_count > 1 ? `${sug.existing_count} existing ${d.target_account_type} accounts found — pick one` : `Existing ${d.target_account_type} account found${apexNum ? ` — ${apexNum}` : ''}`}</div>
                    : <div className="mt-2.5 flex items-center gap-1.5 text-xs bg-slate-50 border border-slate-200 text-slate-500 rounded-lg px-2.5 py-1.5"><Minus className="w-3.5 h-3.5" /> No open {d.target_account_type} account for {d.owner || 'this owner'} — suggest opening a new one</div>}

                  <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-500"><ChevronRight className="w-3.5 h-3.5 rotate-90" /> fed by {sources.length} source account{sources.length === 1 ? '' : 's'}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {sources.map(s => (
                      <span key={s.link_id} className="inline-flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-[13px]">
                        <FileText className="w-3.5 h-3.5 text-slate-500" />
                        {s.custodian || '—'} <span className="font-mono text-xs text-slate-500">{s.account_number || ''}</span>
                        <Dropdown label={<span className="inline-flex items-center gap-1 text-[11px] text-slate-400 border-l border-slate-200 pl-2"><Link2 className="w-3 h-3" /> move</span>} className="focus:outline-none hover:opacity-80">
                          {(close) => (<>
                            <div className="px-3 py-1.5 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-400">Move to destination</div>
                            {others.map(o => (
                              <button key={o.id} className={menuItem} onClick={() => { onReassignSource(s.link_id, { target_account_id: o.id }); close(); }}>{o.owner} · {o.target_account_type}</button>
                            ))}
                            <button className={`${menuItem} text-blue-700 border-t border-slate-100`} onClick={() => { onReassignSource(s.link_id, { source_folder_id: household.source_folder_id, new_owner: d.owner, new_target_account_type: 'Individual' }); close(); }}>+ New account…</button>
                          </>)}
                        </Dropdown>
                      </span>
                    ))}
                  </div>

                  <div className="mt-3 text-right">
                    <button onClick={() => onDeleteDestination(d.id)} className="text-xs text-slate-400 hover:text-red-600 inline-flex items-center gap-1"><Trash2 className="w-3 h-3" /> remove destination</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function OpsView({ household, onStatusChange, updatingPositionId, onTransferringChange, updatingTransferringId, onDeletePosition, onDeleteAccount, onAccountTypeChange, updatingAccountId, onNeedsToOpen, onSetDestinationType, onReassignSource, onAddDestination, onDeleteDestination, token, householdId, refreshHousehold }) {
  const { demo } = useContext(DemoContext);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [driveSaving, setDriveSaving] = useState(false);
  const [driveSaved, setDriveSaved] = useState(null);
  const [collapsedAccounts, setCollapsedAccounts] = useState(new Set());
  const toggleAccount = (id) => setCollapsedAccounts(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const [expandedLots, setExpandedLots] = useState(new Set());
  const toggleLots = (id) => setExpandedLots(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // Map each source account to the destination it currently feeds. Sources and
  // account rows are masked with the same _mask_account_number, so we match on
  // (custodian, account_number) — the same key links use server-side.
  const dests = household.destinations || [];
  const linkForAccount = (acc) => {
    for (const d of dests) {
      const s = (d.sources || []).find(s =>
        (s.custodian || '') === (acc.custodian || '') &&
        (s.account_number || '') === (acc.account_number || ''));
      if (s) return { linkId: s.link_id, dest: d };
    }
    return null;
  };

  const metrics = useMemo(() => {
    let acat = 0, liq = 0, blk = 0, rev = 0, trn = 0;
    (household.accounts || []).forEach(acc => {
      (acc.assets || []).forEach(asset => {
        const s = asset.effective_status || asset.transfer_eligible;
        if (s === 'ACAT') acat++;
        else if (s === 'LIQUIDATE') liq++;
        else if (s === 'UNSUPPORTED') blk++;
        else if (s === 'REVIEW') rev++;
        else if (s === 'ACH/WIRE') trn++;
      });
    });
    return { acat, liq, blk, rev, trn };
  }, [household]);

  const totalPositions = metrics.acat + metrics.liq + metrics.blk + metrics.rev + metrics.trn;

  return (
    <div className="space-y-8">
      <DocIngestionPanel household={household} />

      <div className="flex justify-end space-x-3">
        <button
          onClick={() => exportHouseholdCSV(household)}
          className="flex items-center space-x-2 px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 hover:border-slate-300 shadow-sm transition-colors"
        >
          <Download className="w-4 h-4" />
          <span>Export CSV</span>
        </button>
        <button
          onClick={async () => {
            setPdfLoading(true);
            try { await exportHouseholdPDF(householdId, household.client_name, token); }
            catch (err) { alert(`PDF export failed: ${err.message}`); }
            finally { setPdfLoading(false); }
          }}
          disabled={pdfLoading}
          className="flex items-center space-x-2 px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 hover:border-slate-300 shadow-sm transition-colors disabled:opacity-50"
        >
          {pdfLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
          <span>{pdfLoading ? 'Generating…' : 'Export PDF'}</span>
        </button>
        {(() => {
          const reviewedAt = household.reviewed_at ? new Date(household.reviewed_at) : null;
          const updatedAt = household.updated_at ? new Date(household.updated_at) : null;
          const isStale = !reviewedAt || (updatedAt && updatedAt > reviewedAt);
          const reviewerShort = (household.reviewed_by || '').split('@')[0] || 'ops';
          const fmtCompact = (d) => d.toLocaleString('en-US', {
            month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true,
            timeZone: 'America/New_York',
          });
          const fmtFull = (d) => d.toLocaleString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true,
            timeZone: 'America/New_York', timeZoneName: 'short',
          });
          const completedLabel = reviewedAt
            ? `Reviewed by ${reviewerShort} at ${fmtCompact(reviewedAt)}`
            : 'Reviewed';
          const completedTitle = reviewedAt
            ? `Reviewed by ${household.reviewed_by} at ${fmtFull(reviewedAt)}`
            : '';
          return (
            <button
              onClick={async () => {
                setDriveSaving(true);
                try {
                  const res = await saveHouseholdToDrive(householdId, token);
                  setDriveSaved({ link: res.web_view_link, filename: res.filename });
                  setTimeout(() => setDriveSaved(null), 8000);
                  await refreshHousehold();
                } catch (err) {
                  alert(`Mark as Completed failed: ${err.message}`);
                } finally {
                  setDriveSaving(false);
                }
              }}
              disabled={driveSaving || !isStale}
              title={!isStale ? completedTitle : ''}
              className={`flex items-center space-x-2 px-4 py-2 text-sm font-medium rounded-lg shadow-sm transition-colors disabled:cursor-not-allowed ${
                !isStale
                  ? 'text-green-700 bg-green-50 border border-green-200 disabled:opacity-100'
                  : 'text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 disabled:opacity-50'
              }`}
            >
              {driveSaving
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <CheckCircle className={`w-4 h-4 ${!isStale ? 'text-green-600' : ''}`} />}
              <span>
                {driveSaving ? 'Saving…' : (isStale ? 'Mark as Completed' : completedLabel)}
              </span>
            </button>
          );
        })()}
      </div>

      {driveSaved && (
        <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:bottom-6 sm:right-6 bg-white border border-green-200 rounded-lg shadow-lg p-4 flex items-center space-x-3 z-50">
          <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-900">{demo ? 'Saved to Drive (kept in the Outbox)' : 'Saved to Drive'}</p>
            <p className="text-xs text-slate-500 truncate max-w-[280px]">{driveSaved.filename}</p>
          </div>
          {driveSaved.link && (
            <a
              href={driveSaved.link}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 whitespace-nowrap"
            >
              Open in Drive
            </a>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 md:gap-4">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <p className="text-sm font-medium text-slate-500 mb-1">Total Positions</p>
          <p className="text-2xl font-bold">{totalPositions}</p>
        </div>
        <div className="bg-white p-4 rounded-xl border border-green-200 shadow-sm">
          <p className="text-sm font-medium text-green-700 mb-1">ACAT Eligible</p>
          <p className="text-2xl font-bold text-green-700">{metrics.acat}</p>
        </div>
        <div className="bg-white p-4 rounded-xl border border-yellow-200 shadow-sm">
          <p className="text-sm font-medium text-yellow-700 mb-1">Manual Review</p>
          <p className="text-2xl font-bold text-yellow-700">{metrics.rev}</p>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-800 shadow-sm">
          <p className="text-sm font-medium text-slate-700 mb-1">Unsupported</p>
          <p className="text-2xl font-bold text-slate-800">{metrics.blk}</p>
        </div>
        <div className="bg-white p-4 rounded-xl border border-orange-200 shadow-sm">
          <p className="text-sm font-medium text-orange-700 mb-1">Liquidate</p>
          <p className="text-2xl font-bold text-orange-700">{metrics.liq}</p>
        </div>
      </div>

      <DestinationsPanel
        household={household}
        onNeedsToOpen={onNeedsToOpen}
        onSetDestinationType={onSetDestinationType}
        onReassignSource={onReassignSource}
        onAddDestination={onAddDestination}
        onDeleteDestination={onDeleteDestination}
      />

      <div className="space-y-6">
        {(household.accounts || []).map(acc => (
          <div key={acc.id} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="bg-slate-50 px-4 md:px-6 py-4 border-b border-slate-200 cursor-pointer select-none" onClick={() => toggleAccount(acc.id)}>
              <div className="flex flex-col gap-3 md:flex-row md:justify-between md:items-start">
                <div className="min-w-0">
                  <h3 className="text-lg font-bold flex items-center flex-wrap">
                    <ChevronRight className={`w-4 h-4 mr-2 text-slate-400 transition-transform ${!collapsedAccounts.has(acc.id) ? 'rotate-90' : ''}`} />
                    <span>{acc.custodian}</span>
                    <span className="mx-2 text-slate-300">|</span>
                    <InteractiveAccountTypeBadge
                      currentType={acc.account_type}
                      currentOther={acc.account_type_other}
                      onChange={(newType, otherText) => onAccountTypeChange(acc.id, newType, acc.account_type, otherText, acc.account_type_other)}
                      isUpdating={updatingAccountId === acc.id}
                    />
                    {acc.account_type_overridden_at && (
                      <span
                        className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-blue-700 bg-blue-50 border border-blue-200 rounded-full px-2 py-0.5"
                        title={`Manually overridden by ${acc.account_type_overridden_by || 'ops'} at ${acc.account_type_overridden_at}`}
                      >
                        Manual
                      </span>
                    )}
                    <span className="ml-3 text-sm font-normal text-slate-500">{acc.account_number}</span>
                    <ValidationBadge status={acc.validation_status} />
                    <StalenessBadge account={acc} />
                    <CostBasisBadge account={acc} />
                  </h3>
                  <OwnerLine account={acc} className="mt-1 ml-6" />
                  {acc.custodian_intel && (
                    <div className="mt-2 flex items-center space-x-4 text-xs font-mono text-slate-500">
                      <span className="flex items-center"><ShieldAlert className="w-3 h-3 mr-1 text-slate-400" /> DTCC: {acc.custodian_intel.dtcc_number || 'N/A'}</span>
                      <span className="flex items-center"><Clock className="w-3 h-3 mr-1 text-slate-400" /> {acc.custodian_intel.acat_timeline || 'Unknown'}</span>
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {(() => {
                    const xfer = linkForAccount(acc);
                    if (!xfer) return null;
                    const menuItem = "block w-full text-left px-3 py-2 text-sm hover:bg-slate-50";
                    return (
                      <span onClick={(e) => e.stopPropagation()}>
                        <Dropdown
                          label={<span className="inline-flex items-center gap-1.5 text-sm border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50 text-slate-700 whitespace-nowrap"><ArrowRight className="w-3.5 h-3.5 text-slate-400" /> Transfers to: {xfer.dest.owner || '—'} · {xfer.dest.target_account_type} <ChevronDown className="w-3 h-3 text-slate-400" /></span>}
                          className="focus:outline-none"
                        >
                          {(close) => (<>
                            <div className="px-3 py-1.5 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-400">Transfers to</div>
                            {dests.map(o => {
                              const apex = o.existing_apex_number || (o.suggestion || {}).suggested_apex_number;
                              const isCurrent = o.id === xfer.dest.id;
                              return (
                                <button key={o.id} className={`${menuItem} ${isCurrent ? 'text-slate-900 font-semibold bg-slate-50' : 'text-slate-700'}`} onClick={() => { if (!isCurrent) onReassignSource(xfer.linkId, { target_account_id: o.id }); close(); }}>
                                  {o.owner || '—'} · {o.target_account_type}{apex ? ` (${apex})` : ''}
                                </button>
                              );
                            })}
                            <button className={`${menuItem} text-blue-700 border-t border-slate-100`} onClick={() => { onReassignSource(xfer.linkId, { source_folder_id: household.source_folder_id, new_owner: xfer.dest.owner, new_target_account_type: 'Individual' }); close(); }}>+ New account…</button>
                          </>)}
                        </Dropdown>
                      </span>
                    );
                  })()}
                  <div className="text-right">
                    <p className="font-bold text-lg">{formatCurrency(acc.total_value)}</p>
                  </div>
                  {onDeleteAccount && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeleteAccount(acc.id, `${acc.custodian} ${acc.account_type}`); }}
                      className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      title="Delete this account"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {acc.validation_status === 'WARNING' && acc.validation_issues && (
                <div className="mt-4 bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded-md text-sm">
                  <p className="font-bold text-xs uppercase tracking-wider text-yellow-700 mb-1">Extraction Validation Warning</p>
                  <ul className="space-y-1">
                    {(acc.validation_issues || []).map((issue, i) => (
                      <li key={i} className="flex items-start">
                        <AlertTriangle className="w-3 h-3 mr-1.5 mt-0.5 flex-shrink-0 text-yellow-500" />
                        {issue}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(acc.cost_basis_status === 'PARTIAL' || acc.cost_basis_status === 'MISSING') && (() => {
                const missing = (acc.assets || [])
                  .filter(a => !isCashAsset(a) && !hasCostBasis(a))
                  .map(a => a.symbol || a.description || '?');
                const securities = (acc.assets || []).filter(a => !isCashAsset(a)).length;
                if (!missing.length) return null;
                return (
                  <div className="mt-4 bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-md text-sm flex items-start">
                    <HelpCircle className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0 text-amber-500" />
                    <span>
                      Cost basis missing for {missing.length} of {securities} securities: <span className="font-semibold">{missing.slice(0, 12).join(', ')}{missing.length > 12 ? `, +${missing.length - 12} more` : ''}</span>. The tax transition analysis will treat these as unknown basis.
                    </span>
                  </div>
                );
              })()}

              {acc.is_rollover && (
                <div className="mt-4 bg-blue-50 border border-blue-200 text-blue-800 px-4 py-3 rounded-md text-sm flex items-start">
                  <Activity className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0 text-blue-500" />
                  <span>{acc.rollover_note || 'Rollover account — all assets will be liquidated and transferred as cash.'}</span>
                </div>
              )}

              {acc.is_inherited && (
                <div className="mt-4 bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-md text-sm flex items-start">
                  <AlertTriangle className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0 text-amber-500" />
                  <div>
                    <span className="font-bold text-amber-700 uppercase tracking-wider text-xs block mb-0.5">Inherited / Beneficiary Account</span>
                    {acc.inherited_note || 'Inherited account — requires manual review due to potential titling issues that prevent standard ACAT transfer.'}
                  </div>
                </div>
              )}

              {acc.apex_restriction && (
                <div className="mt-4 bg-slate-800 border border-slate-900 text-white px-4 py-3 rounded-md text-sm flex items-start shadow-inner">
                  <Ban className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0 text-red-400" />
                  <div>
                    <span className="font-bold text-[#fca5a5] uppercase tracking-wider text-xs block mb-0.5">Apex Policy Engine Hard-Block</span>
                    {acc.apex_restriction}
                  </div>
                </div>
              )}
            </div>

            {!collapsedAccounts.has(acc.id) && (() => {
              // Always show the cost-basis column except on explicitly
              // tax-advantaged accounts (NOT_APPLICABLE), where basis is
              // irrelevant. Taxable and older/un-scanned accounts show the
              // column with a "not provided" indicator where basis is absent.
              const showCB = acc.cost_basis_status !== 'NOT_APPLICABLE';
              const colCount = 7 + (showCB ? 1 : 0) + (onDeletePosition ? 1 : 0);
              return <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-white border-b border-slate-200 text-slate-500 uppercase text-xs tracking-wider">
                  <tr>
                    <th className="px-6 py-3 font-medium">Extracted Asset</th>
                    <th className="px-6 py-3 font-medium text-right">Shares</th>
                    <th className="px-6 py-3 font-medium text-right">Value</th>
                    {showCB && <th className="px-6 py-3 font-medium text-right">Cost Basis</th>}
                    <th className="px-6 py-3 font-medium">Classification</th>
                    <th className="px-6 py-3 font-medium">Rule Engine Status</th>
                    <th className="px-6 py-3 font-medium">Transferring?</th>
                    <th className="px-6 py-3 font-medium w-1/4">Routing Logic Applied</th>
                    {onDeletePosition && <th className="px-3 py-3 font-medium w-10"></th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(acc.assets || []).map(asset => {
                    const effectiveStatus = asset.effective_status || asset.transfer_eligible;
                    const effectiveNotes = asset.effective_notes || asset.transfer_notes;
                    const lots = asset.lots || [];
                    const lotsOpen = expandedLots.has(asset.id);
                    return (
                      <React.Fragment key={asset.id}>
                      <tr className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-start">
                            {showCB && lots.length > 0 && (
                              <button
                                onClick={() => toggleLots(asset.id)}
                                className="mr-1.5 mt-0.5 text-slate-400 hover:text-slate-700"
                                title={lotsOpen ? 'Hide tax lots' : `Show ${lots.length} tax lots`}
                              >
                                <ChevronRight className={`w-3.5 h-3.5 transition-transform ${lotsOpen ? 'rotate-90' : ''}`} />
                              </button>
                            )}
                            <div>
                              <p className="font-bold text-slate-900">{asset.symbol || '—'}</p>
                              <p className="text-slate-500 text-xs whitespace-normal break-words">{asset.description || ''}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-right font-mono text-slate-600">
                          {asset.quantity != null ? parseFloat(asset.quantity).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 }) : '—'}
                        </td>
                        <td className="px-6 py-4 text-right font-medium">{formatCurrency(asset.market_value)}</td>
                        {showCB && (
                          <td className="px-6 py-4 text-right">
                            {asset.cost_basis != null ? (
                              <>
                                <div className="font-medium text-slate-700">{formatCurrency(asset.cost_basis)}</div>
                                <GranularityPill asset={asset} />
                              </>
                            ) : !isCashAsset(asset) ? (
                              <span className="inline-flex items-center gap-1 text-amber-700 text-xs"><HelpCircle className="w-3 h-3" />not provided</span>
                            ) : <span className="text-slate-300">—</span>}
                          </td>
                        )}
                        <td className="px-6 py-4 text-slate-500">{asset.asset_type || asset.type || '—'}</td>
                        <td className="px-6 py-4">
                          <InteractiveStatusBadge
                            currentStatus={effectiveStatus}
                            onChange={(newStatus) => onStatusChange(asset.id, newStatus)}
                            isUpdating={updatingPositionId === asset.id}
                          />
                        </td>
                        <td className="px-6 py-4">
                          <InteractiveTransferringBadge
                            value={asset.transferring}
                            onChange={(val) => onTransferringChange(asset.id, val)}
                            isUpdating={updatingTransferringId === asset.id}
                          />
                        </td>
                        <td className="px-6 py-4 text-xs text-slate-600 font-medium">
                          {effectiveNotes || <span className="text-slate-300 italic">Clear</span>}
                        </td>
                        {onDeletePosition && (
                          <td className="px-3 py-4">
                            <button
                              onClick={() => onDeletePosition(asset.id, asset.symbol || asset.description || 'position')}
                              className="p-1.5 text-slate-300 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                              title="Delete this position"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        )}
                      </tr>
                      {showCB && lotsOpen && lots.length > 0 && (
                        <tr className="bg-slate-50/60">
                          <td colSpan={colCount} className="px-6 pb-4 pt-1">
                            <div className="bg-white border border-slate-200 rounded-lg px-4 py-3">
                              <p className="text-[10px] uppercase tracking-wider font-bold text-slate-400 mb-2">Tax lots (as printed on statement)</p>
                              <table className="w-full text-xs">
                                <tbody className="text-slate-600">
                                  {lots.map((lot, i) => {
                                    const term = lotTerm(lot.acquisition_date, acc.statement_date);
                                    return (
                                      <tr key={i}>
                                        <td className="py-1">Acquired {lot.acquisition_date || '—'}</td>
                                        <td className="py-1 text-right font-mono">{lot.quantity != null ? parseFloat(lot.quantity).toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—'} sh</td>
                                        <td className="py-1 text-right">basis {lot.cost_basis != null ? formatCurrency(lot.cost_basis) : '—'}</td>
                                        <td className="py-1 text-right">
                                          {term === 'long' ? <span className="text-blue-700">long-term</span>
                                            : term === 'short' ? <span className="text-amber-700">short-term</span>
                                            : <span className="text-slate-300">—</span>}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>;
            })()}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advisor view
// ---------------------------------------------------------------------------

function AdvisorView({ household, token, householdId, isOps = false }) {
  const { demo } = useContext(DemoContext);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [driveSaving, setDriveSaving] = useState(false);
  const [driveSaved, setDriveSaved] = useState(null);
  const [expandedAccounts, setExpandedAccounts] = useState(new Set());
  const toggleExpand = (id) => setExpandedAccounts(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const summarizePositions = (assets) => {
    const counts = {};
    assets.forEach(a => {
      const s = a.effective_status || a.transfer_eligible;
      counts[s] = (counts[s] || 0) + 1;
    });
    const total = assets.length;
    const breakdown = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ');
    return `${total} position${total !== 1 ? 's' : ''}: ${breakdown}`;
  };

  const readyItems = [];
  const rolloverItems = [];
  const actionItems = [];
  const unsupportedItems = [];

  const hasAnyWarning = (household.accounts || []).some(a => a.validation_status === 'WARNING');
  const rejectedDocs = (household.doc_results || []).filter(d => d.status === 'rejected' || d.status === 'stale');

  (household.accounts || []).forEach(acc => {
    const hasAccountIssue = acc.apex_restriction != null;
    const hasValidationWarning = acc.validation_status === 'WARNING';
    const problemAssets = (acc.assets || []).filter(a => {
      const s = a.effective_status || a.transfer_eligible;
      return s !== 'ACAT';
    });

    if (hasAccountIssue) {
      unsupportedItems.push({ ...acc, problemAssets });
    } else if (acc.is_rollover) {
      rolloverItems.push({ ...acc, problemAssets });
    } else if (hasValidationWarning) {
      actionItems.push({ ...acc, problemAssets, isValidationWarning: true });
    } else if (problemAssets.length === 0) {
      readyItems.push(acc);
    } else {
      actionItems.push({ ...acc, problemAssets });
    }
  });

  const transferReadyValue = (household.accounts || []).reduce((sum, acc) => {
    if (acc.is_rollover || acc.validation_status === 'WARNING') return sum;
    const acatValue = (acc.assets || [])
      .filter(a => (a.effective_status || a.transfer_eligible) === 'ACAT')
      .reduce((s, a) => s + toNum(a.market_value), 0);
    return sum + acatValue;
  }, 0);

  const rolloverValue = rolloverItems.reduce((sum, acc) => sum + toNum(acc.total_value), 0);

  const totalValue = (household.accounts || []).reduce((sum, acc) => sum + toNum(acc.total_value), 0) || 1;
  const percentReady = Math.round((transferReadyValue / totalValue) * 100);

  return (
    <div className="space-y-8">

      <div className="bg-gradient-to-br from-[#1e3a8a] to-[#0f172a] rounded-2xl p-5 md:p-8 text-white shadow-lg">
        <div className="flex flex-col gap-4 md:flex-row md:justify-between md:items-center mb-6">
          <div>
            <h3 className="text-2xl font-bold mb-2">Transfer Readiness</h3>
            <p className="text-[#bfdbfe] max-w-lg">
              {percentReady}% of the household value is ready for ACAT transfer.
              {rolloverItems.length > 0 && ` ${rolloverItems.length} account(s) require a rollover.`}
              {actionItems.length > 0 && ` ${actionItems.length} account(s) need review.`}
              {unsupportedItems.length > 0 && ` ${unsupportedItems.length} unsupported.`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 flex-shrink-0">
            <button
              onClick={async () => {
                setPdfLoading(true);
                try { await exportHouseholdPDF(householdId, household.client_name, token); }
                catch (err) { alert(`PDF export failed: ${err.message}`); }
                finally { setPdfLoading(false); }
              }}
              disabled={pdfLoading}
              className="flex items-center space-x-2 px-4 py-2.5 text-sm font-medium bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg transition-colors disabled:opacity-50"
            >
              {pdfLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
              <span>{pdfLoading ? 'Generating…' : 'Export PDF'}</span>
            </button>
            {isOps && (
              <button
                onClick={async () => {
                  setDriveSaving(true);
                  try {
                    const res = await saveHouseholdToDrive(householdId, token);
                    setDriveSaved({ link: res.web_view_link, filename: res.filename });
                    setTimeout(() => setDriveSaved(null), 8000);
                  } catch (err) {
                    alert(`Save to Drive failed: ${err.message}`);
                  } finally {
                    setDriveSaving(false);
                  }
                }}
                disabled={driveSaving}
                className="flex items-center space-x-2 px-4 py-2.5 text-sm font-medium bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg transition-colors disabled:opacity-50"
              >
                {driveSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cloud className="w-4 h-4" />}
                <span>{driveSaving ? 'Saving…' : 'Save to Drive'}</span>
              </button>
            )}
          </div>
        </div>
        {driveSaved && (
          <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:bottom-6 sm:right-6 bg-white border border-green-200 rounded-lg shadow-lg p-4 flex items-center space-x-3 z-50">
            <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-900">{demo ? 'Saved to Drive (kept in the Outbox)' : 'Saved to Drive'}</p>
              <p className="text-xs text-slate-500 truncate max-w-[280px]">{driveSaved.filename}</p>
            </div>
            {driveSaved.link && (
              <a
                href={driveSaved.link}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-2 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 whitespace-nowrap"
              >
                Open in Drive
              </a>
            )}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-white/10 p-5 rounded-xl border border-white/20 backdrop-blur-sm">
            <p className="text-sm uppercase tracking-wider text-[#bfdbfe] font-bold mb-1">Ready to ACAT</p>
            <p className="text-2xl md:text-3xl font-extrabold text-green-400">{formatCurrency(transferReadyValue)}</p>
          </div>
          {rolloverItems.length > 0 && (
            <div className="bg-white/10 p-5 rounded-xl border border-white/20 backdrop-blur-sm">
              <p className="text-sm uppercase tracking-wider text-[#bfdbfe] font-bold mb-1">Requires Rollover</p>
              <p className="text-2xl md:text-3xl font-extrabold text-purple-400">{formatCurrency(rolloverValue)}</p>
            </div>
          )}
        </div>
      </div>

      {/* Extraction Quality Notice */}
      {hasAnyWarning && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-5 flex items-start">
          <AlertTriangle className="w-5 h-5 text-yellow-500 mr-3 mt-0.5 flex-shrink-0" />
          <div>
            <h4 className="font-bold text-yellow-800 text-sm mb-1">Extraction Quality Notice</h4>
            <p className="text-yellow-700 text-sm">
              One or more accounts have data quality warnings (e.g., value mismatches between
              reported totals and extracted positions). These accounts appear under Action Plan
              below and should be verified before proceeding.
            </p>
          </div>
        </div>
      )}

      {/* Ready accounts */}
      <div>
        <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center">
          <CheckCircle className="w-5 h-5 text-green-500 mr-2" />
          Ready for ACAT Transfer
        </h3>
        {readyItems.length === 0 ? (
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 text-center text-slate-500">
            No accounts are fully ready for automated ACAT transfer.
          </div>
        ) : (
          <div className="space-y-4">
            {readyItems.map(acc => (
              <div key={acc.id} className="bg-white border-l-4 border-l-green-400 border border-slate-200 shadow-sm p-5 rounded-r-xl flex flex-col sm:flex-row sm:justify-between sm:items-center">
                <div className="mb-2 sm:mb-0">
                  <h4 className="font-bold text-lg text-slate-900">
                    {acc.custodian} {acctTypeLabel(acc)} <span className="text-slate-400 font-normal">({acc.account_number})</span>
                  </h4>
                  <OwnerLine account={acc} className="mt-1" />
                  <p className="text-sm text-slate-500 mt-1 flex items-center">
                    <CheckCircle className="w-4 h-4 mr-1 text-green-500" /> All assets cleared — submit ACAT transfer
                  </p>
                </div>
                <div className="sm:text-right">
                  <p className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-0.5">Account Value</p>
                  <p className="font-bold text-lg text-slate-900">{formatCurrency(acc.total_value)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Rollover accounts */}
      {rolloverItems.length > 0 && (
        <div>
          <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center">
            <RefreshCw className="w-5 h-5 text-purple-500 mr-2" />
            Rollover Required
          </h3>
          <div className="space-y-4">
            {rolloverItems.map(acc => (
              <div key={acc.id} className="bg-white border-l-4 border-l-purple-400 border border-slate-200 shadow-sm p-6 rounded-r-xl">
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start mb-4">
                  <div>
                    <h4 className="font-bold text-lg text-slate-900">
                      {acc.custodian} {acctTypeLabel(acc)} <span className="text-slate-400 font-normal">({acc.account_number})</span>
                    </h4>
                    <OwnerLine account={acc} className="mt-1" />
                    <p className="text-sm text-purple-700 mt-1 flex items-center font-medium">
                      <RefreshCw className="w-4 h-4 mr-1.5 text-purple-500" />
                      This account must be rolled over to an IRA before assets can transfer
                    </p>
                  </div>
                  <div className="sm:text-right mt-2 sm:mt-0">
                    <p className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-0.5">Account Value</p>
                    <p className="font-bold text-lg text-slate-900">{formatCurrency(acc.total_value)}</p>
                  </div>
                </div>
                {acc.rollover_note && (
                  <div className="mb-4 bg-purple-50 border border-purple-200 text-purple-800 px-4 py-3 rounded-md text-sm flex items-start">
                    <Activity className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0 text-purple-500" />
                    <span>{acc.rollover_note}</span>
                  </div>
                )}
                <div className="bg-slate-50 rounded-lg p-4 border border-slate-100">
                  <h5 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
                    Assets to Roll Over ({(acc.assets || []).length} positions)
                  </h5>
                  <div className="space-y-2">
                    {(acc.assets || []).slice(0, 5).map(asset => (
                      <div key={asset.id} className="flex justify-between items-center text-sm">
                        <span className="font-medium text-slate-700">{asset.symbol || '—'} <span className="text-slate-400 font-normal">— {(asset.description || '').slice(0, 40)}</span></span>
                        <span className="font-medium text-slate-900">{formatCurrency(asset.market_value)}</span>
                      </div>
                    ))}
                    {(acc.assets || []).length > 5 && (
                      <p className="text-xs text-slate-400 italic">+ {(acc.assets || []).length - 5} more positions</p>
                    )}
                  </div>
                </div>
                {acc.problemAssets.length > 0 && (
                  <div className="mt-4 bg-yellow-50 rounded-lg p-4 border border-yellow-100">
                    <h5 className="text-xs font-bold uppercase tracking-wider text-yellow-700 mb-3">Exceptions Within This Account</h5>
                    <ul className="space-y-2">
                      {acc.problemAssets.map(asset => {
                        const s = asset.effective_status || asset.transfer_eligible;
                        const n = asset.effective_notes || asset.transfer_notes;
                        return (
                          <li key={asset.id} className="flex items-start justify-between text-sm">
                            <div className="flex items-start space-x-2">
                              <StatusBadge status={s} />
                              <span className="font-medium text-slate-700">{asset.symbol || '—'}</span>
                            </div>
                            <span className="text-xs text-slate-500 max-w-[50%] text-right">{n}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action items */}
      <div>
        <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center">
          <AlertTriangle className="w-5 h-5 text-yellow-500 mr-2" />
          Action Plan (Exceptions &amp; Manual Items)
        </h3>
        {actionItems.length === 0 ? (
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 text-center text-slate-500">
            No accounts require manual action or review.
          </div>
        ) : (
          <div className="space-y-4">
            {actionItems.map(acc => {
              const isExpanded = expandedAccounts.has(acc.id);
              return (
              <div key={acc.id} className="bg-white border-l-4 border-l-yellow-400 border border-slate-200 shadow-sm rounded-r-xl">
                <div className="p-6 cursor-pointer select-none" onClick={() => toggleExpand(acc.id)}>
                  <h4 className="font-bold text-lg text-slate-900 flex items-center">
                    <ChevronRight className={`w-4 h-4 mr-2 text-slate-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                    {acc.custodian} {acctTypeLabel(acc)} <span className="text-slate-400 font-normal ml-1">({acc.account_number})</span>
                    <ValidationBadge status={acc.validation_status} />
                    <StalenessBadge account={acc} />
                  </h4>
                  <OwnerLine account={acc} className="mt-1 ml-6" />
                  {!isExpanded && acc.problemAssets.length > 0 && (
                    <p className="text-sm text-slate-500 mt-1 ml-6">{summarizePositions(acc.problemAssets)}</p>
                  )}
                </div>
                {isExpanded && (
                  <div className="px-6 pb-6">
                    {acc.isValidationWarning && acc.validation_issues && (
                      <div className="mb-4 bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded-md text-sm">
                        <p className="font-bold text-xs uppercase tracking-wider text-yellow-700 mb-1">Data Quality Warning</p>
                        <ul className="space-y-1">
                          {(acc.validation_issues || []).map((issue, i) => (
                            <li key={i}>{issue}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {acc.problemAssets.length > 0 && (
                      <div className="bg-slate-50 rounded-lg p-4 border border-slate-100">
                        <h5 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Items Caught by Rule Engine</h5>
                        <ul className="space-y-3">
                          {acc.problemAssets.map(asset => {
                            const s = asset.effective_status || asset.transfer_eligible;
                            const n = asset.effective_notes || asset.transfer_notes;
                            return (
                              <li key={asset.id} className="flex items-start justify-between">
                                <div className="flex items-start space-x-3">
                                  <div className="mt-0.5"><StatusBadge status={s} /></div>
                                  <div>
                                    <p className="font-bold text-sm text-slate-900">{asset.symbol} <span className="text-slate-500 font-normal">— {asset.description}</span></p>
                                    <p className="text-sm text-slate-600 mt-0.5">{n}</p>
                                  </div>
                                </div>
                                <span className="font-medium text-sm text-slate-900">{formatCurrency(asset.market_value)}</span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Unsupported */}
      {unsupportedItems.length > 0 && (
        <div>
          <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center">
            <Ban className="w-5 h-5 text-red-500 mr-2" />
            Unsupported Accounts
          </h3>
          <div className="space-y-4">
            {unsupportedItems.map(acc => {
              const isExpanded = expandedAccounts.has(acc.id);
              return (
              <div key={acc.id} className="bg-white border-l-4 border-l-slate-800 border border-slate-200 shadow-sm rounded-r-xl opacity-90">
                <div className="p-6 cursor-pointer select-none" onClick={() => toggleExpand(acc.id)}>
                  <h4 className="font-bold text-lg text-slate-900 line-through text-slate-500 flex items-center">
                    <ChevronRight className={`w-4 h-4 mr-2 text-slate-400 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`} />
                    {acc.custodian} {acctTypeLabel(acc)} <span className="text-slate-400 font-normal ml-1">({acc.account_number})</span>
                  </h4>
                  <OwnerLine account={acc} className="mt-1 ml-6" />
                  {acc.apex_restriction && (
                    <p className="text-red-700 font-medium text-sm flex items-center bg-red-50 inline-block px-2 py-1 rounded border border-red-100 mt-2 ml-6">
                      <Ban className="w-3 h-3 mr-1.5 text-red-500" />
                      Unsupported: {acc.apex_restriction}
                    </p>
                  )}
                  {!isExpanded && acc.problemAssets.length > 0 && (
                    <p className="text-sm text-slate-500 mt-1 ml-6">{summarizePositions(acc.problemAssets)}</p>
                  )}
                </div>
                {isExpanded && acc.problemAssets.length > 0 && (
                  <div className="px-6 pb-6">
                    <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                      <h5 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Assets in Unsupported Account</h5>
                      <ul className="space-y-3">
                        {acc.problemAssets.map(asset => {
                          const s = asset.effective_status || asset.transfer_eligible;
                          const n = asset.effective_notes || asset.transfer_notes;
                          return (
                            <li key={asset.id} className="flex items-start justify-between">
                              <div className="flex items-start space-x-3">
                                <div className="mt-0.5"><StatusBadge status={s} /></div>
                                <div>
                                  <p className="font-bold text-sm text-slate-900">{asset.symbol} <span className="text-slate-500 font-normal">— {asset.description}</span></p>
                                  <p className="text-sm text-slate-600 mt-0.5">{n}</p>
                                </div>
                              </div>
                              <span className="font-medium text-sm text-slate-900">{formatCurrency(asset.market_value)}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Documents Not Processed */}
      {rejectedDocs.length > 0 && (
        <div>
          <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center">
            <FileText className="w-5 h-5 text-slate-400 mr-2" />
            Documents Not Processed
          </h3>
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-5">
            <div className="space-y-2">
              {rejectedDocs.map((doc, idx) => (
                <div key={idx} className="flex items-center justify-between text-sm">
                  <span className="font-medium text-slate-600">{doc.filename}</span>
                  <div className="flex items-center space-x-2">
                    <span className="text-xs text-slate-500">{doc.reason}</span>
                    <span className={`px-2 py-0.5 text-[10px] font-bold uppercase rounded-full border ${
                      doc.status === 'rejected'
                        ? 'bg-red-50 text-red-700 border-red-200'
                        : 'bg-orange-50 text-orange-700 border-orange-200'
                    }`}>
                      {doc.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
