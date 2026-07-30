import { cls, starPoints, type IconProps } from './shared';

export type ApacStarTier = 'bronze' | 'silver' | 'gold';

export interface ApacStarProps extends IconProps {
  tier: ApacStarTier;
  /**
   * Plays one 360° rotation with a badge-pop scale overshoot (~1s).
   * Re-trigger on tier change by remounting (e.g. keying on the tier).
   */
  spinning?: boolean;
}

const TIER_FILL: Record<ApacStarTier, string> = {
  bronze: '#c07a3e',
  silver: '#b8bfc9',
  gold: '#e6b422',
};

const TIER_STROKE: Record<ApacStarTier, string> = {
  bronze: '#7c4a1e',
  silver: '#7d8794',
  gold: '#9a7513',
};

const POINTS = starPoints(12, 12.4, 10.6, 4.4, 5);

/** APAC advancement star (spec §13): bronze → silver → gold five-point star. */
export function ApacStar({ tier, spinning = false, size = 24, className, title }: ApacStarProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cls('kr-icon', 'kr-apac-star', spinning && 'kr-apac-star--spin', className)}
      role="img"
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <polygon
        points={POINTS}
        fill={TIER_FILL[tier]}
        stroke={TIER_STROKE[tier]}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
