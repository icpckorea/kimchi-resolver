/**
 * Regional simulation inputs (publish-modes spec §6.4), shared by the
 * prepare page and the static public page.
 *
 * Controlled and store-free: the value comes in through props and every
 * valid edit goes out through `onChange`. The prepare page wires it to the
 * app store; the public page (Task 7) keeps a local copy seeded from
 * publish-state.json. This file must never import `@store`.
 *
 * - S (rule C1) is computed by the caller (`useRegionalSimulation`) and only
 *   shown here. Empty preliminary counts count as 0 (with a hint); the
 *   standings counts U_r, T_r, F_r are shown as placeholders and an operator
 *   value replaces them.
 * - Three school pickers: WF medal schools (Q = 3), winner schools of other
 *   regionals, and schools already invited by another path. The last two
 *   drop out of the scored list the same way (decision "B", spec §6.2).
 * - The five S coefficients sit in a collapsed "고급" section.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Snapshot } from '@core/types';
import {
  computeSiteScore,
  countSiteInputs,
  DEFAULT_SCHOOL_QUOTA,
  simulateRegional,
  type RegionalSimulation,
  type SiteCounts,
  type SiteScoreCoefficients,
} from '@core/apac';
import type { RegionalSimInputs } from '@core/publishState';
import './publish.css';

export const APAC_RULES_URL = 'https://icpc.jp/apac/2026-27/rules/';

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/** S from the standings counts (non-null overrides win) and the prelim counts (null → 0). */
export function siteScoreOf(autoCounts: SiteCounts, inputs: RegionalSimInputs): number {
  const override = inputs.regionalOverride;
  return computeSiteScore({
    regional: {
      schools: override.schools ?? autoCounts.schools,
      teams: override.teams ?? autoCounts.teams,
      foreign: override.foreign ?? autoCounts.foreign,
    },
    prelimSchools: inputs.prelimSchools ?? 0,
    prelimTeams: inputs.prelimTeams ?? 0,
    coefficients: inputs.coefficients,
  });
}

/** The regional simulation of the final standings for these inputs. */
export function useRegionalSimulation(
  snapshot: Snapshot,
  inputs: RegionalSimInputs,
): RegionalSimulation & { autoCounts: SiteCounts } {
  const autoCounts = useMemo(() => countSiteInputs(snapshot), [snapshot]);
  return useMemo(() => {
    const simulation = simulateRegional(snapshot, {
      siteScore: siteScoreOf(autoCounts, inputs),
      cutoff: inputs.cutoff,
      quota: { base: DEFAULT_SCHOOL_QUOTA, wfMedalGroups: inputs.wfMedalGroups },
      alreadyInvited: {
        teamIds: inputs.invitedTeamIds,
        groups: [...inputs.winnerGroups, ...inputs.invitedGroups],
      },
    });
    return { ...simulation, autoCounts };
  }, [snapshot, autoCounts, inputs]);
}

/** S for display: up to 4 decimals, no trailing zeros; '-' when not finite. */
export function formatSiteScore(score: number): string {
  return Number.isFinite(score) ? String(Number(score.toFixed(4))) : '-';
}

/** A value on the board: always 4 decimals (spec §6.3). */
export function formatApacValue(value: number): string {
  return value.toFixed(4);
}

/** Every non-empty school name of the snapshot, alphabetical. */
export function schoolsOf(snapshot: Snapshot): string[] {
  const names = new Set<string>();
  for (const { team } of snapshot.standings) {
    if (team.group !== '') names.add(team.group);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Numeric field
// ---------------------------------------------------------------------------

/** Parse an input string: '' → null (empty), invalid → NaN, else the number. */
function parseNumeric(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : Number.NaN;
}

function formatNumeric(value: number | null): string {
  return value === null ? '' : String(value);
}

export interface NumericFieldProps {
  id: string;
  label: string;
  /** Current value; a change from outside (a reset) replaces the text. */
  value: number | null;
  placeholder?: string;
  /** Predicate for a usable value; invalid or empty commits null. */
  isValid: (value: number) => boolean;
  onCommit: (value: number | null) => void;
  /** Empty is invalid too. */
  required?: boolean;
  /** Short description under the input. */
  hint?: ReactNode;
}

/**
 * Text input for one number. The text is kept as typed (so "0." or an
 * invalid value can stay on screen); a valid value is committed, anything
 * else commits null and marks the field invalid.
 */
export function NumericField({
  id,
  label,
  value,
  placeholder,
  isValid,
  onCommit,
  required,
  hint,
}: NumericFieldProps) {
  const [text, setText] = useState(() => formatNumeric(value));
  // The last value this field committed: a different incoming value came
  // from outside (a reset), so the text follows it.
  const committedRef = useRef(value);
  useEffect(() => {
    if (!Object.is(value, committedRef.current)) {
      committedRef.current = value;
      setText(formatNumeric(value));
    }
  }, [value]);

  const parsed = parseNumeric(text);
  const empty = parsed === null;
  const bad = !empty && (Number.isNaN(parsed) || !isValid(parsed));
  const invalid = bad || (required === true && empty);

  const handleChange = (next: string): void => {
    setText(next);
    const nextValue = parseNumeric(next);
    const committed =
      nextValue !== null && !Number.isNaN(nextValue) && isValid(nextValue) ? nextValue : null;
    committedRef.current = committed;
    onCommit(committed);
  };

  const hintId = hint !== undefined ? `${id}-hint` : undefined;
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
        aria-describedby={hintId}
        onChange={(e) => handleChange(e.target.value)}
      />
      {hint !== undefined ? (
        <span className="publish-field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

// ---------------------------------------------------------------------------
// School picker
// ---------------------------------------------------------------------------

export interface InvitedSchoolPickerProps {
  /** Toggle button id; the label gets `${id}-label`. */
  id: string;
  label: string;
  /** Every school in the contest, alphabetical. */
  schools: readonly string[];
  selected: readonly string[];
  onChange: (groups: string[]) => void;
  hint?: ReactNode;
}

/**
 * Multi-school picker over the contest's own school list.
 *
 * Free text was unusable: an operator cannot know a team id, and a mistyped
 * school name silently does nothing. Picking from the contest's own school
 * list makes both impossible.
 */
export function InvitedSchoolPicker({
  id,
  label,
  schools,
  selected,
  onChange,
  hint,
}: InvitedSchoolPickerProps) {
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
    // Emit in contest order, not click order, so the value is stable. A
    // config value that names a school not in this contest is kept.
    const outside = selected.filter((name) => !schools.includes(name) && next.has(name));
    onChange([...schools.filter((name) => next.has(name)), ...outside]);
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

  const labelId = `${id}-label`;
  return (
    <div className="publish-field publish-field--wide publish-schools" ref={rootRef}>
      <span className="publish-field-label" id={labelId}>
        {label} {chosen.size > 0 ? `(${chosen.size})` : ''}
      </span>
      <button
        type="button"
        id={id}
        className="publish-schools-toggle"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-labelledby={labelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="publish-schools-summary">{summary}</span>
        <span className="publish-schools-caret" aria-hidden="true" />
      </button>
      {hint !== undefined ? <span className="publish-field-hint">{hint}</span> : null}
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
              <label
                key={school}
                className="publish-school"
                role="option"
                aria-selected={chosen.has(school)}
              >
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

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export interface RegionalSimPanelProps {
  value: RegionalSimInputs;
  onChange: (next: RegionalSimInputs) => void;
  /** Contest schools, alphabetical. */
  schools: readonly string[];
  autoCounts: SiteCounts;
  siteScore: number;
  /** Shown as "초기값으로 되돌리기" when given. */
  onReset?: () => void;
  /** Start with the inputs folded (mobile public page). */
  collapsedByDefault?: boolean;
}

const COEFFICIENT_FIELDS: { key: keyof SiteScoreCoefficients; label: string }[] = [
  { key: 'regionalSchools', label: '본선 학교 수 계수' },
  { key: 'regionalTeams', label: '본선 팀 수 계수' },
  { key: 'prelimSchools', label: '예선 학교 수 계수' },
  { key: 'prelimTeams', label: '예선 팀 수 계수' },
  { key: 'foreignTeams', label: '본선 외국 팀 수 계수' },
];

const isCount = (v: number): boolean => Number.isInteger(v) && v >= 0;

export function RegionalSimPanel({
  value,
  onChange,
  schools,
  autoCounts,
  siteScore,
  onReset,
  collapsedByDefault = false,
}: RegionalSimPanelProps) {
  const [open, setOpen] = useState(!collapsedByDefault);
  // A reset remounts the fields, so a field whose text was invalid (and
  // therefore never committed) shows the reset value too.
  const [resetGen, setResetGen] = useState(0);

  const patch = (next: Partial<RegionalSimInputs>): void => onChange({ ...value, ...next });
  const patchOverride = (next: Partial<RegionalSimInputs['regionalOverride']>): void =>
    patch({ regionalOverride: { ...value.regionalOverride, ...next } });

  const c = value.coefficients;
  const usable = Number.isFinite(siteScore) && siteScore > 0;
  const invitedEmpty =
    value.invitedTeamIds.length === 0 &&
    value.winnerGroups.length === 0 &&
    value.invitedGroups.length === 0;
  const prelimEmpty = value.prelimSchools === null || value.prelimTeams === null;

  return (
    <details
      className="regional-sim"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="regional-sim-head">
        <span className="regional-sim-title">APAC 진출 시뮬레이션 입력</span>
        <span className="regional-sim-score">site score S = {formatSiteScore(siteScore)}</span>
      </summary>

      <div className="regional-sim-body" key={resetGen}>
        {!usable ? (
          <p className="regional-sim-score-hint" role="note">
            S가 0 이하이므로 value를 계산하지 않습니다. 예선 학교 수와 팀 수를 확인하세요.
          </p>
        ) : null}

        <fieldset className="regional-sim-group">
          <legend>site score S</legend>
          <p className="regional-sim-formula">
            S = {c.regionalSchools}·U_r + {c.regionalTeams}·T_r + {c.prelimSchools}·U_p +{' '}
            {c.prelimTeams}·T_p + {c.foreignTeams}·F_r
          </p>
          <NumericField
            id="publish-prelim-schools"
            label="예선 학교 수 U_p"
            value={value.prelimSchools}
            placeholder="0"
            isValid={isCount}
            onCommit={(prelimSchools) => patch({ prelimSchools })}
            hint="예선에서 1문제 이상 푼 팀이 있는 학교 수입니다."
          />
          <NumericField
            id="publish-prelim-teams"
            label="예선 팀 수 T_p"
            value={value.prelimTeams}
            placeholder="0"
            isValid={isCount}
            onCommit={(prelimTeams) => patch({ prelimTeams })}
            hint="예선에서 1문제 이상 푼 팀 수입니다."
          />
          {prelimEmpty ? (
            <p className="publish-field-note" role="note">
              비어 있는 예선 값은 0으로 계산합니다.
            </p>
          ) : null}
          <NumericField
            id="publish-regional-schools"
            label="본선 학교 수 U_r"
            value={value.regionalOverride.schools}
            placeholder={String(autoCounts.schools)}
            isValid={isCount}
            onCommit={(schools) => patchOverride({ schools })}
            hint="비워 두면 순위표에서 센 값을 씁니다."
          />
          <NumericField
            id="publish-regional-teams"
            label="본선 팀 수 T_r"
            value={value.regionalOverride.teams}
            placeholder={String(autoCounts.teams)}
            isValid={isCount}
            onCommit={(teams) => patchOverride({ teams })}
            hint="비워 두면 순위표에서 센 값을 씁니다."
          />
          <NumericField
            id="publish-regional-foreign"
            label="본선 외국 팀 수 F_r"
            value={value.regionalOverride.foreign}
            placeholder={String(autoCounts.foreign)}
            isValid={isCount}
            onCommit={(foreign) => patchOverride({ foreign })}
            hint="국가 코드가 KR이 아닌 팀입니다. 비워 두면 순위표에서 센 값을 씁니다."
          />
        </fieldset>

        <fieldset className="regional-sim-group">
          <legend>학교</legend>
          <InvitedSchoolPicker
            id="publish-wf-medal-groups"
            label="작년 WF 메달 학교"
            schools={schools}
            selected={value.wfMedalGroups}
            onChange={(wfMedalGroups) => patch({ wfMedalGroups })}
            hint="이 학교는 상위 3팀까지 계산에 남습니다. 다른 학교는 2팀입니다."
          />
          <InvitedSchoolPicker
            id="publish-winner-groups"
            label="다른 리저널 winner 학교"
            schools={schools}
            selected={value.winnerGroups}
            onChange={(winnerGroups) => patch({ winnerGroups })}
            hint="이 학교의 팀은 모두 계산에서 빠집니다."
          />
          <InvitedSchoolPicker
            id="publish-already-invited-groups"
            label="다른 경로로 이미 초청된 학교"
            schools={schools}
            selected={value.invitedGroups}
            onChange={(invitedGroups) => patch({ invitedGroups })}
            hint="이 학교의 팀은 모두 계산에서 빠집니다."
          />
          {invitedEmpty ? (
            <p className="publish-controls-hint" role="note">
              다른 리저널에서 이미 초청된 학교를 하나도 고르지 않았습니다. 이 정보는 대회
              데이터에 없으므로 직접 골라야 합니다. 비워 두면 그 학교 팀들이 순위 슬롯을
              차지해 아래 팀들이 밀리고, 진출 가능한 팀이 실제보다 적게 표시됩니다.
            </p>
          ) : null}
        </fieldset>

        <fieldset className="regional-sim-group">
          <legend>초청 기준</legend>
          <NumericField
            id="publish-invited-cutoff"
            label="가정 cutoff"
            value={value.cutoff}
            placeholder="예: 2.5"
            isValid={(v) => v >= 0}
            onCommit={(cutoff) => patch({ cutoff })}
            hint="value가 이 값 이하인 팀을 금색으로 표시합니다. 비워 두면 1위 팀만 금색입니다."
          />
        </fieldset>

        <details className="regional-sim-advanced">
          <summary>고급</summary>
          <div className="regional-sim-advanced-body">
            {COEFFICIENT_FIELDS.map(({ key, label }) => (
              <NumericField
                key={key}
                id={`publish-coef-${key}`}
                label={label}
                value={c[key]}
                required
                isValid={Number.isFinite}
                onCommit={(next) => {
                  // An empty or invalid coefficient keeps the last value.
                  if (next !== null) patch({ coefficients: { ...c, [key]: next } });
                }}
              />
            ))}
          </div>
        </details>

        <div className="regional-sim-footer">
          <a href={APAC_RULES_URL} target="_blank" rel="noreferrer noopener">
            ICPC Asia Pacific 2026-27 규정
          </a>
          {onReset !== undefined ? (
            <button
              type="button"
              className="publish-button"
              onClick={() => {
                onReset();
                setResetGen((n) => n + 1);
              }}
            >
              초기값으로 되돌리기
            </button>
          ) : null}
        </div>
      </div>
    </details>
  );
}
