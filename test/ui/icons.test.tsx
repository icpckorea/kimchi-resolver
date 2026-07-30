import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import {
  Activity,
  ApacStar,
  AwardMedal,
  AwardStar,
  Balloon,
  Bell,
  ChevronLeft,
  ChevronRight,
  Clock,
  FastForward,
  FlagIcon,
  MEDAL_COLORS,
  Medal,
  MedalBronze,
  MedalGold,
  MedalSilver,
  Pause,
  Play,
  RefreshCw,
  Search,
  StepForward,
  ThumbsUp,
  Trophy,
  X,
  iconRegistry,
} from '@ui/icons';

function getSvg(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg');
  expect(svg).not.toBeNull();
  return svg as SVGSVGElement;
}

describe('Balloon', () => {
  it('tints the body via --balloon-color and keeps a fixed outline + highlight', () => {
    const { container } = render(<Balloon color="ivory" />);
    const svg = getSvg(container);
    expect(svg.style.getPropertyValue('--balloon-color')).toBe('ivory');
    const body = svg.querySelector('path[fill^="var(--balloon-color"]');
    expect(body).not.toBeNull();
    expect(body?.getAttribute('stroke')).toBe('#3b3f46');
    const highlight = svg.querySelector('ellipse');
    expect(highlight?.getAttribute('fill')).toBe('#fff');
  });

  it('accepts hex colors, size and className', () => {
    const { container } = render(<Balloon color="#123456" size={30} className="cell-balloon" />);
    const svg = getSvg(container);
    expect(svg.style.getPropertyValue('--balloon-color')).toBe('#123456');
    expect(svg.getAttribute('height')).toBe('30');
    expect(svg.classList.contains('cell-balloon')).toBe(true);
    expect(svg.classList.contains('kr-icon')).toBe(true);
  });
});

describe('ApacStar', () => {
  it.each([
    ['bronze', '#c07a3e'],
    ['silver', '#b8bfc9'],
    ['gold', '#e6b422'],
  ] as const)('renders the %s tier with fill %s', (tier, fill) => {
    const { container } = render(<ApacStar tier={tier} />);
    const polygon = getSvg(container).querySelector('polygon');
    expect(polygon?.getAttribute('fill')).toBe(fill);
    // 5-point star = 10 vertices
    expect(polygon?.getAttribute('points')?.split(' ')).toHaveLength(10);
  });

  it('adds the spin class only when spinning', () => {
    const spinning = getSvg(render(<ApacStar tier="gold" spinning />).container);
    expect(spinning.classList.contains('kr-apac-star--spin')).toBe(true);
    const still = getSvg(render(<ApacStar tier="gold" />).container);
    expect(still.classList.contains('kr-apac-star--spin')).toBe(false);
  });
});

describe('FlagIcon', () => {
  it.each(['KR', 'JP', 'TW', 'CN', 'US'] as const)('renders a specific flag for %s', (code) => {
    const svg = getSvg(render(<FlagIcon country={code} />).container);
    expect(svg.getAttribute('data-country')).toBe(code);
    expect(svg.getAttribute('viewBox')).toBe('0 0 36 24');
  });

  it('is case-insensitive', () => {
    const svg = getSvg(render(<FlagIcon country="kr" />).container);
    expect(svg.getAttribute('data-country')).toBe('KR');
  });

  it('falls back to the generic flag for unknown or missing codes', () => {
    for (const country of ['ZZ', '', undefined, null]) {
      const svg = getSvg(render(<FlagIcon country={country} />).container);
      expect(svg.getAttribute('data-country')).toBe('generic');
      expect(svg.querySelector('.kr-flag-generic')).not.toBeNull();
    }
  });

  it('keeps a 3:2 ratio for numeric sizes and draws a border', () => {
    const svg = getSvg(render(<FlagIcon country="JP" size={36} />).container);
    expect(svg.getAttribute('width')).toBe('36');
    expect(svg.getAttribute('height')).toBe('24');
    const border = svg.querySelector('rect[fill="none"]');
    expect(border?.getAttribute('stroke')).toContain('rgba');
  });

  it('uses unique clipPath ids across instances', () => {
    const { container } = render(
      <>
        <FlagIcon country="KR" />
        <FlagIcon country="JP" />
      </>,
    );
    const ids = Array.from(container.querySelectorAll('clipPath')).map((c) => c.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('header/action icons', () => {
  const icons = {
    Bell,
    RefreshCw,
    Play,
    Pause,
    StepForward,
    FastForward,
    Activity,
    ChevronLeft,
    ChevronRight,
    Search,
    Clock,
    Medal,
    X,
    ThumbsUp,
  };

  it.each(Object.entries(icons))('%s renders a 24px currentColor stroke svg', (_name, Icon) => {
    const svg = getSvg(render(<Icon />).container);
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('stroke-width')).toBe('2');
    expect(svg.getAttribute('width')).toBe('24');
  });

  it('applies size and className props', () => {
    const svg = getSvg(render(<Bell size={16} className="hdr" />).container);
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('height')).toBe('16');
    expect(svg.classList.contains('hdr')).toBe(true);
  });

  it('is aria-hidden without a title and labeled with one', () => {
    const hidden = getSvg(render(<Play />).container);
    expect(hidden.getAttribute('aria-hidden')).toBe('true');
    const titled = getSvg(render(<Play title="auto-play" />).container);
    expect(titled.getAttribute('aria-hidden')).toBeNull();
    expect(titled.querySelector('title')?.textContent).toBe('auto-play');
  });
});

describe('award icons', () => {
  it('medal variants use the tier fills', () => {
    const cases = [
      [MedalGold, MEDAL_COLORS.gold],
      [MedalSilver, MEDAL_COLORS.silver],
      [MedalBronze, MEDAL_COLORS.bronze],
    ] as const;
    for (const [Icon, fill] of cases) {
      const svg = getSvg(render(<Icon />).container);
      const disc = svg.querySelector(`circle[fill="${fill}"]`);
      expect(disc).not.toBeNull();
    }
  });

  it('AwardMedal accepts an arbitrary fill', () => {
    const svg = getSvg(render(<AwardMedal fill="hotpink" />).container);
    expect(svg.querySelector('circle[fill="hotpink"]')).not.toBeNull();
  });

  it('Trophy and AwardStar render filled shapes', () => {
    const trophy = getSvg(render(<Trophy />).container);
    expect(trophy.querySelector(`path[fill="${MEDAL_COLORS.gold}"]`)).not.toBeNull();
    const star = getSvg(render(<AwardStar />).container);
    expect(star.querySelector('polygon')?.getAttribute('fill')).toBe(MEDAL_COLORS.gold);
  });
});

describe('iconRegistry', () => {
  it('maps every awards.json icon name to a renderable component', () => {
    expect(Object.keys(iconRegistry).sort()).toEqual([
      'medal_bronze',
      'medal_gold',
      'medal_silver',
      'star',
      'thumb_up',
      'trophy',
    ]);
    for (const [name, Icon] of Object.entries(iconRegistry)) {
      const svg = getSvg(render(<Icon />).container);
      expect(svg, `registry icon ${name}`).not.toBeNull();
    }
  });
});
