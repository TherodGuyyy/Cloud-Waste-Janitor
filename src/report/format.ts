/** Small formatting helpers shared by the report writers. */

/** 1234.5 becomes "$1,234.50". Anything that is not a finite number becomes "n/a". */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return 'n/a';
  const negative = amount < 0;
  const [whole = '0', cents = '00'] = Math.abs(amount).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}.${cents}`;
}

/** Rounds to cents without floating-point noise (0.1 + 0.2 stays 0.3). */
export function roundCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? `1 ${singular}` : `${count} ${pluralForm}`;
}
