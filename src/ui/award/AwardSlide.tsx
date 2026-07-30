/**
 * Full-screen award slide (spec §6/§7): rank text, medal icon, team
 * name/group, label badges and co-recipients from an awards.json v2 entry.
 * Shown on finalize and re-shown by clicking a finalized medalist's name;
 * Escape (handled by AwardView) or a backdrop click closes it.
 */
import { motion } from 'framer-motion';

import { AwardMedal, iconRegistry } from '@ui/icons';
import { humanizeRank, type AwardEntry } from './awardsData';

export interface AwardSlideOther {
  name: string;
  group?: string;
}

export interface AwardSlideProps {
  entry: AwardEntry;
  teamName: string;
  teamGroup: string;
  /** Resolved co-recipients (team ids already mapped to names). */
  others: AwardSlideOther[];
  onClose: () => void;
}

export function AwardSlide({ entry, teamName, teamGroup, others, onClose }: AwardSlideProps) {
  const Icon = (entry.icon !== undefined ? iconRegistry[entry.icon] : undefined) ?? AwardMedal;
  return (
    <motion.div
      className="award-slide-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Award: ${humanizeRank(entry.rank)}`}
      data-testid="award-slide"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      onClick={onClose}
    >
      <motion.div
        className="award-slide-card"
        initial={{ scale: 0.85, y: '0.5em', opacity: 0 }}
        animate={{ scale: 1, y: '0em', opacity: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 22 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="award-slide-icon">
          <Icon size="4.5em" />
        </div>
        <div className="award-slide-rank" data-testid="award-slide-rank">
          {humanizeRank(entry.rank)}
        </div>
        <div className="award-slide-team" data-testid="award-slide-team">
          {teamName}
        </div>
        <div className="award-slide-group">{teamGroup}</div>
        {entry.labels.length > 0 ? (
          <div className="award-slide-labels">
            {entry.labels.map((label) => (
              <span key={label} className="award-badge">
                {label}
              </span>
            ))}
          </div>
        ) : null}
        {others.length > 0 ? (
          <div className="award-slide-others">
            <div className="award-slide-others-title">also awarded</div>
            <ul>
              {others.map((other, i) => (
                <li key={`${other.name}-${i}`}>
                  <span className="award-slide-other-name">{other.name}</span>
                  {other.group !== undefined && other.group !== '' ? (
                    <span className="award-slide-other-group"> — {other.group}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </motion.div>
    </motion.div>
  );
}
