/**
 * Award reveal effect overlays (spec §6/§7).
 *
 * - SparkleOverlay: small SVG sparkles over a shaking cell (gacha effect).
 * - RainbowOverlay: continuous flowing full-cell rainbow gradient (finale
 *   gacha variant) — the gradient itself lives in award.css; this component
 *   only mounts the layer.
 * - FinaleDim: full-screen dim overlay with a radial spotlight centered on
 *   the finale cell (position injected via CSS variables).
 *
 * No emoji anywhere — sparkles are inline SVG.
 */
import { starPoints } from '@ui/icons/shared';

interface SparkleSpec {
  cx: number;
  cy: number;
  r: number;
  delay: string;
}

const SPARKLES: SparkleSpec[] = [
  { cx: 4, cy: 5, r: 2.4, delay: '0s' },
  { cx: 20, cy: 4, r: 1.8, delay: '0.12s' },
  { cx: 22, cy: 15, r: 2.2, delay: '0.24s' },
  { cx: 7, cy: 18, r: 1.6, delay: '0.3s' },
  { cx: 14, cy: 10, r: 1.4, delay: '0.18s' },
];

/** Sparkle layer for the gacha shake. Covers its positioned parent (the cell). */
export function SparkleOverlay() {
  return (
    <span className="award-sparkle-overlay" data-testid="gacha-sparkle" aria-hidden="true">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" preserveAspectRatio="none">
        {SPARKLES.map((s, i) => (
          <polygon
            key={i}
            className="award-sparkle"
            style={{ animationDelay: s.delay }}
            points={starPoints(s.cx, s.cy, s.r, s.r * 0.38, 4)}
            fill="#fff8d0"
          />
        ))}
      </svg>
    </span>
  );
}

/** Continuous flowing full-cell rainbow gradient (finale reveal). */
export function RainbowOverlay() {
  return (
    <span className="award-rainbow-overlay" data-testid="finale-rainbow" aria-hidden="true" />
  );
}

export interface FinaleDimProps {
  /** Spotlight center in viewport px; null → screen center. */
  x: number | null;
  y: number | null;
}

/** Full-screen dim + radial spotlight for the finale (spec §7). */
export function FinaleDim({ x, y }: FinaleDimProps) {
  const style: Record<string, string> = {
    '--spot-x': x === null ? '50%' : `${x}px`,
    '--spot-y': y === null ? '50%' : `${y}px`,
  };
  return (
    <div
      className="award-finale-dim"
      data-testid="finale-dim"
      aria-hidden="true"
      style={style as React.CSSProperties}
    />
  );
}
