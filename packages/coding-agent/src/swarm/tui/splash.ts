import { SATOPI_COLORS, PI_LOGO_ASCII, ansiFg, ansiBold, ansiDim } from "./theme";

const LOGO_WIDTH = 41; // width of PI_LOGO_ASCII lines
const LOGO_HEIGHT = PI_LOGO_ASCII.length; // 25
const MIN_WIDTH = 60;

/**
 * Render the SatoPi brand splash screen.
 *
 * Center: Pi logo ASCII art (rendered from hero.png).
 * "SatoPi" text above the logo in amber bold.
 * Tagline below the box.
 */
export function renderSplash(width: number = 80): string[] {
  const w = Math.max(width, MIN_WIDTH);
  const innerW = w - 2;
  const borderColor = SATOPI_COLORS.primary.ansi256;
  const lines: string[] = [];

  // Top border
  lines.push(ansiFg(borderColor, `╔${"═".repeat(innerW)}╗`));

  // Empty line
  lines.push(ansiFg(borderColor, `║${" ".repeat(innerW)}║`));

  // "SatoPi" centered — rendered above the logo
  const nameStr = "S a t o P i";
  const namePad = Math.floor((w - 8) / 2); // 8 = visible width of "S a t o P i"
  const nameLine = " ".repeat(Math.max(0, namePad - 6)) + ansiBold(ansiFg(SATOPI_COLORS.logoOrange.ansi256, nameStr));
  lines.push(ansiFg(borderColor, "║") + nameLine + " ".repeat(Math.max(0, innerW - (namePad + 8))) + ansiFg(borderColor, "║"));

  // Empty line between name and logo
  lines.push(ansiFg(borderColor, `║${" ".repeat(innerW)}║`));

  // Pi logo — centered horizontally
  const logoPadLeft = Math.floor((innerW - LOGO_WIDTH) / 2);
  for (const logoLine of PI_LOGO_ASCII) {
    const trimmed = logoLine.length > LOGO_WIDTH ? logoLine.substring(0, LOGO_WIDTH) : logoLine.padEnd(LOGO_WIDTH);
    const padRight = innerW - logoPadLeft - LOGO_WIDTH;
    lines.push(
      ansiFg(borderColor, "║") +
      " ".repeat(Math.max(0, logoPadLeft)) +
      ansiDim(trimmed) +
      " ".repeat(Math.max(0, padRight)) +
      ansiFg(borderColor, "║")
    );
  }

  // Empty line
  lines.push(ansiFg(borderColor, `║${" ".repeat(innerW)}║`));

  // Bottom border
  lines.push(ansiFg(borderColor, `╚${"═".repeat(innerW)}╝`));

  // Tagline below the box
  const tagline = "Satori a team of Pi · v0.0.1";
  const taglinePad = Math.max(0, Math.floor((w - tagline.length) / 2));
  lines.push(" ".repeat(taglinePad) + ansiDim(tagline));

  return lines;
}
