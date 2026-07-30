import { useId, type ReactNode } from 'react';
import { cls, starPoints, type IconProps } from './shared';

export interface FlagIconProps extends IconProps {
  /** ISO 3166-1 alpha-2 country code (case-insensitive). Unknown → generic flag. */
  country: string | null | undefined;
}

/* ---- flag bodies (viewBox 36×24, clipped to rounded rect) ------------------ */

/*
 * Taegeukgi (official construction, scaled to the 36×24 field):
 * - Taegeuk diameter = 1/2 of the flag height → r = 6, centered at (18, 12).
 * - The dividing S-curve lies on the ↘ diagonal of the field: a vertical
 *   divider rotated by -(90° - atan(2/3)) = -56.31°. Red (yang) sits above
 *   with its head bulging upper-left; blue (um) below, head lower-right.
 * - Each trigram: bar length 6 (1/2 taegeuk diameter), bar thickness 1,
 *   gaps 0.5 (total height 4 = 2/3 of the length), inner edge 3 away from
 *   the circle (radial 9..13), rotated so the bars face the center.
 */
const TAEGEUK_TILT = -56.31;

type TrigramBar = 's' | 'b'; // solid | broken

/** One trigram: three bars stacked outward along a flag diagonal. */
function trigram(angle: number, bars: readonly TrigramBar[]): ReactNode {
  // Bar top edges, outermost first (radial distance 13 / 11.5 / 10 from center).
  const rows = [-1, 0.5, 2];
  return (
    <g key={angle} transform={`rotate(${angle} 18 12)`}>
      {bars.map((bar, i) =>
        bar === 's' ? (
          <rect key={i} x="15" y={rows[i]} width="6" height="1" />
        ) : (
          <g key={i}>
            <rect x="15" y={rows[i]} width="2.75" height="1" />
            <rect x="18.25" y={rows[i]} width="2.75" height="1" />
          </g>
        ),
      )}
    </g>
  );
}

const KR = (
  <g>
    <rect width="36" height="24" fill="#fff" />
    {/* taegeuk: halves split along the rotated divider, interlocked by the
        small semicircle (blue tail, lower-right) + head disc (red, upper-left) */}
    <g transform={`rotate(${TAEGEUK_TILT} 18 12)`}>
      <path d="M18 6a6 6 0 0 1 0 12Z" fill="#cd2e3a" />
      <path d="M18 6a6 6 0 0 0 0 12 3 3 0 0 0 0-6Z" fill="#0047a0" />
      <circle cx="18" cy="9" r="3" fill="#cd2e3a" />
    </g>
    {/* trigrams: 건 ☰ top-left, 감 ☵ top-right, 리 ☲ bottom-left, 곤 ☷ bottom-right */}
    <g fill="#000">
      {trigram(-56.31, ['s', 's', 's'])}
      {trigram(56.31, ['b', 's', 'b'])}
      {trigram(-123.69, ['s', 'b', 's'])}
      {trigram(123.69, ['b', 'b', 'b'])}
    </g>
  </g>
);

const JP = (
  <g>
    <rect width="36" height="24" fill="#fff" />
    {/* official sun disc: diameter 3/5 of the flag height */}
    <circle cx="18" cy="12" r="7.2" fill="#bc002d" />
  </g>
);

const TW = (
  <g>
    <rect width="36" height="24" fill="#fe0000" />
    <rect width="18" height="12" fill="#000095" />
    {/* white sun: 12 thin rays + blue ring + white core */}
    <polygon points={starPoints(9, 6, 4.6, 2.55, 12)} fill="#fff" />
    <circle cx="9" cy="6" r="2.85" fill="#000095" />
    <circle cx="9" cy="6" r="2.25" fill="#fff" />
  </g>
);

const CN = (
  <g>
    <rect width="36" height="24" fill="#de2910" />
    <polygon points={starPoints(7, 7, 4.3, 1.65, 5)} fill="#ffde00" />
    <polygon points={starPoints(13.6, 2.9, 1.5, 0.6, 5)} fill="#ffde00" />
    <polygon points={starPoints(15.8, 5.3, 1.5, 0.6, 5)} fill="#ffde00" />
    <polygon points={starPoints(15.8, 8.7, 1.5, 0.6, 5)} fill="#ffde00" />
    <polygon points={starPoints(13.6, 11.1, 1.5, 0.6, 5)} fill="#ffde00" />
  </g>
);

const US_STRIPE_H = 24 / 7;

function buildUsStars(): ReactNode[] {
  const dots: ReactNode[] = [];
  for (let row = 0; row < 4; row += 1) {
    const cols = row % 2 === 0 ? 6 : 5;
    const cy = 1.6 + row * 2.4;
    for (let col = 0; col < cols; col += 1) {
      const cx = (row % 2 === 0 ? 1.5 : 2.75) + col * 2.5;
      dots.push(<circle key={`${row}-${col}`} cx={cx} cy={cy} r="0.65" fill="#fff" />);
    }
  }
  return dots;
}

const US = (
  <g>
    <rect width="36" height="24" fill="#fff" />
    {/* 13 stripes simplified to 7 */}
    {[0, 2, 4, 6].map((i) => (
      <rect key={i} y={i * US_STRIPE_H} width="36" height={US_STRIPE_H} fill="#b22234" />
    ))}
    <rect width="15.4" height={US_STRIPE_H * 3} fill="#3c3b6e" />
    {buildUsStars()}
  </g>
);

/** Neutral fallback for unknown country codes: gray field with a pennant glyph. */
const GENERIC = (
  <g className="kr-flag-generic">
    <rect width="36" height="24" fill="#e3e6ea" />
    <g stroke="#8a919c" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 18.5V5.5" />
      <path d="M14 6.5h8.5l-2.2 3 2.2 3H14" />
    </g>
  </g>
);

const FLAGS: Record<string, ReactNode> = { KR, JP, TW, CN, US };

/**
 * Hand-drawn simplified country flag (spec §8), 3:2 ratio with rounded
 * corners and a subtle border. No emoji, no external flag sets.
 */
export function FlagIcon({ country, size = 24, className, title }: FlagIconProps) {
  const clipId = useId();
  const code = (country ?? '').toUpperCase();
  const body = FLAGS[code] ?? GENERIC;
  const height = typeof size === 'number' ? (size * 2) / 3 : undefined;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 36 24"
      width={size}
      height={height}
      className={cls('kr-icon', 'kr-flag', className)}
      data-country={FLAGS[code] ? code : 'generic'}
      role="img"
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <clipPath id={clipId}>
        <rect width="36" height="24" rx="2" />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>{body}</g>
      {/* subtle border on top of the clipped field */}
      <rect
        x="0.5"
        y="0.5"
        width="35"
        height="23"
        rx="1.7"
        fill="none"
        stroke="rgba(0, 0, 0, 0.25)"
        strokeWidth="1"
      />
    </svg>
  );
}
