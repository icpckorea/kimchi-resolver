/**
 * Preliminary prepare-page inputs (publish-modes spec §5.2): T (teams that
 * advance), N (top N regardless of school) and K (minimum solved count of a
 * school's best team), plus the result summary and the selection warnings.
 *
 * Controlled and store-free; the ineligible checkboxes live on the board
 * rows (PublishView). While T or K is empty there is no selection, and the
 * panel asks for them instead (spec §5.1).
 */

import type { PrelimResult } from '@core/preliminary';
import type { PrelimInputs } from './persist';
import { NumericField } from './RegionalSimPanel';
import './publish.css';

export interface PrelimControlsProps {
  value: PrelimInputs;
  onChange: (patch: Partial<PrelimInputs>) => void;
  /** null while T or K is empty. */
  result: PrelimResult | null;
}

/** "진출 X팀 = 상위 a + 학교 대표 b + 추가 c" */
export function prelimSummaryText(result: PrelimResult): string {
  const { top, school, fill } = result.counts;
  return `진출 ${result.selected.size}팀 = 상위 ${top} + 학교 대표 ${school} + 추가 ${fill}`;
}

const isPositiveInt = (v: number): boolean => Number.isInteger(v) && v >= 1;
const isCount = (v: number): boolean => Number.isInteger(v) && v >= 0;

export function PrelimControls({ value, onChange, result }: PrelimControlsProps) {
  return (
    <section className="publish-controls publish-prelim" aria-label="예선 진출 입력">
      <NumericField
        id="publish-prelim-total"
        label="진출 팀 수 T"
        value={value.totalTeams}
        placeholder="예: 60"
        isValid={isPositiveInt}
        onCommit={(totalTeams) => onChange({ totalTeams })}
        hint="본선에 진출하는 팀 수입니다."
      />
      <NumericField
        id="publish-prelim-topn"
        label="상위 N"
        value={value.topN}
        required
        isValid={isCount}
        onCommit={(topN) => {
          // N is never empty: an invalid entry keeps the last value.
          if (topN !== null) onChange({ topN });
        }}
        hint="학교와 관계없이 순위대로 선발하는 팀 수입니다."
      />
      <NumericField
        id="publish-prelim-k"
        label="K"
        value={value.k}
        placeholder="예: 2"
        isValid={isCount}
        onCommit={(k) => onChange({ k })}
        hint="상위 N팀이 없는 학교는 최상위 팀이 K문제 이상을 풀면 선발합니다."
      />

      <div className="publish-prelim-result">
        {result === null ? (
          <p className="publish-prelim-pending" role="status">
            진출 팀 수와 K를 입력하세요
          </p>
        ) : (
          <>
            <p className="publish-prelim-summary" role="status">
              {prelimSummaryText(result)}
            </p>
            {result.warnings.length > 0 ? (
              <ul className="publish-prelim-warnings" role="alert">
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </>
        )}
        <p className="publish-field-note">
          순위표 왼쪽의 체크박스를 켜면 그 팀은 미자격입니다. 미자격 팀은 선발하지 않습니다.
        </p>
      </div>
    </section>
  );
}
