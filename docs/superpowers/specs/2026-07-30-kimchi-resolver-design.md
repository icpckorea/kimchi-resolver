# kimchi-resolver 설계 문서

작성일: 2026-07-30. 기반 분석: [`docs/spotboard-analysis.md`](../../spotboard-analysis.md).

## 1. 목표

`~/Projects/spotboard`(ACM-ICPC 스코어보드 웹앱, jQuery/RequireJS/CoffeeScript, ~2017)를 현대적 스택으로 재작성한다. 기능은 원본과 동등하되, 분석에서 확인된 버그는 수정하고, 아래 재기획 항목을 반영한다.

테스트 데이터: 2025 ICPC Asia Seoul Regional 샘플
- `http://static.icpckorea.net/2025/regional/scoreboard/sample/contest.json` (13문제, 84팀, 51개 학교)
- `http://static.icpckorea.net/2025/regional/scoreboard/sample/runs.json` (1,227 runs, 300분)

## 2. 확정된 결정 사항

| 항목 | 결정 |
|---|---|
| 스택 | React + Vite + TypeScript, 상태는 zustand, 테스트는 vitest |
| 비주얼 | 기존 룩앤필 재현 (색 스파인, flip, balloon 등) |
| 범위 | 전체 기능 재현. 원본 dead code(flot, hotkeys)는 제외 |
| 데이터 소스 | ICPC Contest API(DOMjudge/CDS 직결) + spotboard JSON, 어댑터 2개 |
| exclude 팀 | 수신 시점에 완전 제거 — 어떤 랭킹에도 포함하지 않음 (원본은 랭킹 포함 + 표시만 숨김 → 순위 gap) |
| foreign 재기획 | ICPC 랭킹(전체 팀)과 국내(대학생프로그래밍경시대회) 랭킹(국내 팀만)을 분리, 두 순위 항상 동시 노출. 외국 팀은 국내 랭킹 없음 |
| award 진행 순서 | 국내/외국 구분 없이 ICPC 랭킹 통합 최하위부터 |
| award 키 입력 | Enter / → / 세미콜론 / **PageDown** = 진행, Esc = 슬라이드 닫기, PageUp = 무동작 |
| 설정 | 런타임 `config.json` (전부 선언적, 함수 predicate 없음) + URL 파라미터 override |
| 학교 메타데이터 | 국기 표시, 학교 로고 토글, 애셋 누락 경고 |
| 아이콘 | 국기·별 등은 이모지 금지, SVG 애셋 사용 (Windows 국기 이모지 미지원) |
| 교내 순위 표시 | ~~학교 내 1등 왕관~~ 취소 — APAC 별 스펙(13장)으로 완전 대체 |
| 칭호 라벨 | awards.json v2의 `labels`(수동) + 스냅샷 파생 자동 칭호 5종을 팀 행 배지로 표시. 시상식에서 수동 칭호는 finalize 시점에 공개 |
| 피날레 연출 | 대회 첫 Yes 셀 sparkle, 시상식 최종 공개 셀 스포트라이트+확대(5초 후 복원) |
| APAC 표시 | `apac` 플래그: 교내 3위까지 별 아이콘(동→은→금 단계 변경, 회전 애니메이션). 14장 참조 |
| publish 모드 | 공지용 static scoreboard 모드 신설. site score 입력 필수, invited cutoff 입력으로 금색 별 판정 |
| 모바일 | spectator·publish 한정 768px 이하 압축 행(순위·별·국기·팀명·솔브/페널티) + 행 탭 시 격자·칭호 모달. award 제외 |
| 셀 색 확장 | 문제별 마지막 solve = 파랑, 대회 전체 마지막 Yes = 보라 (accepted run 기준) |
| 애셋 현대화 | 원본 PNG 아이콘 전면 SVG 교체. 풍선은 SVG 1장 + 문제 color 동적 틴팅 |

## 3. 아키텍처

```
kimchi-resolver/
  public/
    config.json            # 런타임 설정 (배포 후 편집 대상)
    sample/                # 2025 샘플 데이터 동봉 (오프라인 데모)
    orgs/
      orgs.json            # 학교 메타데이터: { "<group명>": { country, logo } }
      logos/               # 학교 로고 이미지
  src/
    core/                  # 프레임워크 무관. React import 금지
      types.ts             # Contest, Team, Problem, Run, Verdict, Snapshot
      verdict.ts           # verdict 정규화
      standings.ts         # 채점·이중 랭킹·교내 순위 (순수 함수)
      feeder.ts            # diff + 표시 대기 큐
      award.ts             # 시상식 state machine (순수)
      config.ts            # config.json 스키마 + URL override
      ingest/
        types.ts           # FeedSource 인터페이스
        spotboard.ts       # spotboard JSON 어댑터
        contest-api.ts     # ICPC Contest API 어댑터
    store/                 # zustand — core 상태를 React에 구독시키는 다리
    ui/                    # React 컴포넌트 + 애니메이션
  docs/
```

계층 규칙: `ui → store → core`. 역방향 의존 금지. 원본의 최대 문제(DOM이 상태 저장소, view→manager 역참조)를 구조로 차단한다.

## 4. 도메인 모델과 채점 규칙

내부 id는 전부 **string** (Contest API가 string id, spotboard number id는 문자열로 변환).

- `Contest`: problems(배열, 표시 순서 = 입력 순서), teams(Map). Team은 `{ id, name, group, countryCode?, foreign }`.
- `Run`: `{ id, teamId, problemId, minute, verdict, penaltyCounts }`. verdict는 수신 시점에 정규화된 `'accepted' | 'pending' | 'failed'`.
- **Verdict 정규화** (`verdict.ts`):
  - spotboard 소스: `"Yes"` prefix → accepted, `""` 또는 `"Pending"` prefix → pending, 그 외 → failed(`penaltyCounts: true`).
  - Contest API 소스: judgement 없음 → pending, 있으면 `/judgement-types`의 `solved`/`penalty` 플래그 사용. CE 등 무벌점 판정은 `failed + penaltyCounts: false`로 들어와 penalty 계산에서 제외된다.
  - 원본 버그(`"Pending - Judging"`이 failed로도 집계되어 penalty +20) 는 이 구조에서 성립 불가.
- **셀 상태** (팀×문제): net runs = id 순 정렬 후 첫 accepted 이후 절단. 셀 verdict = 마지막 net run의 verdict. failedAttempts = net runs 중 `failed && penaltyCounts` 개수.
- **Penalty**: solved 문제만 `20 × failedAttempts + solveMinute`. pending은 기여 0. 20분 상수는 config가 아닌 상수로 유지(원본 동일).
- **랭킹 comparator**: solved 내림차순 → penalty 오름차순 → 마지막 solve 시각 오름차순 → team id 오름차순(명시적 최종 tie-break). 완전 동점은 rank 공유, 다음 rank는 인원수만큼 건너뜀 (competition ranking: 1,2,2,2,5).
- **이중 랭킹**: 같은 comparator를 두 모집단에 적용 — `icpcRank`(전체), `domesticRank`(foreign 제외, foreign 팀은 null).
- **교내 순위**: 각 group 내 icpcRank 순서로 `schoolRank`(1부터) 파생. APAC 별 판정(13장)의 입력. 별도 왕관 표시는 없음(취소됨).
- **first solve**: 문제별 accepted run 중 가장 이른 것 (분 → run id 순 비교, 단일 셀). 같은 분에 여러 팀이 풀면 run id가 작은 팀 하나만 first solve이다.
- **last solve**: 문제별 accepted run 중 가장 늦은 것 (분 → run id 순 비교, 단일 셀). 그 셀이 first solve이기도 하면 (그 문제를 푼 팀이 한 팀뿐인 경우) last solve는 표시하지 않는다 — first solve가 우선. **contest-last solve**: 대회 전체 accepted run 중 가장 늦은 것 (단일 셀). **contest-first solve**: 대회 전체 accepted run 중 가장 빠른 것 (분 → run id 순, 단일 셀). spectator(live board)에서는 last solve와 contest-last solve를 표시하지 않는다 ("지금까지 가장 늦은 것"은 새 정답마다 옮겨 다니므로 의미가 없다). 관련 자동 칭호도 붙이지 않는다. first solve와 contest-first solve는 그대로 표시한다. **award 모드에서는 숨겨진 run까지 포함한 최종 데이터 기준으로 고정 계산** — 공개가 진행되어도 파랑/보라가 옮겨 다니지 않고, 해당 셀이 공개(accepted)된 뒤에야 표시된다. (같은 규칙이 last-solve 기반 자동 칭호에도 적용.)
- **자동 칭호** (awards.json과 무관, 스냅샷에서 파생되어 팀 행 배지로 표시):

  | 조건 | 배지 텍스트 |
  |---|---|
  | 한 문제를 net 10회 이상 시도 끝에 solved (복수면 최다 시도 기준 1개) | `tried N times to get Yes!` |
  | 대회 첫 Yes | `got first yes of this contest!` |
  | 문제별 first solve 보유 (복수 문제는 묶어서 1개) | `A, C, D first to solve!` |
  | 문제별 last solve 보유 (복수 문제는 묶어서 1개) | `B, E last to solve!` |
  | 대회 마지막 Yes | `got last yes of this contest!` |

  자동 칭호도 파생값이므로 라이브/award 공개에 따라 실시간으로 붙고 이동한다. awards.json의 수동 칭호와 같은 배지 UI를 공유한다.
- `computeStandings(contest, appliedRuns) → Snapshot`은 순수 함수. 84×13 규모라 전체 재계산으로 충분하고, 스냅샷은 appliedRuns 변경 시에만 갱신.

## 5. Feed 파이프라인

```
FeedSource(어댑터) → parse → diff → 표시 대기 큐 → tick 소비 → appliedRuns → Snapshot
```

- **FeedSource 인터페이스**: `loadContest(): Promise<Contest>`, `fetchRuns(cursor): Promise<{ runs, contestTimeSec, noMoreUpdate, cursor }>`.
- **spotboard 어댑터**: `contest.json` 1회 + `runs.json?from=<timestamp>` 폴링. 항상 client-side diff (원본의 `auto_rundiff=false` = changed_runs.json 모드는 삭제 — diff가 상위 호환). `noMoreUpdate`는 필드 부재 시 false (원본 버그 수정). `submissionTime` 문자열 방어 파싱.
- **Contest API 어댑터**: `/contests/{id}`, `/problems`, `/teams`, `/organizations`, `/judgement-types` 1회 + `/submissions`, `/judgements` 폴링. submission=run, `contest_time`("H:MM:SS.mmm") → 분 내림 변환. organizations의 `country`로 팀 countryCode 자동 채움. event-feed(NDJSON 스트림)는 범위 외(후순위 확장). 브라우저 직결 시 DOMjudge/CDS에 CORS 설정 또는 리버스 프록시 필요.

  DOMjudge 9.0.0의 OpenAPI 문서와 컨트롤러 소스로 검증한 사항 (관측된 응답이 아니라 스키마와 PHP 소스 기준). 운영 절차는 `docs/operations.md` 참조:
  - **freeze는 judgements를 가리지 않는다.** `JudgementController`에는 freeze 처리가 전혀 없고 필터링은 role 기준뿐이다. 따라서 `api_reader` 토큰을 가진 배포본은 대회 진행 중에도 frozen submission의 실제 verdict를 읽는다. 이 배포본은 대회 중 공개하면 안 된다. `r=`/`time=`은 부팅 리플레이만 제한하므로 freeze가 아니다.
  - **`api_reader` 계정 필수.** `/submissions`는 무인증으로도 열리지만 `/judgements`는 role-gated이고 `api_reader` 미만에서는 호출자 팀의 row만 남도록 필터링된다. 권한이 모자란 토큰은 판정 없는 보드(전 셀 pending)를 만든다.
  - **어느 엔드포인트에도 pagination이 없다.** 매 폴링마다 전체 목록을 다시 읽는다.
  - **submissions는 `submitid` 순으로 정렬되어 돌아온다.** 그래서 어댑터가 부여하는 first-seen `seq`는 폴링과 새로고침에 걸쳐 안정적이다. 단 이 `seq`는 submission id가 아니라 1-based ordinal이므로, contest-api 소스에서는 freeze 컷오프에 `r=` 대신 `time=`을 쓴다.
- **diff 규칙** (원본 보존): 미지 id → 수용. 큐 대기 중이거나 반영된 동일 id run과 비교해 이미 accepted면 거부, time/result 변경 시만 수용. 해당 셀이 이미 accepted면 skip. exclude 팀 run은 이 단계 전에 폐기.
- **fetch와 display 분리** (원본 보존): fetch는 큐 적재만. `autoPlayDelay`(기본 100ms) tick이 큐에서 1건씩 꺼내 애니메이션과 함께 반영. 대기 수는 update 버튼 badge. play/pause 상태는 store에 (원본은 CSS class였음).
- **폴링**: `autoRefreshInterval`(기본 10s). 수동 새로고침 시 타이머 리셋(원본 동일). WebSocket(`source.eventsWs`)은 메시지 수신 시 즉시 폴링 1회 트리거하는 초인종. 미연결/오류는 조용히 무시하되 system message로 1회 알림.
- **초기 리플레이**: `r=`(run id 상한) / `time=`(분 상한)까지 큐를 일괄 반영(무애니메이션), 이후부터 정상 진행. `time=` 지정 시 autoPlay 강제 off (원본 동일).

## 6. Award state machine (`core/award.ts`)

순수 state machine. 입력은 `advance()`와 `dismissSlide()` 두 가지. DOM 조회 없음.

- **진입**: `config.award.mode` 또는 `?award=true`. 폴링·autoplay·WebSocket·header 비활성, animation 강제 on, pagination 강제 off (원본 동일).
- **frozen 투영**: `r=` 컷오프 이후의 run이 하나라도 있는 셀은 **그 셀의 pre-freeze net run까지 포함해 통째로 마스킹**한다 — 보드에는 pending + 전체 시도 수로 표시되고, 공개 시 그 셀의 전체 net 이력을 처음부터 순서대로 flip 재생한다 (예: 컷오프 전 5회 실패 + 이후 3회 → 공개 때 8회 연속 재생). 컷오프 이후 run이 없는 셀은 그대로 노출. 원본의 monkey-patch 대신 "같은 run 목록의 두 projection"으로 구현.
- **상태**: 팀별 단계(`hidden → focused → revealing → finalized`), 셀별 공개 대기 결과, 현재 슬라이드, blink 단계.
- **진행 순서**: ICPC 랭킹 통합 최하위부터 (국내/외국 구분 없음). 다음 셀은 `award.revealOrder` 우선순위(문제 label 또는 id, 미지정 문제는 보드 순서), 같은 셀의 실패 시도들은 `advance()` 1회에 연속 재생 후 최종 결과.
- **긴 셀 이력의 재생 페이싱**: 한 셀의 시도가 많을수록 총 재생 시간은 늘어나되, **초반은 느리게 시작 → 중반 가속 → 마지막 몇 개는 다시 감속**하는 ease-in-out 곡선으로 각 flip 시간을 배분한다 (2025 데이터 최악 사례: CAPS/G 50회). 마지막 판정 flip은 기존 slowFlip 규칙을 그대로 적용. 상수 속도로 50회를 재생하면 15초가 끊김 없이 흐르므로 금지.
- **빈 시상식 경고**: 컷오프가 마지막 제출 이후라 `remainingReveals === 0`이면 공개할 것이 없는 시상식이 된다. 이 경우 부팅 시 system message로 경고한다.
- **blink**: `award.focusBlinking = { minSolved, maxRank }` 충족 팀의 셀은 공개 전 blink 단계 1회 추가 (키 1회 소모).
- **finalize**: 팀의 pending 셀 소진 시 finalized. **awards.json 항목이 없는 팀은 슬라이드를 아예 띄우지 않는다** — 현재는 슬라이드를 띄운 뒤 `useEffect`로 자동 닫는 구조라, 그 사이에 들어온 키 입력이 조용히 소비되는 경쟁 조건이 84팀 중 81곳에서 발생한다(리모컨 키 반복·연타 시). 데이터가 있는 팀만 전체 화면 슬라이드(순위 문자열/아이콘/칭호 라벨/공동 수상 `others`)를 띄운다. finalized 시점에 그 팀의 칭호 배지가 팀 행에 나타난다. finalized 팀 이름 클릭 시 슬라이드 재표시.
- **awards.json v2 스키마** (구 `award_slide.json` 대체):

  ```jsonc
  [
    { "teamId": "47", "rank": "동상", "icon": "medal_bronze",
      "labels": ["동상 수상자"], "others": [] },
    { "teamId": "12", "rank": "특별상", "icon": "thumb_up",
      "labels": ["E를 마지막으로 푼 팀!"] }
  ]
  ```

  `rank`는 문자열("대상") 또는 숫자(→ "3rd Place" 렌더). `labels`는 칭호 배지 목록 — 절대 성적 외의 창의적 수상 사유("E를 마지막으로 푼 팀!")를 포함해 자유 문자열. spectator 모드에서는 awards.json이 로드되어 있으면 배지를 즉시 표시하고, award 모드에서는 finalize 전까지 숨긴다(스포일러 방지).
- **`award.rankBegin`**: 애니메이션 없이 `advance()`를 반복하는 순수 계산으로 즉시 fast-forward (원본의 DOM 리플레이 + setTimeout 제거).
- **`award.hideName`**: 미공개 팀은 "Team {id}" / "Unknown" 표시.
- **키 매핑**: Enter/ArrowRight/Semicolon/**PageDown** → `advance()`, Escape → `dismissSlide()`, PageUp → 무동작. `KeyboardEvent.key` 기준. **슬라이드가 떠 있는 동안 advance 키를 누르면 그 입력은 슬라이드 닫기로 소비된다** (프로젝터 리모컨에 Esc가 없음 — PageDown만으로 시상식 전체 진행 가능해야 함). 닫기 1회 + 다음 진행 1회의 2단계 구조는 유지되어 오조작 방지 효과는 그대로.
- **animationSpeeds**: `[{ minSolved, fastFlip, slowFlip, moveUpMsPerRow }]` — solved 수가 `minSolved` 이상인 첫 항목 매칭 (원본의 "내림차순 정렬 필수" 함정 제거, 스키마 검증으로 정렬 무관).
- **가차 이펙트**: 셀 공개 시 그 셀의 시도 횟수(net runs)가 `gachaEffectRequirement`(기본 8) 이상이거나 시상식 최종 공개(`remainingReveals === 1`)인 경우 —
  - **시상식 최종 공개(피날레) 셀은 결과와 무관하게 100% 발동** (§7 피날레 6단계 시퀀스의 일부).
  - 그 외: 최종 결과가 **Yes**면 마지막 flip 직전에 무조건 발동, **No**면 `gachaEffectForNoRatio`%(기본 30) 확률로 발동 (페이크 연출).
  - 발동 여부는 state machine이 결정해 reveal 상태에 플래그로 포함. 확률 판정의 RNG는 주입 가능하게 하여 테스트에서 결정적으로 재현.
- 시상식 중에도 두 랭킹 동시 노출.

## 7. UI

컴포넌트: `Header`(시계 HH:MM, notify/update/autoplay/feed-one/feed-all/events 버튼, 검색, 페이지 내비), `Scoreboard` > `TeamRow`, `ProblemCell`, `Dashboard`, `AwardSlide`, `SystemMessage`.

`TeamRow`: ICPC rank + 국내 rank(2칸, foreign은 국내 칸 비움), [APAC 별], 국기 아이콘, [로고], 팀명, 소속, 칭호 배지, penalty, 문제 셀 × N, balloon 행.

- **순위 이동**: framer-motion layout animation(FLIP). 원본의 수동 top 계산·행 밀어내기와 동일한 시각 효과.
- **셀 flip**: CSS 3D keyframe(표준 문법) + `onAnimationEnd`, 판정 결과 교체는 flip 중간 시점 (원본 동일). 애니메이션 대상 소멸 시 타임아웃 fallback으로 진행 보장 (원본의 영구 대기 → 보드 정지 버그 차단).
- **비주얼 재현 + 셀 색 확장**: solved 수 색 스파인(HSV 빨강→초록 보간, 홀짝 채도 차이), 문제 글자·rank suffix는 실제 DOM 텍스트 (CSS `content` 금지 — 접근성/복사). 셀 색상표:

  | 상태 | 색 | 비고 |
  |---|---|---|
  | first solve | 연두 | 원본 유지 |
  | solve | 초록 | 원본 유지 |
  | pending | 노랑 | 원본 유지 |
  | wrong answer | 빨강 | 원본 유지 (스트라이프) |
  | 문제별 마지막 solve | 파랑 | 신규 |
  | 대회 전체 마지막 Yes | 보라 | 신규 |

  우선순위(중복 시): 보라 > 파랑 > 연두 > 초록. 판정은 accepted run만 대상(4장 파생값).
- **대회 첫 Yes 반짝임**: contest-first solve 셀은 연두 위에 추가 sparkle/shimmer 애니메이션(CSS keyframe, 은은한 반복 광택)을 얹는다.
- **시상식 피날레 시퀀스** (`remainingReveals === 1`인 마지막 공개 셀, 순서 고정):
  1. 셀이 **반짝인다** (blink/sparkle 예열).
  2. 그 셀 쪽으로 화면을 **확대**(scale ≈ 5 — CSS `--award-finale-zoom`)하고, **무지개 오버레이가 흐르며 진동(shake)** 시작. 주변은 어둡게, 해당 셀에 **스포트라이트**.
  3. **흔들리면서 아주 천천히 flip** — 셀에 여러 시도가 있으면 중간 flip들도 느리게 재생 (해당 티어 slowFlip × `finaleIntermediateFlipSlowdown`, 기본 2).
  4. **마지막(판정 확정) flip은 더 느리게** 재생 (해당 티어 slowFlip × `finaleFlipSlowdown`, 기본 3 — config로 조정 가능).
  5. flip 완료 후 **진동을 멈춘다**. 결과가 **Yes면 축포(confetti) 효과** 재생.
  6. 화면 확대·스포트라이트·무지개 오버레이를 종료하고 원상 복귀 (5단계 종료 후 약 5초 뒤).
- **가차 이펙트 연출** (발동 조건은 6장): 마지막 flip 직전, 셀이 상하좌우로 약간씩 진동하며 미세한 각도로 회전 진동하고 반짝이는 sparkle을 재생. 공개(flip) 후에는 셀이 정확히 제자리로 복귀하고 진동·반짝임이 멈춘다. **시상식 최종 공개 셀인 경우 얇은 sparkle 대신 셀 전체를 덮는 무지개 그라데이션이 연속으로 흐르는(hue가 순환하며 이동) 오버레이를 재생** — 진동이 멈출 때까지 계속 흐르고, 피날레 스포트라이트와 중첩 적용.
- **칭호 배지 레이아웃**: 배지는 **팀명·소속을 절대 가리지 않는다** — 팀명 블록과 배지 영역은 별도 컬럼(또는 팀명 아래 전용 라인)으로 분리하고, 팀명은 항상 완전히 표시. 배지 영역은 고정 폭 안에서 처리한다.
  - spectator/publish: 배지가 넘치면 잘라내고 `+N` 표기.
  - **award 모드: 칭호가 2개 이상이면 배지 영역에서 아래→위로 올라오는 세로 carousel**로 순환 표시 (한 번에 1개, 약 2.5초 간격, CSS 애니메이션). 1개면 정지 표시.
- **애셋 현대화**: 원본 PNG 아이콘(헤더 버튼, 메달/수상 아이콘, 국기)을 전부 SVG로 교체 — 헤더·별은 MIT 아이콘 세트(예: Lucide), 국기는 MIT SVG 국기 세트(예: flag-icons/circle-flags)에서 필요한 국가만 번들, 메달류는 SVG로 제작/선별. 이모지 사용 금지.
- **풍선 SVG 틴팅**: 풍선은 PNG 19장 대신 SVG 1장. 본체 fill을 CSS 변수(`--balloon-color`)로 받아 문제의 `color` 값(named color, hex 모두)을 그대로 주입. 외곽선·하이라이트는 고정이라 white/ivory 같은 밝은 색도 식별 가능. 임의 색상 코드 지원으로 "풍선 색상표에 없는 색" 문제가 사라진다. **꼬리(끈) 없이 풍선 본체만** 그린다.
- **보드 폭/스케일**: 4:3 프로젝터 발표 기준. 보드는 화면 폭을 꽉 채우고(고정 1024px 중앙 정렬 폐지), 행 높이를 뷰포트 기준으로 스케일해 **화면에 약 20팀**이 보이게 한다 (header 제외 가용 높이 / 20, vh 기반 font-size, 데스크톱 한정 — 모바일 규칙은 14장). 넓어진 가로 여유는 팀명 블록과 배지 영역에 배분한다.
- **solved 스파인 밴드**: 같은 solved 수 그룹은 색 밴드가 **연속**되어야 하며 숫자는 그룹의 첫 행에만 표시한다 (award 모드 포함 — 행마다 끊기거나 매 행에 숫자가 나오면 안 됨).
- **태극기**: KR 국기 SVG는 건곤감리 4괘와 회전된 태극을 포함한 제대로 된 태극기로 그린다 (단순화된 원 2색 금지).
- **검색**(100ms debounce, 팀명+소속), **follow**(`t=`, sticky 고정 — 모던 브라우저 전제로 분기 제거), **pagination**(`paginationSize`).
- **Dashboard**: 최근 judge 이벤트 피드, accepted 필터, `maxNotifications` 캡(정확히 N개, sentinel 중복 버그 미이식), 표시 상태 localStorage 유지.
- **Desktop notification**: 표준 Notification API. accepted run만, 7초 auto-close, 권한 요청 2단계 플로우 유지, 원본의 `cancel()` 버그 미이식.

## 8. 학교 메타데이터

- `public/orgs/orgs.json`: `{ "<group명>": { "country": "KR", "logo": "kaist.png" } }`. 2025 데이터의 51개 학교로 초기 생성. Contest API 소스는 `/organizations`의 country로 자동 보완(orgs.json이 우선).
- **국기**: countryCode → SVG 아이콘.
- **foreign 판정**: Contest API는 `country ≠ KR` 기본. spotboard 소스는 orgs.json의 country 사용. `config.foreign.ids` / `config.foreign.groups`로 override.
- **로고**: `config.showSchoolLogos` 토글. `public/orgs/logos/`에 저장, 2025 데이터 기반 51개 수집은 구현 단계 작업.
- **애셋 검증**: 대회 데이터 로드 직후 전체 팀의 group을 orgs.json과 대조. 항목 없음/로고 파일 없음(로고 토글 on일 때) → SystemMessage 경고 + console 상세. 개발용 `npm run check-assets` 스크립트 별도 제공.

## 9. config.json + URL 파라미터

```jsonc
{
  "source": {
    "type": "spotboard",              // "spotboard" | "contest-api"
    "apiBase": "./sample/",           // spotboard용
    "baseUrl": "", "contestId": "",   // contest-api용
    "auth": null,                     // contest-api용 { "username", "password" } | null
    "eventsWs": null                  // 폴링 트리거 WebSocket URL | null
  },
  "fetchTimeout": 5000,
  "autoRefreshInterval": 10000,
  "autoPlay": true,
  "autoPlayDelay": 100,
  "animation": true,
  "showTeamGroup": true,
  "showFirstSolve": true,
  "showBalloons": true,
  "showSchoolLogos": false,
  "showEvents": false,
  "maxNotifications": 100,
  "pagination": false,
  "paginationSize": 50,
  "useFollowedTeamSticky": true,
  "excludeTeams": [],
  "foreign": { "ids": [], "groups": [] },
  "apac": { "enabled": false },
  "publish": {
    "enabled": false,
    "mode": "off",
    "invitedScoreCutoff": null,
    "alreadyInvited": { "teamIds": [], "winnerGroups": [], "invitedGroups": [] }
  },
  "award": {
    "mode": false,
    "hideName": true,
    "rankBegin": null,
    "awardsUrl": "./sample/awards.json",
    "revealOrder": [],
    "focusBlinking": { "minSolved": 7, "maxRank": 10 },
    "gachaEffectRequirement": 8,
    "gachaEffectForNoRatio": 30,
    "finaleFlipSlowdown": 3,
    "finaleIntermediateFlipSlowdown": 2,
    "animationSpeeds": [
      { "minSolved": 10, "fastFlip": 200, "slowFlip": 800, "moveUpMsPerRow": 200 },
      { "minSolved": 0,  "fastFlip": 300, "slowFlip": 700, "moveUpMsPerRow": 100 }
    ]
  }
}
```

스키마는 zod로 검증하고 오류 시 어떤 키가 잘못됐는지 SystemMessage로 표시. 모든 키에 기본값 존재(부분 config 허용).

URL 파라미터 (`URLSearchParams`로 파싱, config보다 우선): `r`, `time`, `award`, `award_rank_begin`, `animation`, `q`(검색어, 원본과 달리 부분 일치), `t`(follow 팀 id), `publish`, `publish_mode`, `invited_cutoff` (13장). `site_score`는 없어졌습니다.

원본 대비 의도적 삭제: `auto_rundiff`(항상 client diff), predicate 함수 config(선언적 필드로 대체), `environment`(Vite 빌드로 불필요).

## 10. 테스트

1. **core 유닛 테스트** (vitest): penalty 공식, net runs 절단, 4단계 tie-break, rank gap(1,2,2,2,5), 이중 랭킹(foreign 제외), 교내 순위(schoolRank), first solve, **문제별 last solve·대회 전체 첫/마지막 Yes(동분 tie-break 포함, award 공개 중 이동)**, **자동 칭호 5종(조건 경계: 10회 시도, 복수 문제 묶음)**, verdict 정규화(빈 문자열/Pending/무벌점 판정), diff 규칙 전체, feeder 큐, award 전이 전체(focus→blink→reveal→finalize→slide, revealOrder, rankBegin, **finalize 시 칭호 공개**, **피날레 스포트라이트 트리거(remainingReveals === 1)**, **APAC 별 규칙(동→은/금 전이, 교내 3위 경계, invited cutoff 판정)**, **가차 이펙트 발동 판정(시도 횟수 경계, Yes 무조건/No 확률 — 주입 RNG로 결정적 테스트, 피날레 무지개 플래그)**, 마지막 팀 종료 — 원본의 도달 불가 'end' 버그 미이식 확인).
2. **골든 테스트**: 2025 runs.json 1,227건 전체 반영 → 최종 standings 스냅샷 고정.
3. **어댑터 테스트**: 같은 대회를 spotboard/Contest API 두 포맷으로 넣어 동일 standings 산출 확인. Contest API 픽스처는 스펙 예제 기반으로 제작.
4. **UI**: 핵심 컴포넌트 렌더 테스트(Testing Library). e2e(Playwright)는 범위 외.

## 11. 빌드/배포

- Vite 정적 빌드 → `dist/`. 아무 HTTP 서버로 서빙 (원본과 동일한 배포 모델).
- `config.json`, `orgs/`는 런타임 fetch — 재빌드 없이 편집 가능.
- 2025 샘플 데이터 `public/sample/` 동봉.
- CI/패키징은 범위 외 (필요 시 후속).

## 12. 원본 버그 처리 방침

분석 문서 2장의 버그는 전부 **미이식**(수정): noMoreUpdate 파싱, Pending penalty 비대칭, ProblemSummary 중복 집계, award 종료 TypeError, revealOrder id 0 버그, discard off-by-one, notify `cancel()`, dashboard trim/sentinel. 동작 차이가 사용자 관점에서 보이는 것은 noMoreUpdate(필드 부재 시)와 Pending penalty 두 건이며, 모두 "올바른 쪽"으로 통일한다.

## 13. APAC 진출 표시 (`apac` 플래그)와 publish 모드

> **2026-10-16 갱신**: publish 모드는 `off` / `preliminary` / `regional` 세 모드로 나뉘고, 공개 페이지는 `npm run publish`가 만든 정적 폴더입니다. 자세한 내용은 [publish 모드 확장 설계](2026-10-16-publish-modes-design.md)를 보세요. 이 장의 `publish.siteScore`와 URL `site_score`는 **없어졌습니다** (site score는 공식으로 계산합니다). 학교당 상한 3은 2026-27 규칙에서 2(작년 WF 메달 학교는 3)로 바뀌었습니다. 동색 별도 "학내 3등 이내"가 아니라 **그 시점 APAC 리스트(scored list)에 든 팀**으로 바뀌었고, 최종 순위 공개 후에는 동색 별이 없습니다 (아래 "별 의미"와 "별 아이콘 규칙" 1~2번에 반영). 나머지 본문은 2025-26 규칙 기준의 기록입니다.

목적: [ICPC APAC Championship 2025-26 규칙](https://icpc.jp/apac/2025-26/rules/) 기준으로 APAC 진출 가능성이 있는 팀을 시각적으로 인지시킨다. 규칙 요점: 학교당 최대 3팀 진출 가능(교내 4위 이하 제거), 팀 score = `(rank − 1) / site score` (작을수록 상위), score 순 병합 리스트에서 초청.

**전제**: 대회가 종료된 상황(award 모드 또는 publish 모드)에서만 동작. `config.apac.enabled`로 on/off.

**별 의미**: 동색 = 지금까지 APAC 리스트에 든 팀(시상식 중에만), 은색 = APAC championship **초대 가능**(후보), 금색 = APAC championship **진출**. 범례는 이 문구를 쓰고, 보드/시상식 **툴팁과 README는 영어**를 쓴다 — bronze `In the APAC Championship list so far`, silver `Likely invited to the APAC Championship`, gold `Invited to the APAC Championship` (`APAC_STAR_TITLES`).

**별 아이콘 규칙** (별 부여·색상 변경 시 항상 별이 한 바퀴 회전하는 애니메이션 포함):

1. **award 모드, 최종 순위 미공개 상태**: `alreadyInvited.teamIds`의 팀은 **금색 별**(다른 사이트에서 정해진 결과라 스포일러가 아님). 현재 스냅샷의 scored list(아래 filteredRank 산출 규칙, 챔피언은 아직 모르므로 적용하지 않음)에 든 팀은 **동색 별**. 그 외 팀은 별이 없다. scored list는 현재 스냅샷으로 다시 계산하므로, 공개가 진행되어 순위가 바뀌면 별도 생기고 사라지고 이동한다(회전 애니메이션 재생). 학교당 상한은 2(작년 WF 메달 학교는 3)이다. champion, site score, cutoff는 이 단계에서 쓰지 않는다.
2. **award 모드에서 최종 순위 전부 공개 완료 시, 또는 publish 모드**:
   - 대회 전체 1등 팀(챔피언)의 별을 **금색**으로 변경 (World Finals 직행 = APAC 진출 확정).
   - `alreadyInvited.teamIds`의 팀도 **금색**.
   - scored list에 든 팀(챔피언 학교와 이미 초청된 학교는 통째로 빠짐)의 별을 **은색**으로 변경 — 초청 후보. **그 외 모든 팀은 별이 없다** (챔피언 학교의 나머지 팀, 0솔브 팀, 학교 상한을 넘은 팀, AU/NZ 팀). 이 단계에서 동색 별은 나오지 않는다.
3. **publish 모드의 invited 판정**: `(filteredRank − 1) / siteScore ≤ invited score cutoff`인 **은색 별** 팀을 **금색**으로 변경.

   **filteredRank 산출 규칙** (icpcapac.solved.ac/2026의 2025-26 Seoul 58줄을 팀명·점수 4자리까지 완전 재현하도록 검증됨):
   1. **이미 초청된 팀이 있는 학교는 그 사이트 리스트에서 통째로 제외**한다. 초청 경로는 무관 — 이 리저널 우승(챔피언)이든 다른 리저널 초청이든 동일. 초청된 팀 본인은 참고용으로 표시하되 **순위 슬롯을 차지하지 않는다**. (검증: 서울대는 Just use CRT 한 줄만 순번 `-`로 표시되고 나머지 서울대 팀은 리스트에 없음. NTU는 Manila·Jakarta 초청 팀 보유로 0줄.)
   2. **0솔브 팀 제외** (공표 리스트의 마지막 순번 58위가 1솔브).
   3. 남은 팀 중 **학교당 상위 3팀**만 ICPC 순위 순으로 나열하고, 그 1-based 위치가 filteredRank. 외국 팀도 정상적으로 슬롯을 차지한다(3팀 캡은 사이트별 적용 — Science Tokyo가 Seoul·Yokohama 양쪽 리스트에 동시 등장). **소속이 없는 팀(group `""`)은 각각 별개의 학교로 취급한다** — 서로 무관한 무소속 팀들이 3팀 캡을 공유해서는 안 되므로 무소속 팀은 다른 무소속 팀 때문에 탈락하지 않으며, 나머지 규칙(0솔브 제외, 팀 id 기준 초청 제외, 점수 계산)은 그대로 적용된다.

   검증 사례: Just Reboot JungSangHwa(부산대)가 filteredRank 13 → `(13−1)/68.98 = 0.1740 ≤ 0.1838` qualify.

   **교차 사이트 입력**: "다른 리저널에서 이미 초청됨"은 contest.json·orgs.json에서 유도 불가능한 외부 정보이므로 config로 받는다 — `publish.alreadyInvited: { teamIds: [], winnerGroups: [], invitedGroups: [] }` (옛 `groups`는 `invitedGroups`로 읽습니다). 이 리저널 챔피언은 자동으로 초청 처리(규칙 B1)되므로 별도 입력이 필요 없다. 입력이 비어 있으면 챔피언 학교만 제외되며, 그 경우 다른 사이트에서 초청된 학교가 남아 순위가 실제보다 밀릴 수 있다는 점을 UI에 안내한다.

**publish 모드** (신설, 세 번째 앱 모드):

- 용도: 대회 종료 후 공지용 static scoreboard. 폴링·autoplay·애니메이션 진행 없음, 전체 run 반영된 최종 순위표 + 칭호/별 표시.
- 진입: `?publish=true` (또는 `config.publish.enabled`). ~~site score 값이 입력되어야 전환 완료~~ (없어졌습니다: site score gate는 없고, 값은 계수와 입력값으로 계산합니다).
- 화면에 **invited score cutoff 입력 상자** 존재. 값 입력/변경 시 3번 규칙을 즉시 재평가해 해당 팀의 은색 별을 금색으로 (회전 애니메이션).
- 모드 배타 규칙: publish는 award와 동시 활성 불가 (publish 우선).

config 추가:

```jsonc
"apac": { "enabled": false },
"publish": {
  "enabled": false,
  "mode": "off",
  "invitedScoreCutoff": null,
  "alreadyInvited": { "teamIds": [], "winnerGroups": [], "invitedGroups": [] }
  // preliminary, regional 블록: 새 설계 문서 §3, §6.4
}
```

URL 파라미터 추가: `publish`, `publish_mode`, `invited_cutoff` (config보다 우선). (`site_score`는 없어졌습니다.)

## 14. 모바일 레이아웃 (spectator·publish 모드)

768px 이하에서 압축 레이아웃으로 전환한다. award 모드는 프로젝터 전용이므로 제외.

- **압축 행**: ICPC 순위 · 국내 순위 | APAC 별 | 국기 | 팀명 + 소속 | 솔브 수 / 페널티. 풍선은 완전 숨김.
- **행 탭 → 모달**: 해당 팀의 문제 격자 전체(셀 색상 규칙 동일), 칭호 배지 전부(자동+수동), 페널티 상세. 모달에도 풍선은 없음. 바깥 탭/닫기 버튼으로 닫힘.
- 색 스파인·셀 색상 규칙·별 회전 등 시각 규칙은 데스크톱과 동일하게 유지.
- 대시보드·검색·pagination은 모바일에서 숨김(기존 1300px 대시보드 규칙 유지).

## 15. 범위 외 (명시)

- Contest API event-feed(NDJSON) 스트리밍 — 폴링으로 충분, 후순위.
- PageUp 등 시상식 되돌리기(undo).
- e2e 테스트, CI 파이프라인.
- feedserver 구현 (DOMjudge/CDS가 대체).
