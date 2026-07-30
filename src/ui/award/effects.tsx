/**
 * Award reveal effect overlays (spec §6/§7).
 *
 * - SparkleOverlay: small SVG sparkles over a shaking cell (gacha effect,
 *   and the finale's step-1 pre-heat).
 * - RainbowOverlay: continuous flowing full-cell rainbow gradient (finale
 *   gacha variant) — the gradient itself lives in award.css; this component
 *   only mounts the layer.
 * - FinaleDim: full-screen dim overlay with a radial spotlight centered on
 *   the finale cell (position injected via CSS variables).
 * - ConfettiBurst: finale step 5 — a hand-rolled DOM/CSS particle burst on a
 *   Yes verdict. No dependency, no canvas: plain spans with per-particle CSS
 *   variables driving one keyframe animation.
 *
 * No emoji anywhere — sparkles are inline SVG, confetti are plain spans.
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

// ---------------------------------------------------------------------------
// Confetti (finale step 5, Yes verdict only)
// ---------------------------------------------------------------------------

const CONFETTI_COUNT = 72;
const CONFETTI_COLORS = [
  '#ff3b30',
  '#ff9500',
  '#ffcc00',
  '#34c759',
  '#32ade6',
  '#5856d6',
  '#af52de',
  '#ffffff',
];

interface ConfettiPiece {
  dx: string;
  dy: string;
  rise: string;
  rot: string;
  delay: string;
  duration: string;
  color: string;
  width: string;
  height: string;
  radius: string;
}

/**
 * Deterministic particle layout: a golden-angle fan (never clumps, never
 * needs an RNG, identical every run so tests and re-renders are stable).
 */
const CONFETTI: ConfettiPiece[] = Array.from({ length: CONFETTI_COUNT }, (_, i) => {
  const angle = i * 2.39996; // golden angle in radians
  const spread = 0.35 + ((i * 37) % 100) / 140; // 0.35 .. ~1.06
  const distance = 26 + spread * 34; // vh/vw units below
  const round = i % 3 === 0;
  return {
    dx: `${(Math.cos(angle) * distance).toFixed(2)}vw`,
    dy: `${(Math.sin(angle) * distance * 0.55).toFixed(2)}vh`,
    rise: `${(10 + ((i * 17) % 22)).toFixed(0)}vh`,
    rot: `${(((i * 97) % 15) - 7) * 90}deg`,
    delay: `${(((i * 13) % 30) / 100).toFixed(2)}s`,
    duration: `${(2 + ((i * 7) % 13) / 10).toFixed(1)}s`,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    width: round ? '0.55em' : '0.45em',
    height: round ? '0.55em' : '0.9em',
    radius: round ? '50%' : '0.08em',
  };
});

export interface ConfettiBurstProps {
  /** Burst origin in viewport px; null → screen center. */
  x: number | null;
  y: number | null;
}

/** Full-screen confetti burst from the finale cell (spec §7 step 5). */
export function ConfettiBurst({ x, y }: ConfettiBurstProps) {
  const style = {
    '--burst-x': x === null ? '50%' : `${x}px`,
    '--burst-y': y === null ? '45%' : `${y}px`,
  } as React.CSSProperties;
  return (
    <div
      className="award-confetti"
      data-testid="finale-confetti"
      aria-hidden="true"
      style={style}
    >
      {CONFETTI.map((piece, i) => (
        <span
          key={i}
          className="award-confetti-piece"
          style={
            {
              '--dx': piece.dx,
              '--dy': piece.dy,
              '--rise': piece.rise,
              '--rot': piece.rot,
              width: piece.width,
              height: piece.height,
              borderRadius: piece.radius,
              backgroundColor: piece.color,
              animationDelay: piece.delay,
              animationDuration: piece.duration,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
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
