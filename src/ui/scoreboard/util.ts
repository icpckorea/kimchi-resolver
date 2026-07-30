/**
 * Scoreboard-local helpers: class joining, rank ordinals and the solved-count
 * color spine (HSV red→green interpolation ported verbatim from the original
 * spotboard — see docs/spotboard-analysis.md §1.3 / spotboard.view.js).
 */

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
