/**
 * Publish-mode inputs (spec §13): site score (required, positive number) and
 * invited score cutoff (optional, non-negative number).
 *
 * Values are seeded from the store (config/URL `site_score` / `invited_cutoff`
 * overrides land there during boot) and stay editable; every valid change is
 * written back to the store so the board re-evaluates computeApacStars live.
 */

import { useState } from 'react';
import { useAppStore } from '@store/appStore';
import './publish.css';

/** Parse an input string: '' → null (empty), invalid → NaN, else the number. */
function parseNumeric(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : Number.NaN;
}

interface NumericFieldProps {
  id: string;
  label: string;
  /** Store value used to seed the field on mount. */
  seed: number | null;
  placeholder: string;
  /** Predicate for a usable value; invalid/empty commits null. */
  isValid: (value: number) => boolean;
  onCommit: (value: number | null) => void;
  required?: boolean;
}

function NumericField({ id, label, seed, placeholder, isValid, onCommit, required }: NumericFieldProps) {
  const [text, setText] = useState(() => (seed !== null ? String(seed) : ''));

  const parsed = parseNumeric(text);
  const empty = parsed === null;
  const bad = !empty && (Number.isNaN(parsed) || !isValid(parsed));
  const invalid = bad || (required === true && empty);

  const handleChange = (next: string): void => {
    setText(next);
    const value = parseNumeric(next);
    onCommit(value !== null && !Number.isNaN(value) && isValid(value) ? value : null);
  };

  return (
    <label className="publish-field" htmlFor={id}>
      <span className="publish-field-label">{label}</span>
      <input
        id={id}
        className="publish-field-input"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={text}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        onChange={(e) => handleChange(e.target.value)}
      />
    </label>
  );
}

export function PublishControls() {
  const siteScoreSeed = useAppStore((s) => s.siteScore);
  const invitedCutoffSeed = useAppStore((s) => s.invitedCutoff);
  const setSiteScore = useAppStore((s) => s.setSiteScore);
  const setInvitedCutoff = useAppStore((s) => s.setInvitedCutoff);

  return (
    <form
      className="publish-controls"
      aria-label="publish settings"
      onSubmit={(e) => e.preventDefault()}
    >
      <NumericField
        id="publish-site-score"
        label="site score"
        seed={siteScoreSeed}
        placeholder="예: 84"
        isValid={(v) => v > 0}
        onCommit={setSiteScore}
        required
      />
      <NumericField
        id="publish-invited-cutoff"
        label="invited score cutoff"
        seed={invitedCutoffSeed}
        placeholder="예: 2.5"
        isValid={(v) => v >= 0}
        onCommit={setInvitedCutoff}
      />
    </form>
  );
}
