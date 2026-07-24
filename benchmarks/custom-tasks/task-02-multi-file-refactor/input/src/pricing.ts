import { Product } from "./types";

// BUG: formatPrice is duplicated in pricing.ts and checkout.ts
export function formatPrice(cents: number): string {
  const dollars = (cents / 100).toFixed(2);
  return `$${dollars}`;
}

export function calculateTotal(products: Product[]): number {
  return products.reduce((sum, p) => sum + p.price, 0);
}

export function getProductPrice(product: Product): string {
  return formatPrice(product.price);
}
