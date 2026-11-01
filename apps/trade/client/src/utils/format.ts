const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) return '$0';
  return currencyFormatter.format(value);
}
