import { Product } from "./types";
import { formatPrice } from "./utils/price-formatter";

export function getLineItemDisplay(product: Product): string {
  return `${product.name}: ${formatPrice(product.price)}`;
}

export function checkoutSummary(items: Product[]): string[] {
  return items.map(getLineItemDisplay);
}
