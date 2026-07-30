/** Barrel for the chrome area: header, dashboard, system messages. */
export { Header, formatClock, type HeaderProps } from './Header';
export { Dashboard, dedupeEvents, type DashboardProps } from './Dashboard';
export { SystemMessages, type SystemMessagesProps } from './SystemMessages';
export {
  useDesktopNotifications,
  NOTIFICATION_AUTO_CLOSE_MS,
  type DesktopNotificationsApi,
  type DesktopNotificationsOptions,
  type NotifyPermission,
} from './useDesktopNotifications';
export {
  useChromeUi,
  useDashboardVisibility,
  resetChromeUi,
  DASHBOARD_STORAGE_KEY,
  type ChromeUiState,
} from './chromeUiState';
