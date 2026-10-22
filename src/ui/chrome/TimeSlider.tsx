/**
 * Time travel slider (config `timeTravel`): a range over the contest minutes
 * in the spectator header. Dragging moves the label only; the release (the
 * native `change` event) reloads the page with `time=<minute>`, so the board
 * is rebuilt by the normal boot replay. The maximum means the end of the
 * contest and removes `time=`. With `time=` set, the later runs stay queued,
 * so the play button animates the contest on from that minute, and the slider
 * follows the last applied run (the end once the queue is empty). The header
 * search lives only in the store, so it is carried over as `q=`.
 *
 * The time box next to the slider takes a typed time: HH:MM, H:MM or plain
 * minutes (130 = 02:10). Enter moves the page; Escape or blur puts the
 * current time back.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';

import type { AppStore } from '@store/appStore';
import { formatClock } from './Header';

/**
 * Moves the page to a contest minute (null: the end of the contest) with the
 * search query (null: no search).
 */
export type TimeNavigate = (minute: number | null, query: string | null) => void;

/** `href` with `time=` and `q=` set, or removed for null. */
export function timeTravelHref(href: string, minute: number | null, query: string | null): string {
  const url = new URL(href);
  if (minute === null) url.searchParams.delete('time');
  else url.searchParams.set('time', String(minute));
  if (query === null) url.searchParams.delete('q');
  else url.searchParams.set('q', query);
  return url.toString();
}

/** Contest minute from "HH:MM", "H:MM" or plain minutes; null when it is neither. */
export function parseContestMinute(text: string): number | null {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = /^(\d+):(\d{1,2})$/.exec(trimmed);
  if (match === null || Number(match[2]) >= 60) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export const navigateByReload: TimeNavigate = (minute, query) => {
  window.location.assign(timeTravelHref(window.location.href, minute, query));
};

export interface TimeSliderProps {
  store: AppStore;
  navigate?: TimeNavigate;
}

export function TimeSlider({ store, navigate = navigateByReload }: TimeSliderProps) {
  const contestTimeSec = useStore(store, (state) => state.contestTimeSec);
  const replayTimeMinutes = useStore(store, (state) => state.config.replayTimeMinutes);
  const searchQuery = useStore(store, (state) => state.config.searchQuery);
  const pendingCount = useStore(store, (state) => state.pendingCount);
  const lastAppliedMinute = useStore(store, (state) => state.lastAppliedMinute);

  const maxMinute = contestTimeSec === null ? 0 : Math.ceil(contestTimeSec / 60);
  // The board shows every known run once the queue is empty.
  const current =
    pendingCount === 0
      ? maxMinute
      : Math.min(Math.max(replayTimeMinutes ?? 0, lastAppliedMinute ?? 0), maxMinute);
  const [draft, setDraft] = useState<number | null>(null);
  /** Text being typed in the time box; null shows the slider time. */
  const [typed, setTyped] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const go = useCallback(
    (minute: number) => {
      const clamped = Math.min(minute, maxMinute);
      if (clamped === current) return;
      navigate(clamped >= maxMinute ? null : clamped, searchQuery);
    },
    [current, maxMinute, navigate, searchQuery],
  );

  // React's onChange fires on every input step; the native change event fires
  // once, on release, and that is when the page moves.
  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    const onRelease = () => {
      // The slider follows the feed again unless the page moves.
      setDraft(null);
      go(Number(input.value));
    };
    input.addEventListener('change', onRelease);
    return () => input.removeEventListener('change', onRelease);
  }, [go]);

  const resetTyped = () => {
    setTyped(null);
    setInvalid(false);
  };

  const onTimeKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      resetTyped();
      return;
    }
    if (event.key !== 'Enter' || typed === null) return;
    const minute = parseContestMinute(typed);
    if (minute === null) {
      setInvalid(true);
      return;
    }
    resetTyped();
    go(minute);
  };

  if (contestTimeSec === null) return null;
  const shown = draft ?? current;

  return (
    <div className="kr-time" title="Show the standings at this contest time">
      <input
        ref={inputRef}
        type="range"
        min={0}
        max={maxMinute}
        step={1}
        value={shown}
        aria-label="Contest time"
        onChange={(event) => {
          // React also calls this for the release; the listener above owns it.
          if (event.nativeEvent.type === 'change') return;
          setDraft(Number(event.target.value));
          resetTyped();
        }}
      />
      <input
        type="text"
        inputMode="numeric"
        className={invalid ? 'kr-time__text kr-time__text--invalid' : 'kr-time__text'}
        title="HH:MM or minutes (130 = 02:10), then Enter"
        aria-label="Contest time as text"
        aria-invalid={invalid}
        value={typed ?? formatClock(shown * 60)}
        onChange={(event) => {
          setTyped(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={onTimeKeyDown}
        onBlur={resetTyped}
      />
    </div>
  );
}
