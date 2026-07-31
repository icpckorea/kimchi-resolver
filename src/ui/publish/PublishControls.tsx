/**
 * Publish-mode inputs (spec §13): site score (required, positive number),
 * invited score cutoff (optional, non-negative number) and the cross-site
 * "already invited" schools, picked from the contest's own school list.
 *
 * Values are seeded from the store (config/URL `site_score` /
 * `invited_cutoff` and `publish.alreadyInvited` land there during boot) and
 * stay editable; every valid change is written back to the store so the board
 * re-evaluates computeApacStars live.
 *
 * When nothing is selected a hint says so: cross-site invitations cannot be
 * derived from the contest data, and leaving them out pushes ranks DOWN, so
 * fewer teams qualify than really do (spec §13 rule 3, 교차 사이트 입력).
 */

import { useMemo, useState } from 'react';
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

interface InvitedSchoolPickerProps {
  /** Every school in the contest, alphabetical. */
  schools: readonly string[];
  selected: readonly string[];
  onChange: (groups: string[]) => void;
}

/**
 * School picker for the cross-site "already invited" list.
 *
 * Free text was unusable: an operator cannot know a team id, and a mistyped
 * school name silently does nothing. Picking from the contest's own school
 * list makes both impossible.
 */
function InvitedSchoolPicker({ schools, selected, onChange }: InvitedSchoolPickerProps) {
  const chosen = new Set(selected);

  const toggle = (school: string): void => {
    const next = new Set(chosen);
    if (next.has(school)) next.delete(school);
    else next.add(school);
    onChange(schools.filter((name) => next.has(name)));
  };

  return (
    <fieldset className="publish-field publish-field--wide publish-schools">
      <legend className="publish-field-label">
        이미 초청된 학교 {chosen.size > 0 ? `(${chosen.size})` : ''}
      </legend>
      <div className="publish-schools-list">
        {schools.map((school) => (
          <label key={school} className="publish-school">
            <input
              type="checkbox"
              checked={chosen.has(school)}
              onChange={() => toggle(school)}
            />
            <span>{school}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function PublishControls() {
  const siteScoreSeed = useAppStore((s) => s.siteScore);
  const invitedCutoffSeed = useAppStore((s) => s.invitedCutoff);
  const alreadyInvited = useAppStore((s) => s.alreadyInvited);
  const setSiteScore = useAppStore((s) => s.setSiteScore);
  const setInvitedCutoff = useAppStore((s) => s.setInvitedCutoff);
  const setAlreadyInvited = useAppStore((s) => s.setAlreadyInvited);

  const contest = useAppStore((s) => s.contest);
  const schools = useMemo(() => {
    if (contest === null) return [];
    const names = new Set<string>();
    for (const team of contest.teams.values()) {
      if (team.group !== '') names.add(team.group);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [contest]);

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
      {/* Team ids are not something an operator can look up, so the picker
       * works in school names taken from the contest itself. config.json can
       * still carry `alreadyInvited.teamIds` for scripted setups. */}
      <InvitedSchoolPicker
        schools={schools}
        selected={alreadyInvited.groups}
        onChange={(groups) => setAlreadyInvited({ ...alreadyInvited, groups })}
      />
      {invitedEmpty ? (
        <p className="publish-controls-hint" role="note">
          다른 리저널에서 이미 초청된 학교를 하나도 고르지 않았습니다. 이 정보는 대회
          데이터에 없으므로 직접 골라야 합니다. 비워 두면 그 학교 팀들이 순위 슬롯을
          차지해 아래 팀들이 밀리고, 진출 가능한 팀이 실제보다 적게 표시됩니다.
        </p>
      ) : null}
    </form>
  );
}
