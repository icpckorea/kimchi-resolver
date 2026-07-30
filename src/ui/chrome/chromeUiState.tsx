/**
 * Chrome-level UI state shared between Header and Dashboard (and consumable
 * by the scoreboard for pagination): dashboard visibility (persisted to
 * localStorage, seeded from config.showEvents) and the current page index.
 *
 * This is presentation state only — nothing here feeds back into core.
 */
import { useCallback } from 'react';
import { create } from 'zustand';
import { useStore } from 'zustand';

import { appStore, type AppStore } from '@store/appStore';

/** localStorage key for the dashboard visibility (spec §7). */
export const DASHBOARD_STORAGE_KEY = 'kimchi.dashboard';

export interface ChromeUiState {
  /**
   * Explicit dashboard visibility choice. `null` = the user never toggled it,
   * so `config.showEvents` decides (seeding).
   */
  dashboardVisible: boolean | null;
  /** Current pagination page, 0-based. Clamped at render time. */
  page: number;
  setDashboardVisible(visible: boolean): void;
  setPage(page: number): void;
}

function readStoredDashboardVisible(): boolean | null {
  try {
    const raw = globalThis.localStorage?.getItem(DASHBOARD_STORAGE_KEY);
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return null;
  } catch {
    return null; // storage unavailable (privacy mode, SSR) — fall back to config
  }
}

function writeStoredDashboardVisible(visible: boolean): void {
  try {
    globalThis.localStorage?.setItem(DASHBOARD_STORAGE_KEY, visible ? '1' : '0');
  } catch {
    // Persistence is best-effort.
  }
}

export const useChromeUi = create<ChromeUiState>()((set) => ({
  dashboardVisible: readStoredDashboardVisible(),
  page: 0,
  setDashboardVisible: (visible) => {
    writeStoredDashboardVisible(visible);
    set({ dashboardVisible: visible });
  },
  setPage: (page) => set({ page: Math.max(0, Math.floor(page)) }),
}));

/**
 * Effective dashboard visibility + toggle. The stored user choice wins;
 * until one exists, `config.showEvents` seeds the value.
 */
export function useDashboardVisibility(store: AppStore = appStore): [boolean, () => void] {
  const stored = useChromeUi((state) => state.dashboardVisible);
  const showEvents = useStore(store, (state) => state.config.showEvents);
  const visible = stored ?? showEvents;
  const toggle = useCallback(() => {
    const current =
      useChromeUi.getState().dashboardVisible ?? store.getState().config.showEvents;
    useChromeUi.getState().setDashboardVisible(!current);
  }, [store]);
  return [visible, toggle];
}

/** Test helper: forget the user's toggle and reset the page. */
export function resetChromeUi(): void {
  useChromeUi.setState({ dashboardVisible: readStoredDashboardVisible(), page: 0 });
}
