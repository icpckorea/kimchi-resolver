/**
 * Scoreboard-local helpers: class joining, rank ordinals, the solved-count
 * color spine (HSV red→green interpolation ported verbatim from the original
 * spotboard — see docs/spotboard-analysis.md §1.3 / spotboard.view.js) and
 * the text-fit estimate that keeps team names fully visible (spec §7).
 */
import type { CSSProperties } from 'react';

/** Join class names, skipping falsy values. */
export function cls(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

/** English ordinal suffix: 1→st, 2→nd, 3→rd, 4→th, 11..13→th. */
export function ordinalSuffix(n: number): string {
  const rem100 = Math.abs(n) % 100;
  if (rem100 >= 11 && rem100 <= 13) return 'th';
  switch (Math.abs(n) % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

/**
 * HSV → '#rrggbb'. Hue is a [0, 1) fraction of the circle and wraps (the
 * original passes a slightly negative hue for solved = 0). Port of
 * Spotboard.Util.hsv2rgb.
 */
export function hsv2rgb(h: number, s: number, v: number): string {
  h = ((h % 1) + 1) % 1; // wrap hue

  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));

  let rgb: [number, number, number];
  switch (i) {
    case 0:
      rgb = [v, t, p];
      break;
    case 1:
      rgb = [q, v, p];
      break;
    case 2:
      rgb = [p, v, t];
      break;
    case 3:
      rgb = [p, q, v];
      break;
    case 4:
      rgb = [t, p, v];
      break;
    case 5:
      rgb = [v, p, q];
      break;
    default:
      rgb = [0, 0, 0];
  }

  return `#${rgb
    .map((channel) => Math.floor(channel * 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Original interpolation endpoints (spotboard.view.js initStyles). */
const HSV_FROM: readonly [number, number, number] = [-2 / 360, 0.96, 0.31];
const HSV_TO: readonly [number, number, number] = [105 / 360, 0.96, 0.31];

/**
 * Solved-count spine color: linear HSV interpolation from red (0 solved) to
 * green (all solved). Odd solved counts are desaturated and brightened so
 * that neighboring bands stay distinguishable (original behavior).
 */
export function solvedSpineColor(solved: number, problemCount: number): string {
  const ratio = problemCount > 0 ? solved / problemCount : 0;
  const h = HSV_FROM[0] * (1 - ratio) + HSV_TO[0] * ratio;
  let s = HSV_FROM[1] * (1 - ratio) + HSV_TO[1] * ratio;
  let v = HSV_FROM[2] * (1 - ratio) + HSV_TO[2] * ratio;
  if (solved % 2 === 1) {
    s = Math.max(s - 0.15, 0);
    v = Math.min(v + 0.1, 1);
  }
  return hsv2rgb(h, s, v);
}

// ---------------------------------------------------------------------------
// Text fit (spec §7: "팀명은 항상 완전히 표시")
// ---------------------------------------------------------------------------

/**
 * Approximate advance width of one code point, in em of its own font size,
 * for the app's Open Sans-ish sans stack (index.css). Only rough classes are
 * needed: the value feeds a "shrink the font until the text fits" CSS clamp,
 * where over-estimating merely makes a very long name a hair smaller.
 */
function charEm(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;

  // Hangul / kana / Han / fullwidth forms: square (1em) glyphs.
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x20000
  ) {
    return 1;
  }
  if (code >= 0x1f000) return 1.2; // emoji and other pictographs
  if (ch === ' ') return 0.28;
  if ('iljItf.,;:!|\'`()[]{}'.includes(ch)) return 0.32;
  if ('r-"/\\'.includes(ch)) return 0.4;
  if (ch === 'm' || ch === 'w') return 0.85;
  if (ch === 'M' || ch === 'W') return 0.92;
  if (ch >= 'A' && ch <= 'Z') return 0.68;
  if (ch >= '0' && ch <= '9') return 0.56;
  return 0.55; // lowercase latin and everything else
}

/**
 * Estimated rendered width of `text` in em (of the element's own font size).
 * Never returns 0 — the CSS below divides by it, and a division by zero would
 * invalidate the declaration.
 */
export function estimateTextEm(text: string): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return Math.max(1, Math.round(em * 100) / 100);
}

/**
 * Inline custom properties that let `.team-name` / `.team-group` scale their
 * font down instead of truncating (scoreboard.css, `--kr-name-budget`).
 * The name column reserves that budget and never shrinks, so a name always
 * renders in full — no `text-overflow: ellipsis` anywhere on the board.
 */
export function nameFitStyle(name: string): CSSProperties {
  return { '--kr-name-em': String(estimateTextEm(name)) } as CSSProperties;
}

/** Same idea for the school line (`--kr-group-em`). */
export function groupFitStyle(group: string): CSSProperties {
  return { '--kr-group-em': String(estimateTextEm(group)) } as CSSProperties;
}
