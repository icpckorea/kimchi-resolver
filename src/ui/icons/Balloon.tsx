import type { CSSProperties } from 'react';
import { cls } from './shared';

export interface BalloonProps {
  /** Problem balloon color — any CSS color (named like "ivory" or hex). */
  color: string;
  /** Height of the balloon (viewBox is 24×30). Width follows the aspect ratio. */
  size?: number | string;
  className?: string;
  title?: string;
}

const OUTLINE = '#3b3f46';

/**
 * Single tintable balloon (spec §7): the body fill comes from the problem's
 * CSS color via the `--balloon-color` custom property, while the dark outline
 * and white highlight are fixed so that white/ivory balloons stay visible.
 * Body + knot nub only — no string/tail.
 */
export function Balloon({ color, size = 24, className, title }: BalloonProps) {
  const width = typeof size === 'number' ? (size * 24) / 30 : undefined;
  const style = { '--balloon-color': color } as CSSProperties;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 30"
      width={width}
      height={size}
      className={cls('kr-icon', 'kr-balloon', className)}
      style={style}
      role="img"
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {/* knot nub */}
      <path
        d="M12 24.2l-2.3 3.4h4.6z"
        fill="var(--balloon-color, #e2504c)"
        stroke={OUTLINE}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      {/* teardrop body */}
      <path
        d="M12 1.5C5.9 1.5 1.9 6.6 1.9 12.7c0 6.8 4.9 11.9 10.1 11.9s10.1-5.1 10.1-11.9C22.1 6.6 18.1 1.5 12 1.5Z"
        fill="var(--balloon-color, #e2504c)"
        stroke={OUTLINE}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {/* fixed white highlight — keeps light-colored balloons readable */}
      <ellipse
        cx="8.4"
        cy="8.4"
        rx="2.4"
        ry="3.6"
        transform="rotate(-24 8.4 8.4)"
        fill="#fff"
        opacity="0.6"
      />
    </svg>
  );
}
