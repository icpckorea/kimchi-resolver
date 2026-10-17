import type { ReactNode } from 'react';
import { cls, starPoints, type IconProps } from './shared';

/** The three ways a team advances in the preliminary (core: PrelimStage). */
export type StageName = 'top' | 'school' | 'fill';

/**
 * One color per stage, chosen to stay readable on the yellow advance row
 * (--row-advance-bg #fff3b0): blue, green and magenta are all dark enough
 * against it and far apart in hue. Never yellow or orange.
 */
export const STAGE_COLORS: Record<StageName, string> = {
  top: '#1f5fbf',
  school: '#1e8449',
  fill: '#b02a8f',
};

const DARK = 'rgba(0, 0, 0, 0.35)';
const LIGHT = 'rgba(255, 255, 255, 0.92)';

/** Em-based by default, so the icon scales with the row's font size. */
const DEFAULT_SIZE = '1em';

interface StageSvgProps extends IconProps {
  stage: StageName;
  children: ReactNode;
}

function StageSvg({ stage, size = DEFAULT_SIZE, className, title, children }: StageSvgProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cls('kr-icon', 'kr-stage-icon', `kr-stage-icon--${stage}`, className)}
      role="img"
      data-stage={stage}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/** Top of the ranking: a podium (tall middle block) under a star. */
export function StageTop(props: IconProps) {
  const fill = STAGE_COLORS.top;
  return (
    <StageSvg stage="top" {...props}>
      <polygon points={starPoints(12, 5.4, 4.4, 1.9, 5)} fill={fill} stroke={DARK} strokeWidth="0.8" strokeLinejoin="round" />
      <path
        d="M1.5 22v-8h6.5v-4.5h8V16h6.5v6Z"
        fill={fill}
        stroke={DARK}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {/* 2 - 1 - 3 on the blocks */}
      <path d="M11 12.4l1.4-.9v7.6" fill="none" stroke={LIGHT} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </StageSvg>
  );
}

/** School: a graduation cap (mortarboard) with a tassel. */
export function StageSchool(props: IconProps) {
  const fill = STAGE_COLORS.school;
  return (
    <StageSvg stage="school" {...props}>
      {/* cap body under the board */}
      <path
        d="M6 11.6v4.6c0 1.9 2.7 3.4 6 3.4s6-1.5 6-3.4v-4.6l-6 3.2Z"
        fill={fill}
        stroke={DARK}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {/* board */}
      <polygon
        points="12,3.6 23,9 12,14.4 1,9"
        fill={fill}
        stroke={DARK}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <polygon points="12,6.2 17.2,9 12,11.8 6.8,9" fill={LIGHT} opacity="0.35" />
      {/* tassel */}
      <path d="M21 10v6" stroke={DARK} strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="21" cy="17.2" r="1.5" fill={fill} stroke={DARK} strokeWidth="0.9" />
    </StageSvg>
  );
}

/** Fill: a plus in a circle, an open spot that is filled in rank order. */
export function StageFill(props: IconProps) {
  const fill = STAGE_COLORS.fill;
  return (
    <StageSvg stage="fill" {...props}>
      <circle cx="12" cy="12" r="10" fill={fill} stroke={DARK} strokeWidth="1.2" />
      <path d="M12 6.6v10.8M6.6 12h10.8" stroke={LIGHT} strokeWidth="3" strokeLinecap="round" />
    </StageSvg>
  );
}

/** Icon for a stage by name. */
export function StageIcon({ stage, ...props }: IconProps & { stage: StageName }) {
  switch (stage) {
    case 'top':
      return <StageTop {...props} />;
    case 'school':
      return <StageSchool {...props} />;
    case 'fill':
      return <StageFill {...props} />;
  }
}
