import { useId } from 'react';

import { useMediaQuery } from '@ui/scoreboard/useMediaQuery';

import { cls, starPoints, type IconProps } from './shared';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export type ApacStarTier = 'bronze' | 'silver' | 'gold' | 'rainbow';

export interface ApacStarProps extends IconProps {
  tier: ApacStarTier;
  /**
   * Plays one 360° rotation with a badge-pop scale overshoot (~1s).
   * Re-trigger on tier change by remounting (e.g. keying on the tier).
   */
  spinning?: boolean;
}

type FlatTier = Exclude<ApacStarTier, 'rainbow'>;

const TIER_FILL: Record<FlatTier, string> = {
  bronze: '#c07a3e',
  silver: '#b8bfc9',
  gold: '#e6b422',
};

const TIER_STROKE: Record<FlatTier, string> = {
  bronze: '#7c4a1e',
  silver: '#7d8794',
  gold: '#9a7513',
};

/** Rainbow gradient stops for one band period. The first color closes the
 * period again, so the repeated bands join without a seam. */
export const RAINBOW_STOPS: readonly string[] = [
  '#ff3b6b',
  '#ff9a1f',
  '#ffe14a',
  '#3ee08a',
  '#2ec5ff',
  '#7a5cff',
  '#ff4fd8',
];

/** Width of one rainbow band period, in viewBox units (the star is ~21 wide). */
const BAND_PERIOD = 18;

const POINTS = starPoints(12, 12.4, 10.6, 4.4, 5);
/** Gloss core of the rainbow star: a smaller star, offset up. */
const GLOSS_POINTS = starPoints(12, 10.6, 3.6, 1.5, 5);

/** Four-point twinkle centered at (cx, cy). */
function sparklePoints(cx: number, cy: number, r: number): string {
  return starPoints(cx, cy, r, r * 0.28, 4);
}

/**
 * APAC advancement star (spec §13): bronze → silver → gold five-point star,
 * and the rainbow star of the regional winner (Championship invitation, rule
 * D1, and World Finals, rule B1). Its rainbow bands flow across the star and
 * swirl, it glows and it twinkles. `prefers-reduced-motion` stops the motion:
 * the SMIL animations are not rendered, and icons.css stops the twinkle.
 */
export function ApacStar({ tier, spinning = false, size = 24, className, title }: ApacStarProps) {
  // Gradient ids must be unique per instance (many rows, one document).
  const gradientId = `kr-apac-rainbow-${useId().replace(/:/g, '')}`;
  const rainbow = tier === 'rainbow';
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const stops = [...RAINBOW_STOPS, RAINBOW_STOPS[0]];

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cls(
        'kr-icon',
        'kr-apac-star',
        rainbow && 'kr-apac-star--rainbow',
        spinning && 'kr-apac-star--spin',
        className,
      )}
      data-tier={tier}
      role="img"
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {rainbow ? (
        <>
          <defs>
            {/* Repeating bands in viewBox units. The two transforms add up:
                a slow swirl around the center, and a flow of one period along
                the (swirling) band axis. */}
            <linearGradient
              id={gradientId}
              gradientUnits="userSpaceOnUse"
              spreadMethod="repeat"
              x1="0"
              y1="0"
              x2={BAND_PERIOD}
              y2="0"
              gradientTransform="rotate(35 12 12)"
            >
              {stops.map((color, i) => (
                <stop key={i} offset={i / (stops.length - 1)} stopColor={color} />
              ))}
              {reducedMotion ? null : (
                <>
                  <animateTransform
                    attributeName="gradientTransform"
                    type="rotate"
                    values="35 12 12;395 12 12"
                    dur="6s"
                    repeatCount="indefinite"
                  />
                  <animateTransform
                    attributeName="gradientTransform"
                    type="translate"
                    values={`0 0;${BAND_PERIOD} 0`}
                    dur="1.4s"
                    repeatCount="indefinite"
                    additive="sum"
                  />
                </>
              )}
            </linearGradient>
          </defs>
          <g className="kr-apac-star__glow">
            <polygon
              points={POINTS}
              fill={`url(#${gradientId})`}
              stroke="#5b2a86"
              strokeWidth="1"
              strokeLinejoin="round"
            />
            <polygon points={GLOSS_POINTS} fill="#ffffff" opacity="0.22" />
            <polygon
              className="kr-apac-star__sparkle"
              points={sparklePoints(20.6, 3.4, 3)}
              fill="#ff4fd8"
            />
            <polygon
              className="kr-apac-star__sparkle kr-apac-star__sparkle--late"
              points={sparklePoints(3.2, 19.8, 2.1)}
              fill="#2ec5ff"
            />
          </g>
        </>
      ) : (
        <polygon
          points={POINTS}
          fill={TIER_FILL[tier]}
          stroke={TIER_STROKE[tier]}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
