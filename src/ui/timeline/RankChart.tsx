/**
 * Rank timeline chart (design 2026-11-15 §6.6). One SVG, one y axis (rank,
 * 1 at the top), x = contest minutes 0..end. Always the whole contest; the
 * current board minute is only the dashed "Now" marker.
 *
 * - One team: black step line + a full-height line per submission (green
 *   accepted, red rejected) with stacked, rotated labels — the operator's
 *   reference picture.
 * - 2–6 teams: one colored step line per team; accepted = filled dot with the
 *   problem letter, rejected = ring, both on the team's own line; runs after
 *   a solve are not drawn. Direct labels at the right end.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';

import type { Problem } from '@core/types';
import { TIMELINE_COLORS, type RankTimeline, type TimelineEvent } from '@core/timeline';
import { formatClock } from '@ui/chrome/Header';
import { ordinalSuffix } from '@ui/scoreboard/util';

export interface ChartTeam {
  id: string;
  slot: number;
  name: string;
}

export interface RankChartProps {
  timeline: RankTimeline;
  problems: readonly Problem[];
  teams: readonly ChartTeam[];
  currentMinute: number;
  freezeMinute: number | null;
}

type YMode = 'all' | 'fit';

const SINGLE_LINE = '#0b0b0b';
const AC = '#1f9d3a';
const REJ = '#d63a36';
const PENDING = '#9b9a95';
const SURFACE = '#fcfcfb';
const DEFAULT_SIZE = { width: 1000, height: 520 };

const ordinal = (n: number): string => `${n}${ordinalSuffix(n)}`;
const clock = (minute: number): string => formatClock(minute * 60);
const kindText: Record<TimelineEvent['kind'], string> = {
  accepted: 'accepted',
  rejected: 'rejected',
  noPenalty: 'compile error (no penalty)',
  pending: 'pending',
};

/** Rank ticks between a and b: steps of 10/5/2/1, ends included. */
export function rankTicks(a: number, b: number): number[] {
  const span = b - a;
  const step = span > 40 ? 10 : span > 16 ? 5 : span > 8 ? 2 : 1;
  const out = [a];
  for (let v = Math.ceil((a + 1) / step) * step; v < b; v += step) {
    if (v - out[out.length - 1] >= step / 2) out.push(v);
  }
  if (b > a) {
    if (b - out[out.length - 1] >= step / 2) out.push(b);
    else out[out.length - 1] = b;
  }
  return out;
}

function subLabel(e: TimelineEvent, letter: string): string {
  return letter + (e.kind === 'noPenalty' ? '*' : e.kind === 'pending' ? '?' : '') + (e.count > 1 ? ` ×${e.count}` : '');
}

function useSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState(DEFAULT_SIZE);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export function RankChart({ timeline, problems, teams, currentMinute, freezeMinute }: RankChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const { width: W, height: H } = useSize(wrapRef);
  const [yMode, setYMode] = useState<YMode>('all');
  const [hover, setHover] = useState<{ t: number; x: number; y: number } | null>(null);

  const letter = useMemo(() => new Map(problems.map((p) => [p.id, p.label])), [problems]);
  const single = teams.length === 1;
  const E = timeline.endMinute;
  const N = timeline.teamCount;
  const colorOf = (t: ChartTeam): string => (single ? SINGLE_LINE : TIMELINE_COLORS[t.slot]);

  let y0 = 1;
  let y1 = Math.max(N, 2);
  if (yMode === 'fit' && teams.length > 0) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of teams) for (const r of timeline.ranks.get(t.id) ?? []) {
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
    }
    y0 = Math.max(1, lo - 2);
    y1 = Math.min(Math.max(N, 2), hi + 2);
    if (y1 - y0 < 6) y1 = Math.min(Math.max(N, 2), y0 + 6);
  }

  const m = { l: 52, r: single || teams.length === 0 ? 24 : 190, t: 14, b: 36 };
  const pw = Math.max(10, W - m.l - m.r);
  const ph = Math.max(10, H - m.t - m.b);
  const X = (t: number): number => m.l + (E === 0 ? 0 : (t / E) * pw);
  const Y = (r: number): number => m.t + ((r - y0) / Math.max(1, y1 - y0)) * ph;

  const stepPath = (ranks: readonly number[]): string => {
    let d = `M${X(0).toFixed(1)},${Y(ranks[0]).toFixed(1)}`;
    for (let t = 0; t < E; t++) {
      d += `H${X(t + 1).toFixed(1)}`;
      if (ranks[t + 1] !== ranks[t]) d += `V${Y(ranks[t + 1]).toFixed(1)}`;
    }
    return d;
  };

  const xTicks: number[] = [];
  for (let t = 0; t <= E; t += 30) xTicks.push(t);

  const onMove = (event: MouseEvent<SVGRectElement>) => {
    const box = (event.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const t = Math.max(0, Math.min(E, Math.round(((event.clientX - box.left - m.l) / pw) * E)));
    setHover({ t, x: event.clientX - box.left, y: event.clientY - box.top });
  };

  // Single team: stacked submission labels (a new row when closer than 13 px).
  const singleMarks: { e: TimelineEvent; x: number; row: number }[] = [];
  if (single) {
    const rowsLastX: number[] = [];
    for (const e of timeline.events.get(teams[0].id) ?? []) {
      const x = X(e.minute);
      let row = 0;
      while (rowsLastX[row] !== undefined && x - rowsLastX[row] < 13) row += 1;
      rowsLastX[row] = x;
      singleMarks.push({ e, x, row });
    }
  }

  const ends = teams
    .map((t) => ({ team: t, rank: timeline.ranks.get(t.id)?.[E] ?? N, y: Y(timeline.ranks.get(t.id)?.[E] ?? N) }))
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 15);

  return (
    <section className="tl-card tl-chart-card" aria-label="Rank timeline">
      <h2 className="tl-card-title">{single ? `${teams[0].name} · Rank timeline` : 'Rank timeline'}</h2>
      <div className="tl-ctrl">
        <span>Y axis</span>
        <span className="tl-seg">
          <button type="button" aria-pressed={yMode === 'all'} className={yMode === 'all' ? 'on' : ''} onClick={() => setYMode('all')}>
            {`All ranks 1–${N}`}
          </button>
          <button type="button" aria-pressed={yMode === 'fit'} className={yMode === 'fit' ? 'on' : ''} onClick={() => setYMode('fit')}>
            Selected teams
          </button>
        </span>
      </div>
      <div className="tl-legend">
        {single ? (
          <>
            <span><i className="tl-sw" style={{ borderColor: SINGLE_LINE }} />Rank</span>
            <span><i className="tl-sw" style={{ borderColor: AC }} />Accepted</span>
            <span><i className="tl-sw" style={{ borderColor: REJ }} />Rejected</span>
          </>
        ) : teams.length > 0 ? (
          <>
            {teams.map((t) => (
              <span key={t.id}><i className="tl-sw" style={{ borderColor: colorOf(t) }} />{t.name}</span>
            ))}
            <span><i className="tl-dot" />Accepted (problem letter)</span>
            <span><i className="tl-ring" />Rejected</span>
          </>
        ) : null}
      </div>
      <div className="tl-plot" ref={wrapRef}>
        <svg width={W} height={H} role="img" aria-label="Rank over contest time">
          <defs>
            <clipPath id="tl-plot-clip">
              <rect x={m.l} y={m.t - 6} width={pw + 8} height={ph + 12} />
            </clipPath>
          </defs>
          {freezeMinute !== null && freezeMinute < E ? (
            <g>
              <rect data-testid="freeze-band" x={X(freezeMinute)} y={m.t} width={X(E) - X(freezeMinute)} height={ph} fill="rgba(120,140,180,0.10)" />
              <text x={X(freezeMinute) + 6} y={m.t + ph - 6} className="tl-axis-text">Frozen</text>
            </g>
          ) : null}
          {rankTicks(y0, y1).map((r) => (
            <g key={`y${r}`}>
              <line x1={m.l} x2={m.l + pw} y1={Y(r)} y2={Y(r)} stroke="#e6e5e0" />
              <text x={m.l - 8} y={Y(r) + 4} textAnchor="end" className="tl-axis-text tl-y-tick">{r}</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <g key={`x${t}`}>
              <line x1={X(t)} x2={X(t)} y1={m.t + ph} y2={m.t + ph + 4} stroke="#9b9a95" />
              <text x={X(t)} y={m.t + ph + 18} textAnchor="middle" className="tl-axis-text">{clock(t)}</text>
            </g>
          ))}
          <line x1={m.l} x2={m.l + pw} y1={m.t + ph} y2={m.t + ph} stroke="#9b9a95" />
          <text x={14} y={m.t + ph / 2} transform={`rotate(-90 14 ${m.t + ph / 2})`} textAnchor="middle" className="tl-axis-text">Rank</text>
          {currentMinute < E ? (
            <g>
              <line x1={X(currentMinute)} x2={X(currentMinute)} y1={m.t} y2={m.t + ph} stroke="#1f2430" strokeDasharray="4 3" />
              <text data-testid="now-marker" x={X(currentMinute) - 4} y={m.t + ph - 6} textAnchor="end" className="tl-axis-text tl-now">
                {`Now ${clock(currentMinute)}`}
              </text>
            </g>
          ) : null}

          {single
            ? singleMarks.map(({ e, x, row }) => {
                const color = e.kind === 'accepted' ? AC : e.kind === 'pending' ? PENDING : REJ;
                const ty = m.t + 6 + row * 40;
                return (
                  <g key={`s${e.firstSeq}`}>
                    <line data-kind={e.kind} x1={x} x2={x} y1={m.t} y2={m.t + ph} stroke={color} strokeOpacity={0.55} />
                    <text
                      className="tl-sub-label"
                      x={x + 4}
                      y={ty}
                      transform={`rotate(-90 ${x + 4} ${ty})`}
                      textAnchor="end"
                      fill={color}
                      stroke={SURFACE}
                      strokeWidth={3}
                      paintOrder="stroke"
                    >
                      {subLabel(e, letter.get(e.problemId) ?? '?')}
                    </text>
                  </g>
                );
              })
            : null}

          {teams.map((t) => {
            const ranks = timeline.ranks.get(t.id);
            if (ranks === undefined) return null;
            return (
              <path
                key={`p${t.id}`}
                data-team={t.id}
                d={stepPath(ranks)}
                fill="none"
                stroke={colorOf(t)}
                strokeWidth={single ? 2 : 2.25}
                strokeLinejoin="round"
                clipPath="url(#tl-plot-clip)"
              />
            );
          })}

          {!single
            ? teams.map((t) =>
                (timeline.events.get(t.id) ?? [])
                  .filter((e) => !e.afterSolve && e.kind !== 'pending')
                  .map((e) => {
                    const cx = X(e.minute);
                    const cy = Y(timeline.ranks.get(t.id)![e.minute]);
                    return e.kind === 'accepted' ? (
                      <g key={`m${t.id}-${e.firstSeq}`}>
                        <circle data-kind="accepted" cx={cx} cy={cy} r={5} fill={colorOf(t)} stroke={SURFACE} strokeWidth={2} />
                        <text x={cx} y={cy - 9} textAnchor="middle" className="tl-dot-label" stroke={SURFACE} strokeWidth={3} paintOrder="stroke">
                          {letter.get(e.problemId) ?? '?'}
                        </text>
                      </g>
                    ) : (
                      <circle key={`m${t.id}-${e.firstSeq}`} data-kind={e.kind} cx={cx} cy={cy} r={3.2} fill={SURFACE} stroke={colorOf(t)} strokeWidth={1.5} />
                    );
                  }),
              )
            : null}

          {!single
            ? ends.map(({ team, rank, y }) => (
                <g key={`e${team.id}`}>
                  <circle cx={X(E) + 10} cy={y - 4} r={4} fill={colorOf(team)} />
                  <text data-testid={`end-label-${team.id}`} x={X(E) + 18} y={y} className="tl-end-label">
                    {`${ordinal(rank)} ${team.name}`}
                  </text>
                </g>
              ))
            : null}

          {teams.length > 0 ? (
            <>
              {hover !== null ? (
                <line x1={X(hover.t)} x2={X(hover.t)} y1={m.t} y2={m.t + ph} stroke="#555" strokeOpacity={0.5} pointerEvents="none" />
              ) : null}
              <rect
                x={m.l}
                y={m.t}
                width={pw}
                height={ph}
                fill="transparent"
                onMouseMove={onMove}
                onMouseLeave={() => setHover(null)}
              />
            </>
          ) : null}
        </svg>
        {hover !== null && teams.length > 0 ? (
          <div className="tl-tip" style={{ left: hover.x + 230 > W ? hover.x - 240 : hover.x + 14, top: hover.y + 10 }}>
            <h4>{`${clock(hover.t)} (minute ${hover.t})`}</h4>
            {teams.map((t) => {
              const ranks = timeline.ranks.get(t.id)!;
              const events = (timeline.events.get(t.id) ?? []).filter((e) => e.minute === hover.t);
              return (
                <div key={t.id}>
                  <div className="tl-tip-team">
                    <i style={{ background: colorOf(t) }} />
                    <span>{t.name}</span>
                    <b>{ordinal(ranks[hover.t])}</b>
                  </div>
                  {events.map((e) => (
                    <div key={e.firstSeq} className="tl-tip-ev">
                      {`${letter.get(e.problemId) ?? '?'} ${kindText[e.kind]}${e.count > 1 ? ` ×${e.count}` : ''}`}
                      {e.kind === 'accepted' && !e.afterSolve
                        ? ` · ${ranks[Math.max(0, hover.t - 1)]} → ${ranks[hover.t]}`
                        : ''}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ) : null}
        {teams.length === 0 ? <div className="tl-empty">Pick teams on the left.</div> : null}
      </div>
      <p className="tl-foot">
        {'* no penalty (compile error) · ×N: N submissions in the same minute'}
        {freezeMinute !== null ? ` · gray area: frozen (from minute ${freezeMinute})` : ''}
      </p>
    </section>
  );
}
