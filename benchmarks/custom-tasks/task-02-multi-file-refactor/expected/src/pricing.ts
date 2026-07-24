import { Product } from "./types";
import { formatPrice } from "./utils/price-formatter";

export function calculateTotal(products: Product[]): number {
  return products.reduce((sum, p) => sum + p.price, 0);
}

export function getProductPrice(product: Product): string {
  return formatPrice(product.price);
}
