import { describe, expect, it } from 'vitest';

import { timelineHref } from '@ui/timeline/timelineUrl';

describe('timelineHref', () => {
  it('sets view and teams and keeps the other params', () => {
    const href = timelineHref('https://x.test/tm/index.html?time=200&q=kaist', 'timeline', [{ id: '48', slot: 0 }, { id: '38', slot: 1 }]);
    const url = new URL(href);
    expect(url.searchParams.get('time')).toBe('200');
    expect(url.searchParams.get('q')).toBe('kaist');
    expect(url.searchParams.get('view')).toBe('timeline');
    expect(url.searchParams.get('teams')).toBe('48,38');
  });

  it('removes view for the board and teams when none are selected', () => {
    const href = timelineHref('https://x.test/tm/?view=timeline&teams=1,2&time=5', 'board', []);
    const url = new URL(href);
    expect(url.searchParams.has('view')).toBe(false);
    expect(url.searchParams.has('teams')).toBe(false);
    expect(url.searchParams.get('time')).toBe('5');
  });
});
