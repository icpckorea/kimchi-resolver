import type { FC, ReactNode } from 'react';
import { cls, type IconProps } from './shared';

/**
 * Header/action icons — hand-written Lucide-style 24px glyphs with a
 * consistent 2px round stroke. Rendered with `stroke="currentColor"` so they
 * follow the surrounding text color.
 */
function createStrokeIcon(displayName: string, children: ReactNode): FC<IconProps> {
  function Icon({ size = 24, className, title }: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cls('kr-icon', className)}
        role="img"
        aria-hidden={title ? undefined : true}
      >
        {title ? <title>{title}</title> : null}
        {children}
      </svg>
    );
  }
  Icon.displayName = displayName;
  return Icon;
}

/** Desktop-notification toggle. */
export const Bell = createStrokeIcon(
  'Bell',
  <>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </>,
);

/** Manual refresh / pending-update badge anchor. */
export const RefreshCw = createStrokeIcon(
  'RefreshCw',
  <>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M3 21v-5h5" />
  </>,
);

/** Auto-play on. */
export const Play = createStrokeIcon('Play', <polygon points="6 3 20 12 6 21 6 3" />);

/** Auto-play off. */
export const Pause = createStrokeIcon(
  'Pause',
  <>
    <rect x="6" y="4" width="4" height="16" rx="1" />
    <rect x="14" y="4" width="4" height="16" rx="1" />
  </>,
);

/** Feed one run from the queue. */
export const StepForward = createStrokeIcon(
  'StepForward',
  <>
    <line x1="6" y1="4" x2="6" y2="20" />
    <polygon points="10 4 20 12 10 20 10 4" />
  </>,
);

/** Feed all queued runs. */
export const FastForward = createStrokeIcon(
  'FastForward',
  <>
    <polygon points="13 19 22 12 13 5 13 19" />
    <polygon points="2 19 11 12 2 5 2 19" />
  </>,
);

/** Events dashboard toggle. */
export const Activity = createStrokeIcon(
  'Activity',
  <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
);

/** Pagination: previous page. */
export const ChevronLeft = createStrokeIcon('ChevronLeft', <path d="m15 18-6-6 6-6" />);

/** Pagination: next page. */
export const ChevronRight = createStrokeIcon('ChevronRight', <path d="m9 18 6-6-6-6" />);

/** Team search. */
export const Search = createStrokeIcon(
  'Search',
  <>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.35-4.35" />
  </>,
);

/** Header clock. */
export const Clock = createStrokeIcon(
  'Clock',
  <>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </>,
);

/** Generic award (stroke variant; filled tiers live in awards.tsx). */
export const Medal = createStrokeIcon(
  'Medal',
  <>
    <path d="M7 2h10" />
    <path d="M7 2l3.2 9.2" />
    <path d="M17 2l-3.2 9.2" />
    <circle cx="12" cy="16" r="5" />
  </>,
);

/** Close (slides, dialogs, system messages). */
export const X = createStrokeIcon(
  'X',
  <>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>,
);

/** awards.json `thumb_up` icon. */
export const ThumbsUp = createStrokeIcon(
  'ThumbsUp',
  <>
    <path d="M7 10v12" />
    <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
  </>,
);
