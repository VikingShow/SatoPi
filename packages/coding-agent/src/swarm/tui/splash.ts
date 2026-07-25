import { SATOPI_COLORS, PI_LOGO_ASCII, ansiFg, ansiBold, ansiDim } from "./theme";

const SATOPI_TEXT = ansiBold(ansiFg(SATOPI_COLORS.logoOrange.ansi256, "SatoPi"));
const TAGLINE = `${ansiDim("Satori a team of Pi")} ${ansiDim("·")} ${ansiDim("v0.0.1")}`;
const LOGO_WIDTH = 24; // width of PI_LOGO_ASCII lines in characters
const MIN_WIDTH = 50;

/**
 * Render the SatoPi brand splash screen.
 *
 * Left column: amber "SatoPi" text.
 * Right column: Pi ASCII art logo (PI_LOGO_ASCII).
 * Golden border with box-drawing characters.
 * Tagline below the box.
 *
 * @param width - Terminal width in columns (default 62, minimum 50).
 * @returns Array of ANSI-color-coded strings, one per line.
 */
export function renderSplash(width: number = 62): string[] {
  const w = Math.max(width, MIN_WIDTH);
  const innerW = w - 2; // space between border corners

  // Golden border ANSI code
  const borderColor = SATOPI_COLORS.primary.ansi256;

  // "SatoPi" text length (without ANSI escapes): 6
  const leftLabel = "SatoPi";
  // Right padding between "SatoPi" and the logo — at least 2 spaces
  const gap = Math.max(2, innerW - 2 - leftLabel.length - LOGO_WIDTH - 2);
  // Total content width used: 2 (left pad) + 6 (SatoPi) + gap + 22 (logo) + 2 (right pad)
  const contentWidth = 2 + leftLabel.length + gap + LOGO_WIDTH + 2;

  const lines: string[] = [];

  // Top border
  const topBorder = ansiFg(borderColor, `╔${"═".repeat(innerW)}╗`);
  lines.push(topBorder);

  // Empty line after top border
  lines.push(ansiFg(borderColor, `║${" ".repeat(innerW)}║`));

  // Build the content area: left label + spacing + logo
  const logoHeight = PI_LOGO_ASCII.length;
  const labelRow = Math.floor(logoHeight / 2); // center SatoPi vertically against logo

  for (let i = 0; i < logoHeight; i++) {
    const logoLine = PI_LOGO_ASCII[i];
    // Ensure logo line is exactly LOGO_WIDTH chars (pad or trim if needed)
    const logoPart = logoLine.length >= LOGO_WIDTH
      ? logoLine.substring(0, LOGO_WIDTH)
      : logoLine + " ".repeat(LOGO_WIDTH - logoLine.length);

    let leftPart: string;
    if (i === labelRow) {
      // Render "SatoPi" in amber bold on this row
      leftPart = `  ${SATOPI_TEXT}`;
    } else {
      leftPart = "        "; // 8 spaces = 2 pad + 6 for SatoPi text width
    }

    const gapStr = " ".repeat(gap);
    const rightPad = " ".repeat(innerW - (leftPart.replace(/\x1b\[[0-9;]*m/g, "").length + gapStr.length + LOGO_WIDTH));

    lines.push(
      ansiFg(borderColor, "║") +
      leftPart +
      gapStr +
      ansiDim(logoPart) +
      rightPad +
      ansiFg(borderColor, "║")
    );
  }

  // Empty line before bottom border
  lines.push(ansiFg(borderColor, `║${" ".repeat(innerW)}║`));

  // Bottom border
  const bottomBorder = ansiFg(borderColor, `╚${"═".repeat(innerW)}╝`);
  lines.push(bottomBorder);

  // Tagline below the box
  // Center the tagline relative to the border width
  const taglineRaw = "Satori a team of Pi · v0.0.1";
  const taglinePadding = Math.max(0, Math.floor((w - taglineRaw.length) / 2));
  lines.push(" ".repeat(taglinePadding) + TAGLINE);

  return lines;
}
