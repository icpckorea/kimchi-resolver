/**
 * Shared bits for the hand-written SVG icon set.
 * No external icon dependencies — every glyph in this directory is drawn by hand.
 */

export interface IconProps {
  /** Pixel size (or any CSS length). Square icons use it for both dimensions. */
  size?: number | string;
  className?: string;
  /** Accessible title. When omitted the icon is aria-hidden (decorative). */
  title?: string;
}

/** Join class names, skipping falsy values. */
export function cls(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(' ');
}

/**
 * Build a `points` attribute string for an N-pointed star polygon.
 * Vertices alternate between the outer and inner radius, starting at the
 * top (rotation -90°) unless overridden.
 */
export function starPoints(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  points: number,
  rotationDeg = -90,
): string {
  const step = Math.PI / points;
  const start = (rotationDeg * Math.PI) / 180;
  const coords: string[] = [];
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = start + i * step;
    coords.push(`${(cx + r * Math.cos(angle)).toFixed(2)},${(cy + r * Math.sin(angle)).toFixed(2)}`);
  }
  return coords.join(' ');
}
