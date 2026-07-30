/**
 * Viewport media-query hook (spec §14). Subscribes to window.matchMedia and
 * re-renders on breakpoint changes. Environments without matchMedia (jsdom
 * without a stub, SSR) report false — i.e. desktop layout.
 */
import { useCallback, useSyncExternalStore } from 'react';

/** Mobile breakpoint for the compact scoreboard layout (spec §14). */
export const MOBILE_MEDIA_QUERY = '(max-width: 768px)';

function canMatch(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!canMatch()) return () => {};
      const mql = window.matchMedia(query);
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
      }
      // Legacy MediaQueryList (Safari < 14)
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(
    () => (canMatch() ? window.matchMedia(query).matches : false),
    [query],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
