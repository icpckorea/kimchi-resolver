import type { ComponentType } from 'react';
import { cls, starPoints, type IconProps } from './shared';
import { ThumbsUp } from './actions';

/** Tier colors shared with the APAC star. */
export const MEDAL_COLORS = {
  gold: '#e6b422',
  silver: '#b8bfc9',
  bronze: '#c07a3e',
} as const;

const DARK = 'rgba(0, 0, 0, 0.35)';

export interface FilledIconProps extends IconProps {
  /** Main body color (CSS color). */
  fill?: string;
}

/** Filled award-slide medal: crossed ribbons + tinted disc with an inner star. */
export function AwardMedal({
  fill = MEDAL_COLORS.gold,
  size = 24,
  className,
  title,
}: FilledIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cls('kr-icon', 'kr-award-medal', className)}
      role="img"
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {/* ribbons */}
      <path d="M6.5 1.5h5L12 9.8l-3.8 1z" fill="#d64545" stroke={DARK} strokeWidth="0.8" strokeLinejoin="round" />
      <path d="M17.5 1.5h-5L12 9.8l3.8 1z" fill="#3b5bd6" stroke={DARK} strokeWidth="0.8" strokeLinejoin="round" />
      {/* disc */}
      <circle cx="12" cy="15.6" r="5.9" fill={fill} stroke={DARK} strokeWidth="1.2" />
      <circle cx="12" cy="15.6" r="4.1" fill="none" stroke="rgba(0, 0, 0, 0.22)" strokeWidth="0.9" />
      <polygon points={starPoints(12, 15.8, 2.4, 1, 5)} fill="rgba(255, 255, 255, 0.85)" />
    </svg>
  );
}

export function MedalGold(props: IconProps) {
  return <AwardMedal {...props} fill={MEDAL_COLORS.gold} />;
}

export function MedalSilver(props: IconProps) {
  return <AwardMedal {...props} fill={MEDAL_COLORS.silver} />;
}

export function MedalBronze(props: IconProps) {
  return <AwardMedal {...props} fill={MEDAL_COLORS.bronze} />;
}

/** Filled trophy cup for award slides. */
export function Trophy({ fill = MEDAL_COLORS.gold, size = 24, className, title }: FilledIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cls('kr-icon', 'kr-trophy', className)}
      role="img"
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {/* handles */}
      <path
        d="M7 5H4.4a1 1 0 0 0-1 1c0 2.5 1.8 4.2 4.1 4.5M17 5h2.6a1 1 0 0 1 1 1c0 2.5-1.8 4.2-4.1 4.5"
        fill="none"
        stroke={DARK}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      {/* cup */}
      <path
        d="M7 3h10v6a5 5 0 0 1-10 0Z"
        fill={fill}
        stroke={DARK}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {/* stem + base */}
      <path d="M10.8 13.6h2.4v3.2h-2.4z" fill={fill} stroke={DARK} strokeWidth="1" />
      <path
        d="M7.5 20.2a1.4 1.4 0 0 1 1.4-1.4h6.2a1.4 1.4 0 0 1 1.4 1.4v1.3h-9Z"
        fill={fill}
        stroke={DARK}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Filled five-point star for award slides (awards.json `star`). */
export function AwardStar({
  fill = MEDAL_COLORS.gold,
  size = 24,
  className,
  title,
}: FilledIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cls('kr-icon', 'kr-award-star', className)}
      role="img"
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <polygon
        points={starPoints(12, 12.4, 10.5, 4.3, 5)}
        fill={fill}
        stroke={DARK}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Map from awards.json v2 `icon` values to components (spec §6).
 * Unknown names should fall back to `Medal`/`AwardMedal` at the call site.
 */
export const iconRegistry: Record<string, ComponentType<IconProps>> = {
  medal_gold: MedalGold,
  medal_silver: MedalSilver,
  medal_bronze: MedalBronze,
  trophy: Trophy,
  star: AwardStar,
  thumb_up: ThumbsUp,
};
