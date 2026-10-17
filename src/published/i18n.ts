/**
 * Korean / English switch of the static public page (publish.html).
 *
 * - One typed message table: `Record<Lang, PublishedMessages>`, so a key that
 *   is missing in either language is a type error. The Korean texts are the
 *   original ones (the panel and the stage legend reuse the shared sources,
 *   which the prepare page keeps showing).
 * - The language is, in this order: `?lang=ko|en` in the address, the
 *   viewer's last choice (localStorage `kimchi.lang`), Korean. A value from
 *   the address is never saved. Every storage access may throw (private
 *   window, blocked site data); the page then just works without it.
 * - `useLang()` also keeps `<html lang>` in step; `LangToggle` is the button
 *   in the page header. Its label is the name of the other language.
 *
 * Must not import `@store` or `@core/ingest` (see the import guard test).
 */

import { createElement, useCallback, useEffect, useState, type ReactElement } from 'react';
import { PRELIM_STAGE_TAGS, prelimStageLegend, type PrelimStage } from '@core/preliminary';
import { APAC_STAR_TITLES } from '@ui/scoreboard/TeamRow';
import {
  REGIONAL_SIM_MESSAGES_KO,
  type RegionalSimMessages,
} from '@ui/publish/RegionalSimPanel';

export type Lang = 'ko' | 'en';

export const LANG_STORAGE_KEY = 'kimchi.lang';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface PublishedMessages {
  /** Regional mode: this is a simulation, not a result. */
  banner: string;
  /** Preliminary mode: what the yellow rows mean. */
  advanceLegend: string;
  /** Row tag per stage. */
  stageTags: Record<PrelimStage, string>;
  /** One legend line per stage, with the saved N and K. */
  stageLegend: (stage: PrelimStage, topN: number, k: number) => string;
  /** "3팀" / "3 teams": the count after a legend line (the caller adds the parentheses). */
  teamCount: (count: number) => string;
  /** Regional mode: the meaning of the star colors (a link to the rules follows). */
  starLegend: string;
  /** The error panel. */
  errorTitle: string;
  errorBody: string;
  /** The button in the header; the label names the other language. */
  langToggle: { label: string; ariaLabel: string };
  /** The shared regional simulation panel. */
  regional: RegionalSimMessages;
}

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

export const MESSAGES: Record<Lang, PublishedMessages> = {
  ko: {
    banner:
      '이 페이지는 시뮬레이션입니다. 공식 결과가 아닙니다. 최종 초청은 모든 리저널이 끝난 다음 APAC에서 정합니다.',
    advanceLegend: '노란색 = 본선 진출',
    stageTags: PRELIM_STAGE_TAGS,
    stageLegend: prelimStageLegend,
    teamCount: (count) => `${count}팀`,
    starLegend:
      '별의 의미: 동색 = 학내 3등 이내, 은색 = APAC championship 초대 가능, 금색 = APAC championship 진출.',
    errorTitle: '순위표를 표시할 수 없습니다',
    errorBody: '공개 데이터를 읽지 못했습니다. 운영자에게 알려 주세요.',
    langToggle: { label: 'English', ariaLabel: 'English로 보기' },
    regional: REGIONAL_SIM_MESSAGES_KO,
  },
  en: {
    banner:
      'This page is a simulation, not an official result. ICPC Asia Pacific decides the final invitations after all regionals end.',
    advanceLegend: 'Yellow = advances to the regional',
    stageTags: { top: 'Top', school: 'School', fill: 'Fill' },
    stageLegend: (stage, topN, k) => {
      switch (stage) {
        case 'top':
          return `Top: top ${topN} ${plural(topN, 'team', 'teams')} regardless of school`;
        case 'school':
          return `School: top team of each school that solved ${k} or more problems`;
        case 'fill':
          return 'Fill: next teams by rank to fill the remaining spots';
      }
    },
    teamCount: (count) => `${count} ${plural(count, 'team', 'teams')}`,
    starLegend: `Star colors: bronze = ${APAC_STAR_TITLES.bronze}, silver = ${APAC_STAR_TITLES.silver}, gold = ${APAC_STAR_TITLES.gold}.`,
    errorTitle: 'Cannot show the standings',
    errorBody: 'The public data could not be read. Please tell the operator.',
    // The label is the name of Korean in Korean script, as usual for a language switch.
    langToggle: { label: '한국어', ariaLabel: 'View in 한국어 (Korean)' },
    regional: {
      title: 'APAC qualification simulation inputs',
      scoreUnusable:
        'S is 0 or less, so values are not calculated. Check the preliminary school and team counts.',
      prelimSchoolsLabel: 'Preliminary schools U_p',
      prelimSchoolsHint: 'Schools with at least one team that solved 1 or more problems in the preliminary.',
      prelimTeamsLabel: 'Preliminary teams T_p',
      prelimTeamsHint: 'Teams that solved 1 or more problems in the preliminary.',
      prelimEmptyNote: 'An empty preliminary value counts as 0.',
      regionalSchoolsLabel: 'Regional schools U_r',
      regionalTeamsLabel: 'Regional teams T_r',
      regionalCountHint: 'If empty, the count from the standings is used.',
      regionalForeignLabel: 'Regional foreign teams F_r',
      regionalForeignHint:
        'Teams whose country code is not KR. If empty, the count from the standings is used.',
      schoolsLegend: 'Schools',
      wfMedalLabel: 'WF medal schools of last year',
      wfMedalHint: 'These schools keep up to 3 teams in the list. Other schools keep 2 teams.',
      winnerLabel: 'Schools that won another regional',
      droppedSchoolHint: 'All teams of these schools are removed from the list.',
      invitedLabel: 'Schools already invited by another path',
      invitedEmptyWarning:
        'You have not picked any school that is already invited by another regional. The contest data does not have this, so you must pick them. If you leave it empty, the teams of those schools take ranking slots, the teams below move down, and fewer teams are shown as able to advance than in reality.',
      cutoffLegend: 'Invitation rule',
      cutoffLabel: 'Assumed cutoff',
      cutoffPlaceholder: 'e.g. 2.5',
      cutoffHint:
        'Teams with a value at or below this are gold. If empty, only the first-place team is gold.',
      advanced: 'Advanced',
      coefficients: {
        regionalSchools: 'Regional schools coefficient',
        regionalTeams: 'Regional teams coefficient',
        prelimSchools: 'Preliminary schools coefficient',
        prelimTeams: 'Preliminary teams coefficient',
        foreignTeams: 'Regional foreign teams coefficient',
      },
      rulesLink: 'ICPC Asia Pacific 2026-27 rules',
      reset: 'Reset to initial values',
      picker: {
        none: 'None selected',
        more: (first, others) => `${first} and ${others} more`,
        filterPlaceholder: 'Search schools',
        empty: 'No school matches.',
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Language choice
// ---------------------------------------------------------------------------

function parseLang(value: unknown): Lang | null {
  return value === 'ko' || value === 'en' ? value : null;
}

/** `?lang=` in the address, else the saved choice, else Korean. */
export function initialLang(): Lang {
  try {
    const fromUrl = parseLang(new URLSearchParams(window.location.search).get('lang'));
    if (fromUrl !== null) return fromUrl;
  } catch {
    // No usable address: fall through.
  }
  try {
    const saved = parseLang(window.localStorage.getItem(LANG_STORAGE_KEY));
    if (saved !== null) return saved;
  } catch {
    // Storage blocked or missing: the default is fine.
  }
  return 'ko';
}

/** Remember a choice made with the toggle; failures are ignored. */
function persistLang(lang: Lang): void {
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // The choice then lasts for this visit only.
  }
  // A `?lang=` in the address wins at load time, so keep it in step with the
  // choice (otherwise a reload would undo it).
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('lang')) {
      url.searchParams.set('lang', lang);
      window.history.replaceState(window.history.state, '', url);
    }
  } catch {
    // Leave the address as it is.
  }
}

export function useLang(): [Lang, (lang: Lang) => void] {
  const [lang, setLangState] = useState<Lang>(initialLang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    persistLang(next);
  }, []);
  return [lang, setLang];
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

/** Header button: shows the other language's name and switches to it. */
export function LangToggle({
  lang,
  onChange,
}: {
  lang: Lang;
  onChange: (lang: Lang) => void;
}): ReactElement {
  const other: Lang = lang === 'ko' ? 'en' : 'ko';
  const { label, ariaLabel } = MESSAGES[lang].langToggle;
  return createElement(
    'button',
    {
      type: 'button',
      className: 'published-lang-toggle',
      lang: other,
      'aria-label': ariaLabel,
      onClick: () => onChange(other),
    },
    label,
  );
}
