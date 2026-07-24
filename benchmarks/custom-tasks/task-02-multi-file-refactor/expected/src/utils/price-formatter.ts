/**
 * Shared price formatting utility.
 */
export function formatPrice(cents: number, locale: string = "en-US"): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
  }).format(dollars);
}
