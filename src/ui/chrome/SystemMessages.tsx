/**
 * Dismissible system message toasts (spec §7/§9): config validation errors,
 * asset warnings, fetch/WebSocket failures. Data lives in the app store;
 * this component only renders and dismisses.
 */
import { useStore } from 'zustand';

import { appStore, type AppStore } from '@store/appStore';
import { X } from '@ui/icons';
import './chrome.css';

export interface SystemMessagesProps {
  store?: AppStore;
}

export function SystemMessages({ store = appStore }: SystemMessagesProps) {
  const messages = useStore(store, (state) => state.systemMessages);
  const dismiss = useStore(store, (state) => state.dismissSystemMessage);

  if (messages.length === 0) return null;

  return (
    <div className="kr-system-messages" role="status" aria-live="polite">
      {messages.map((message) => (
        <div key={message.id} className={`kr-sysmsg kr-sysmsg--${message.level}`}>
          <span className="kr-sysmsg__text">{message.text}</span>
          <button
            type="button"
            className="kr-sysmsg__close"
            title="Dismiss"
            aria-label="Dismiss message"
            onClick={() => dismiss(message.id)}
          >
            <X size="1em" />
          </button>
        </div>
      ))}
    </div>
  );
}
