import { useState, useRef, useEffect, useCallback, useDeferredValue } from 'react';

const PRESET_BENCHMARKS = [
  { value: 'URTH', label: 'URTH – MSCI World' },
  { value: 'SPY', label: 'SPY – S&P 500' },
  { value: 'IWB', label: 'IWB – Russell 1000' },
  { value: 'IWV', label: 'IWV – Russell 3000' },
  { value: 'ACWI', label: 'ACWI – MSCI All Country World' },
  { value: 'DIA', label: 'DIA – Dow Jones Industrial' },
  { value: 'QQQ', label: 'QQQ – Nasdaq 100' },
  { value: 'IWM', label: 'IWM – Russell 2000' },
  { value: 'SPMD', label: 'SPMD – S&P 400 Mid Cap' },
  { value: 'EQAL', label: 'EQAL – Russell 1000 Equal Weight' },
  { value: 'DBEF', label: 'DBEF – Developed ex-US Hedged' },
  { value: 'EFA', label: 'EFA – Developed International' },
  { value: 'EEM', label: 'EEM – Emerging Markets' },
  { value: 'IWD', label: 'IWD – Russell 1000 Value' },
];

interface Props {
  id: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function BenchmarkCombobox({ id, value, onChange, className = '' }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = `${id}-listbox`;

  const displayValue = value || '';
  const deferredSearch = useDeferredValue(search);
  const filtered = PRESET_BENCHMARKS.filter(
    (b) =>
      b.value.toLowerCase().includes(deferredSearch.toLowerCase()) ||
      b.label.toLowerCase().includes(deferredSearch.toLowerCase()),
  );

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    setActiveIndex(-1);
  }, [search]);

  const handleInputChange = (val: string) => {
    setSearch(val);
    onChange(val);
    if (!open) setOpen(true);
  };

  const handleSelect = useCallback(
    (val: string) => {
      onChange(val);
      setSearch('');
      setOpen(false);
      inputRef.current?.blur();
    },
    [onChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0 && filtered[activeIndex]) {
          handleSelect(filtered[activeIndex].value);
        }
        break;
      case 'Escape':
        setOpen(false);
        setSearch('');
        break;
    }
  };

  const activeDescendant =
    activeIndex >= 0 && filtered[activeIndex] ? `${listboxId}-option-${filtered[activeIndex].value}` : undefined;

  return (
    <div ref={wrapperRef} className="relative">
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeDescendant}
        aria-autocomplete="list"
        value={open ? search || displayValue : displayValue}
        onChange={(e) => handleInputChange(e.target.value)}
        onFocus={() => {
          setOpen(true);
          setSearch('');
        }}
        onKeyDown={handleKeyDown}
        placeholder="Search or type ticker..."
        className={className}
        autoComplete="off"
      />
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 w-full max-h-52 overflow-y-auto bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-lg"
        >
          {filtered.map((b, i) => (
            <li
              key={b.value}
              id={`${listboxId}-option-${b.value}`}
              role="option"
              aria-selected={b.value === value}
              aria-current={i === activeIndex ? true : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSelect(b.value)}
              className={`w-full text-left px-3 py-2 text-[13px] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer ${
                i === activeIndex
                  ? 'bg-[var(--bg-surface)] font-semibold text-[var(--text-primary)]'
                  : b.value === value
                    ? 'bg-[var(--bg-surface)] font-semibold text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)]'
              }`}
            >
              <span className="font-mono font-bold text-[var(--text-primary)]">{b.value}</span>
              <span className="text-[var(--text-muted)] ml-2">{b.label.split(' – ')[1] ?? ''}</span>
            </li>
          ))}
          {filtered.length === 0 && search && (
            <li className="px-3 py-2 text-[13px] text-[var(--text-muted)]" role="option" aria-selected={false}>
              Press Enter or click away to use "
              <span className="font-mono font-bold text-[var(--text-primary)]">{search}</span>"
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
