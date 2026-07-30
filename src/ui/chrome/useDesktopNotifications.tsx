/**
 * Desktop notifications for accepted runs (spec §7, original behavior §1.3).
 *
 * - Standard Notification API only; the original's `this.cancel()` bug
 *   (a non-standard API that throws on modern browsers) is NOT ported —
 *   auto-close uses the standard `close()` after 7 seconds.
 * - Accepted runs only, and only while enabled AND in spectator mode.
 * - Two-step permission flow (original UX): the first toggle merely requests
 *   browser permission; a second toggle actually enables notifications.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Run } from '@core/types';
import { appStore, type AppStore } from '@store/appStore';

export const NOTIFICATION_AUTO_CLOSE_MS = 7000;

export type NotifyPermission = NotificationPermission | 'unsupported';

export interface DesktopNotificationsOptions {
  /** Auto-close delay override (tests). Defaults to 7000 ms. */
  autoCloseMs?: number;
}

export interface DesktopNotificationsApi {
  /** Whether the browser exposes the Notification API at all. */
  supported: boolean;
  /** Last observed permission state ('unsupported' when there is no API). */
  permission: NotifyPermission;
  /** Whether notifications are switched on (requires granted permission). */
  enabled: boolean;
  /** Notify-button click handler (implements the two-step flow). */
  toggle(): void;
}

type NotificationCtor = typeof Notification;

/** Read the constructor lazily so tests can stub `globalThis.Notification`. */
function getNotificationCtor(): NotificationCtor | null {
  const holder = globalThis as { Notification?: NotificationCtor };
  return typeof holder.Notification === 'function' ? holder.Notification : null;
}

/**
 * Build and show one notification for an accepted run. Returns false only
 * when the constructor threw — some browsers (Chrome for Android) expose a
 * page-context Notification whose constructor throws a TypeError because
 * notifications must go through a ServiceWorkerRegistration.
 */
function showNotification(store: AppStore, run: Run, autoCloseMs: number): boolean {
  const ctor = getNotificationCtor();
  if (ctor === null || ctor.permission !== 'granted') return true; // nothing to show, not an error

  const state = store.getState();
  const team = state.contest?.teams.get(run.teamId);
  const problem = state.contest?.problems.find((p) => p.id === run.problemId);
  const standing = state.snapshot?.byTeam.get(run.teamId);
  const attempts = standing?.cells.get(run.problemId)?.attempts ?? 1;

  const teamName = team?.name ?? `Team ${run.teamId}`;
  const problemLabel = problem?.label ?? run.problemId;
  const title = `${teamName} has solved ${problemLabel}!`;
  const rankPart = standing === undefined ? '' : `, now ranked #${standing.icpcRank}`;
  const body = `Run ${run.id} at ${run.minute} min. — attempt ${attempts}${rankPart}`;

  try {
    const notification = new ctor(title, { body, tag: `kimchi-run-${run.id}` });
    // Standard close() only — the original's cancel() bug is not ported.
    setTimeout(() => {
      try {
        notification.close();
      } catch {
        // Closing an already-gone notification is a no-op.
      }
    }, autoCloseMs);
    return true;
  } catch {
    return false;
  }
}

export function useDesktopNotifications(
  store: AppStore = appStore,
  options: DesktopNotificationsOptions = {},
): DesktopNotificationsApi {
  const initialCtor = getNotificationCtor();
  const supported = initialCtor !== null;
  const [permission, setPermission] = useState<NotifyPermission>(
    initialCtor === null ? 'unsupported' : initialCtor.permission,
  );
  const [enabled, setEnabled] = useState(false);

  // Refs so the store subscription (created once) sees the current values.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const autoCloseRef = useRef(options.autoCloseMs ?? NOTIFICATION_AUTO_CLOSE_MS);
  autoCloseRef.current = options.autoCloseMs ?? NOTIFICATION_AUTO_CLOSE_MS;
  /** One system message per session when construction turns out impossible. */
  const failureReportedRef = useRef(false);

  useEffect(() => {
    const unsubscribe = store.getState().subscribeTeamUpdated((event) => {
      if (!enabledRef.current) return;
      if (event.run.verdict !== 'accepted') return;
      if (store.getState().mode !== 'spectator') return;
      // The store emits just before it recomputes the snapshot; defer one
      // microtask so the notification body reports the NEW rank.
      queueMicrotask(() => {
        if (!enabledRef.current) return;
        if (showNotification(store, event.run, autoCloseRef.current)) return;
        // Constructor threw (e.g. Chrome for Android) — never spam an
        // unhandled error per run: warn once and switch the toggle off.
        setEnabled(false);
        if (!failureReportedRef.current) {
          failureReportedRef.current = true;
          store
            .getState()
            .addSystemMessage(
              'warning',
              'Desktop notifications are unavailable in this browser; the toggle has been turned off.',
            );
        }
      });
    });
    return unsubscribe;
  }, [store]);

  const toggle = useCallback(() => {
    const ctor = getNotificationCtor();
    if (ctor === null) {
      store
        .getState()
        .addSystemMessage('warning', 'Desktop notifications are not supported by this browser.');
      return;
    }
    if (enabledRef.current) {
      setEnabled(false);
      return;
    }
    const current = ctor.permission;
    setPermission(current);
    if (current === 'granted') {
      setEnabled(true);
      return;
    }
    if (current === 'denied') {
      store
        .getState()
        .addSystemMessage('warning', 'Desktop notifications are blocked by the browser.');
      return;
    }
    // Two-step flow (original UX): this press only requests permission.
    // Press the button again after granting to actually enable.
    void Promise.resolve(ctor.requestPermission()).then((granted) => setPermission(granted));
  }, [store]);

  return { supported, permission, enabled, toggle };
}
