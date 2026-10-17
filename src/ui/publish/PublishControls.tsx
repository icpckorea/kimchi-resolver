/**
 * Notice for inputs that come from this browser's storage (publish-modes
 * spec §4 step 2): "저장된 값을 사용 중" plus a button that goes back to the
 * config/URL values. It shows in every mode that has inputs.
 *
 * The per-mode inputs live in PrelimControls and RegionalSimPanel.
 */

import { useAppStore } from '@store/appStore';
import './publish.css';

export interface StoredInputsNoticeProps {
  /** Called after the store reset, e.g. to remount the input fields. */
  onReset?: () => void;
}

export function StoredInputsNotice({ onReset }: StoredInputsNoticeProps) {
  const fromStorage = useAppStore((s) => s.publishInputsFromStorage);
  const resetPublishInputs = useAppStore((s) => s.resetPublishInputs);
  if (!fromStorage) return null;
  return (
    <div className="publish-stored" role="status">
      <span className="publish-stored-text">저장된 값을 사용 중</span>
      <button
        type="button"
        className="publish-button"
        onClick={() => {
          resetPublishInputs();
          onReset?.();
        }}
      >
        config 값으로 되돌리기
      </button>
    </div>
  );
}
