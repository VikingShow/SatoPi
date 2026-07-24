import { Product } from "./types";

// BUG: formatPrice is duplicated in pricing.ts and checkout.ts
export function formatPrice(cents: number): string {
  const dollars = (cents / 100).toFixed(2);
  return `$${dollars}`;
}

export function getLineItemDisplay(product: Product): string {
  return `${product.name}: ${formatPrice(product.price)}`;
}

export function checkoutSummary(items: Product[]): string[] {
  return items.map(getLineItemDisplay);
}
