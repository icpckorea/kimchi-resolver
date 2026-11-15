/**
 * Timeline team picker (design 2026-11-15 §6.6): search, selected chips,
 * and every team sorted by its rank at the current board minute (not the
 * final rank, so the list does not spoil a replay).
 */
import { useMemo, useState } from 'react';

import type { Team } from '@core/types';
import { TIMELINE_COLORS, TIMELINE_MAX_TEAMS } from '@core/timeline';
import type { TimelineTeam } from '@store/appStore';

export interface TeamPickerProps {
  teams: readonly Team[];
  /** Rank of a team at the current board minute. */
  rankOf: (teamId: string) => number;
  selected: readonly TimelineTeam[];
  onToggle: (teamId: string) => void;
  onRemove: (teamId: string) => void;
}

export function TeamPicker({ teams, rankOf, selected, onToggle, onRemove }: TeamPickerProps) {
  const [query, setQuery] = useState('');
  const selectedIds = useMemo(() => new Set(selected.map((t) => t.id)), [selected]);
  const byId = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const full = selected.length >= TIMELINE_MAX_TEAMS;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return teams
      .filter((t) => q === '' || t.name.toLowerCase().includes(q) || t.group.toLowerCase().includes(q))
      .sort((a, b) => rankOf(a.id) - rankOf(b.id) || a.name.localeCompare(b.name));
  }, [teams, query, rankOf]);

  return (
    <section className="tl-card tl-picker" aria-label="Teams">
      <h2 className="tl-card-title">Teams</h2>
      <p className="tl-hint">Compare up to 6 teams. You can also click a team on the board.</p>
      <input
        type="search"
        className="tl-search"
        placeholder="Search teams or schools"
        aria-label="Search teams or schools"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="tl-chips">
        {selected.map(({ id, slot }) => {
          const team = byId.get(id);
          if (team === undefined) return null;
          return (
            <span key={id} className="tl-chip">
              <i style={{ background: TIMELINE_COLORS[slot] }} />
              {team.name}
              <button type="button" aria-label={`Remove ${team.name}`} onClick={() => onRemove(id)}>
                ×
              </button>
            </span>
          );
        })}
      </div>
      <div className="tl-picker-list">
        {rows.map((team) => {
          const on = selectedIds.has(team.id);
          return (
            <label key={team.id} className={!on && full ? 'tl-picker-row tl-picker-row--disabled' : 'tl-picker-row'}>
              <input type="checkbox" checked={on} disabled={!on && full} onChange={() => onToggle(team.id)} />
              <span className="tl-picker-rank">{rankOf(team.id)}</span>
              <span className="tl-picker-name">
                {team.name}
                <span className="tl-picker-school">{team.group}</span>
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}
