/**
 * "확정 결과 저장" (publish-modes spec §4 step 3).
 *
 * The button opens a confirm dialog that lists every input and the result
 * summary. Only on confirm is the state built and downloaded as
 * `publish-state.json` (Blob + object URL); `npm run publish` turns that
 * file into the public page. Building validates the state against the same
 * schema the script uses, so a file the script would refuse is never
 * downloaded: the dialog shows the error instead.
 */

import { useEffect, useState } from 'react';
import type { PublishState } from '@core/publishState';
import './publish.css';

export const PUBLISH_STATE_FILE_NAME = 'publish-state.json';

export interface SaveDetail {
  label: string;
  value: string;
}

export interface SaveStateButtonProps {
  /** Builds the state; called only when the operator confirms. */
  build: () => PublishState;
  /** Inputs as label/value rows for the dialog. */
  inputs: readonly SaveDetail[];
  /** Result summary lines for the dialog. */
  results: readonly string[];
  disabled?: boolean;
  /** Why the button is disabled (shown next to it). */
  disabledHint?: string;
}

/** Starts the browser download of one JSON file. */
function downloadJson(value: unknown, fileName: string): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Revoke after the click has started the download.
    setTimeout(() => {
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    }, 0);
  }
}

export function SaveStateButton({
  build,
  inputs,
  results,
  disabled = false,
  disabledHint,
}: SaveStateButtonProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A disabled button never keeps a dialog open (e.g. T cleared meanwhile).
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const confirm = (): void => {
    try {
      downloadJson(build(), PUBLISH_STATE_FILE_NAME);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="publish-save">
      <button
        type="button"
        className="publish-button publish-button--primary"
        disabled={disabled}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        확정 결과 저장
      </button>
      {disabled && disabledHint !== undefined ? (
        <span className="publish-save-hint">{disabledHint}</span>
      ) : null}

      {open ? (
        <div className="publish-dialog-backdrop">
          <div
            className="publish-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="publish-save-title"
          >
            <h2 className="publish-dialog-title" id="publish-save-title">
              확정 결과 저장
            </h2>
            <p className="publish-dialog-lead">
              아래 값으로 {PUBLISH_STATE_FILE_NAME} 파일을 만듭니다. 값을 확인하고
              다운로드하세요. 이 파일로 npm run publish를 실행합니다.
            </p>

            <h3 className="publish-dialog-heading">입력값</h3>
            <dl className="publish-dialog-list">
              {inputs.map((row) => (
                <div className="publish-dialog-row" key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>

            <h3 className="publish-dialog-heading">결과</h3>
            <ul className="publish-dialog-results">
              {results.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>

            {error !== null ? (
              <p className="publish-dialog-error" role="alert">
                파일을 만들 수 없습니다. {error}
              </p>
            ) : null}

            <div className="publish-dialog-actions">
              <button type="button" className="publish-button" onClick={() => setOpen(false)}>
                취소
              </button>
              <button
                type="button"
                className="publish-button publish-button--primary"
                onClick={confirm}
                autoFocus
              >
                다운로드
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
