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

import { useEffect, useMemo, useRef, useState } from 'react';
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
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const chosen = new Set(selected);

  // Click-away and Escape close the panel (only while it is open).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggle = (school: string): void => {
    const next = new Set(chosen);
    if (next.has(school)) next.delete(school);
    else next.add(school);
    // Emit in contest order, not click order, so the value is stable.
    onChange(schools.filter((name) => next.has(name)));
  };

  const needle = filter.trim().toLowerCase();
  const visible =
    needle === '' ? schools : schools.filter((s) => s.toLowerCase().includes(needle));

  const summary =
    chosen.size === 0
      ? '선택 안 함'
      : selected.length <= 2
        ? selected.join(', ')
        : `${selected[0]} 외 ${chosen.size - 1}곳`;

  return (
    <div className="publish-field publish-field--wide publish-schools" ref={rootRef}>
      <span className="publish-field-label" id="publish-already-invited-label">
        이미 초청된 학교 {chosen.size > 0 ? `(${chosen.size})` : ''}
      </span>
      <button
        type="button"
        id="publish-already-invited-groups"
        className="publish-schools-toggle"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-labelledby="publish-already-invited-label"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="publish-schools-summary">{summary}</span>
        <span className="publish-schools-caret" aria-hidden="true" />
      </button>
      {open ? (
        <div className="publish-schools-panel" role="listbox" aria-multiselectable="true">
          <input
            className="publish-schools-filter"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="학교 검색"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="publish-schools-list">
            {visible.map((school) => (
              <label key={school} className="publish-school" role="option" aria-selected={chosen.has(school)}>
                <input
                  type="checkbox"
                  checked={chosen.has(school)}
                  onChange={() => toggle(school)}
                />
                <span>{school}</span>
              </label>
            ))}
            {visible.length === 0 ? (
              <p className="publish-schools-empty">일치하는 학교가 없습니다.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
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
