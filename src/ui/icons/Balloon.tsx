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
      {/* string */}
      <path
        d="M12 23.6c-1.5 1.5 1.5 2.9 0 5.2"
        fill="none"
        stroke={OUTLINE}
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      {/* knot */}
      <path
        d="M12 20.2l-2 3.2h4z"
        fill="var(--balloon-color, #e2504c)"
        stroke={OUTLINE}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      {/* teardrop body */}
      <path
        d="M12 1.2C6.5 1.2 2.7 5.6 2.7 10.9c0 5.9 4.4 10.2 9.3 10.2s9.3-4.3 9.3-10.2c0-5.3-3.8-9.7-9.3-9.7Z"
        fill="var(--balloon-color, #e2504c)"
        stroke={OUTLINE}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {/* fixed white highlight — keeps light-colored balloons readable */}
      <ellipse
        cx="8.6"
        cy="7.6"
        rx="2.1"
        ry="3.1"
        transform="rotate(-24 8.6 7.6)"
        fill="#fff"
        opacity="0.6"
      />
    </svg>
  );
}
