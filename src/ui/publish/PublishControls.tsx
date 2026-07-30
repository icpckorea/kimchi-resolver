/**
 * Publish-mode inputs (spec §13): site score (required, positive number),
 * invited score cutoff (optional, non-negative number) and the cross-site
 * "already invited" lists (optional, comma-separated team ids / school names).
 *
 * Values are seeded from the store (config/URL `site_score` /
 * `invited_cutoff` and `publish.alreadyInvited` land there during boot) and
 * stay editable; every valid change is written back to the store so the board
 * re-evaluates computeApacStars live.
 *
 * When both already-invited lists are empty a hint says so: cross-site
 * invitations cannot be derived from the contest data, so filtered ranks may
 * be optimistic (spec §13 rule 3, 교차 사이트 입력).
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

/** "a, b ,, c" → ['a', 'b', 'c']. Blanks are dropped. */
export function parseCsvList(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

interface ListFieldProps {
  id: string;
  label: string;
  seed: readonly string[];
  placeholder: string;
  onCommit: (values: string[]) => void;
}

function ListField({ id, label, seed, placeholder, onCommit }: ListFieldProps) {
  const [text, setText] = useState(() => seed.join(', '));

  return (
    <label className="publish-field publish-field--wide" htmlFor={id}>
      <span className="publish-field-label">{label}</span>
      <input
        id={id}
        className="publish-field-input"
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onCommit(parseCsvList(e.target.value));
        }}
      />
    </label>
  );
}

export function PublishControls() {
  const siteScoreSeed = useAppStore((s) => s.siteScore);
  const invitedCutoffSeed = useAppStore((s) => s.invitedCutoff);
  const alreadyInvited = useAppStore((s) => s.alreadyInvited);
  const setSiteScore = useAppStore((s) => s.setSiteScore);
  const setInvitedCutoff = useAppStore((s) => s.setInvitedCutoff);
  const setAlreadyInvited = useAppStore((s) => s.setAlreadyInvited);

  // Seed once (the fields are uncontrolled after mount, like the numbers).
  const [seed] = useState(alreadyInvited);
  const invitedEmpty =
    alreadyInvited.teamIds.length === 0 && alreadyInvited.groups.length === 0;

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
      <ListField
        id="publish-already-invited-teams"
        label="이미 초청된 팀 id (쉼표 구분)"
        seed={seed.teamIds}
        placeholder="예: 1024, 2048"
        onCommit={(teamIds) => setAlreadyInvited({ ...alreadyInvited, teamIds })}
      />
      <ListField
        id="publish-already-invited-groups"
        label="이미 초청된 학교 (쉼표 구분)"
        seed={seed.groups}
        placeholder="예: National Taiwan University"
        onCommit={(groups) => setAlreadyInvited({ ...alreadyInvited, groups })}
      />
      {invitedEmpty ? (
        <p className="publish-controls-hint" role="note">
          다른 리저널에서 이미 초청된 팀 정보가 없습니다. 대회 데이터만으로는 알 수 없는
          정보이므로, 초청된 학교가 리스트에 남아 그 아래 팀들의 순위가 실제보다 밀립니다.
          즉 진출 가능한 팀이 실제보다 적게 표시될 수 있습니다.
        </p>
      ) : null}
    </form>
  );
}
