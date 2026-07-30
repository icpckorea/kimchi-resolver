# Spotboard 분석 문서 (재구현 참고용)

원본: `~/Projects/spotboard` (v0.7.0, MIT). ACM-ICPC 스코어보드 웹앱.
작성일: 2026-07-30. 세 개의 탐색 에이전트 리포트(domain / UI / app·config·award·build)를 종합.

- 구조: 정적 **webapp** (frontend) + **feedserver** (backend, 이 repo에는 없음. JSON 3개만 제공하면 됨)
- 스택: RequireJS(AMD) + jQuery 1.8.2 + Handlebars + CoffeeScript(domain model) + Grunt 빌드
- 상태 저장소가 사실상 DOM + CSS class. 이벤트 버스는 jQuery custom event.

---

## 1. 반드시 보존해야 할 핵심 동작 (behavior spec)

### 1.1 채점/랭킹 규칙
- Penalty: 문제별 `20 * failedAttempts + solveMinute` (20분 상수 하드코딩). 못 푼 문제는 0.
- **Net runs**: 셀(팀×문제)의 run을 id 순으로 정렬, 첫 `Yes` 이후의 run은 채점에서 무시.
- 랭킹 comparator: ① totalSolved 내림차순 → ② penalty 오름차순 → ③ lastSolvedTime 오름차순 → ④ team id 오름차순(sparse array 순회 순서에서 나오는 암묵적 tie-break).
- 완전 동점은 **같은 rank 공유, 다음 rank는 건너뜀** (competition ranking with gaps: 1,2,2,2,5 확인됨).
- Verdict 판정은 result 문자열 prefix 매칭: `"Yes"` prefix = accepted (대소문자 구분), `""` 또는 `"Pending"` prefix = pending, 그 외 = failed.
- Frozen 상태는 별도 플래그가 아니라 "result가 미해결인 run"으로 표현됨. pending 셀은 penalty/solved 기여 0.

### 1.2 Run feed 프로토콜
- `contest.json`: `{ title, systemName, systemVersion, problems: [{id,name,title,color}] (dense, 순서 유지), teams: [{id,name,group?}] }`. group이 없으면 `"이름 (소속)"` 형태를 정규식으로 파싱.
- `runs.json` / `changed_runs.json` (같은 스키마):
  ```
  { time: { contestTime: int(초), noMoreUpdate: bool, timestamp: int(opaque cursor) },
    runs: [{ id, team, problem, result, submissionTime: int(분) }] }
  ```
  주의: contestTime은 **초**, submissionTime은 **분**. changed_runs.json에서 submissionTime이 문자열로 오는 경우 있음(parseInt 필요). run id에 gap 있을 수 있음.
- 폴링: `auto_refresh_interval`(기본 10초)마다 `runs.json?from=<lastTimeStamp>` GET.
  - `auto_rundiff: true`(기본): 전체 runs.json을 받아 client-side diff.
  - `false`: 서버가 diff한 `changed_runs.json`을 그대로 feed.
- Diff 규칙(`_isReflectable`): 미지의 id → feed. **이미 accepted인 run은 절대 재feed 안 함**. 그 외 time 또는 result가 바뀌었으면 feed. 큐에 대기 중인 run도 비교 대상.
- 추가 필터(manager 측): 해당 (팀,문제) 셀이 이미 accepted면 skip, `exclude_teams` 소속 run skip.
- WebSocket(`path.events_ws`)은 데이터 채널이 아니라 **초인종**: 메시지 오면 즉시 폴링 한 번. reconnect 없음.
- fetch(큐 적재)와 display(소비)는 분리: `auto_play_delay`(샘플 100ms)마다 큐에서 1개씩 꺼내 애니메이션과 함께 반영. 대기 수가 update 아이콘 badge로 표시.

### 1.3 UI 구성
- 고정 header: 시계(HH:MM), 아이콘 버튼 6개(notify / update / auto-play toggle / feed-one / feed-all / events), 검색 input, pagination nav.
- 스코어보드: 팀별 row — rank(st/nd/rd/th suffix), 팀명+소속, penalty, 문제별 셀(`+N`/`-N` 시도 횟수, solved/failed/pending 3색), solved 수에 따른 좌측 색 스파인(HSV 빨강→초록 보간), 문제별 balloon 이미지.
- First solve 하이라이트(`show_first_solve`), balloon 표시(`show_balloons`), 소속 표시(`show_team_group`) 각각 토글.
- 애니메이션: 셀 flip(3D rotateX, 판정 결과는 flip 중간 시점에 교체), solved 시 row 전체 flip + **순위 상승 애니메이션**(행이 위로 슬라이드하며 지나치는 행들을 밀어냄, 상승 폭에 따른 속도 함수), focus(대상 행을 화면 중앙으로 스크롤 + 하이라이트).
- Dashboard: 우측 256px 고정 패널, 최근 judge 이벤트 피드(차트 아님). accepted-only 필터, `max_notifications`(기본 100) 캡, localStorage로 표시 상태 유지. 1300px 미만에서는 아예 표시 안 됨.
- Desktop notification: accepted run에 대해 Web Notification API 사용, 7초 auto-close.
- 검색(100ms debounce, 팀명+소속 regex), 팀 follow(`t=` 파라미터, WebKit에서 sticky 고정), pagination(`pagination_size`).

### 1.4 Award ceremony 모드 (핵심 차별 기능)
- 진입: `award_mode: true` 또는 `?award=true`. 이때 폴링/autoplay/WebSocket/header 전부 비활성. animation 강제 on, pagination 강제 off.
- 원리: `?r=<runid>` 시점까지 리플레이한 뒤, **그 이후의 run은 result를 비워 pending 셀로 만들고 실제 결과는 (팀,문제)별 큐에 보관**.
- 진행(Enter / → / 세미콜론(프레젠터 리모컨) 키, Esc는 슬라이드 닫기): 키 1회 = 상태 전이 1회.
  1. 최하위의 미확정(non-finalized) 국내 팀 선택(foreign 팀은 국내 팀 전부 끝난 뒤). focus + 숨긴 팀명 공개(`award_hide_name`).
  2. pending 셀을 `award_reveal_order` 우선순위로 하나 선택, 보관해둔 실제 결과를 flip으로 공개. 같은 셀의 실패 시도들은 한 키에 연속 공개.
  3. `award_focus_blinking` 조건(예: solved>=7 또는 rank<=10)이면 공개 전에 깜빡임 단계를 한 키 추가(드라마 연출).
  4. solved면 순위 상승 애니메이션. pending 셀이 없어지면 팀 finalize → `award_slide.json` 기반 전체 화면 수상 슬라이드(순위/메달 아이콘, 클릭으로 재표시 가능).
- `award_animation_speeds`: solved 수 구간별 flip 속도/상승 속도 함수. `award_rank_begin`: 애니메이션 끄고 해당 rank까지 자동 fast-forward(공개 순서에 따라 결과가 달라지므로 시뮬레이션으로만 가능).
- `award_slide.json`: `[{id, rank(숫자 또는 "대상" 같은 문자열), icon, group, name, others?}]`.

### 1.5 config.js 전체 옵션
`environment`, `apiBase`(feed_server_path), `path.events_ws`, `path['award_slide.json']`, `auto_rundiff`, `fetch_timeout`(기본 2000), `show_team_group`, `show_first_solve`, `show_balloons`, `auto_play`, `show_events`, `max_notifications`(100), `animation`, `auto_play_delay`(코드 기본 1000/샘플 100), `auto_refresh_interval`(10000), `pagination`, `pagination_size`(50), `use_followed_team_sticky`, `exclude_teams`(함수 또는 id 배열), `foreign_teams`(함수 또는 id 배열), `award_mode`, `award_hide_name`, `award_rank_begin`, `award_animation_speeds`, `award_reveal_order`, `award_focus_blinking`(bool 또는 predicate).
- config는 JS 파일이며 **실행 가능한 predicate를 담는다**(exclude_teams 등). 순수 JSON으로 바꾸면 기능 상실 — 재설계 포인트.

### 1.6 URL 파라미터
`r=`(초기 run id까지 리플레이), `time=`(분 단위까지 리플레이, auto_play 강제 off), `award=`, `award_rank_begin=`, `animation=`, `q=`(검색어, `^...$` 앵커), `t=`(follow할 팀 id). 파싱이 unanchored regex라 느슨함.

### 1.7 팀 제외/foreign 처리 (명시적 결정 필요)
- excluded 팀: feed 단계에서 run 제거(first solve에도 영향 없음) + draw 단계에서 row 숨김. 단 **rank 계산에는 포함**되어 보이는 순위에 gap이 생김. 재구현 시 어느 쪽이 맞는지 결정할 것.
- foreign 팀: `.foreign` class, 시상식에서 국내 팀 이후에 공개.

---

## 2. 원본의 버그 — 이식하지 말 것

1. **`noMoreUpdate` 파싱**: `data['time'].noMoreUpdate ? true : false`는 CoffeeScript existential 연산자로 컴파일되어, 필드가 **없으면** truthy 객체 `{"true": false}`가 됨 → 대회가 끝난 것으로 오판. 필드가 있으면 값이 그대로 통과(우연히 정상).
2. **Pending 표기 비대칭**: `"Pending - Judging"`은 pending이면서 failed로도 분류되어, `"" → Yes`와 `"Pending..." → Yes`의 penalty가 20분 다름. `isFailed()`가 pending을 제외하도록 정의할 것.
3. `ProblemSummary.update`가 dedupe 없이 push — 같은 run이 중복 집계됨(현재는 first-solve만 써서 무해).
4. award 마지막 키 입력에서 null 팀 참조로 TypeError(`'end'` 분기 도달 불가), `award_reveal_order`에서 id 0인 문제를 제목으로 지정 불가(falsy 버그), `TeamProblemSeparatedQueuedRunFeedingStrategy.runDoEach`의 undefined `contest` 참조, `RunFeeder.discard` off-by-one, `TeamStatus.getTotalAttempts` 오타로 항상 0, `award_animation_speeds`는 solved 내림차순 정렬 필수(문서화 안 됨).
5. notify 클릭 핸들러의 `this.cancel()`은 현대 브라우저에 없는 API — 클릭 시 throw.
6. 대시보드 trim이 `max+1`개 유지 + "No More Information" sentinel 중복 누적.

## 3. 원본의 설계 부채 — 재구현에서 바로잡을 것

1. **DOM이 상태 저장소**: play/pause, award 진행 상태(finalized/target/pending), 다음 공개 대상 선택까지 전부 CSS class를 jQuery로 질의. → 모델 상태 기반으로 재설계.
2. 폴링이 `$('#update-icon').trigger('click')`으로 구현됨(타이머, WebSocket, 버튼이 같은 코드 경로). → fetch 함수 분리.
3. Award 모드가 `strategy.popRun`을 monkey-patch해서 frozen 상태를 만듦. → "같은 run 리스트의 두 projection"으로 표현.
4. 애니메이션이 `-webkit-` 전용 keyframe + `webkitAnimationEnd` 의존, 애니메이션 대상이 사라지면 Deferred가 영원히 pending되어 보드 전체가 잠김(주석으로 인정된 hang risk).
5. 문제 글자/rank suffix가 CSS `content`라 접근성·복사 불가. 셀 매칭이 data-attribute 대신 DOM index. 이벤트 버스가 jQuery custom event. 첫 solve 무효화가 view에서 O(N²) DOM sweep.

## 4. 이식하지 않아도 되는 것 (dead weight)

- `jquery.flot.js`(107KB), `jquery.hotkeys.js`: 어떤 모듈도 require하지 않음. 차트 기능은 upstream에서 제거된 흔적(CSS 잔재만 있음).
- `TeamStatus.hasSolved`(throw만 함), `Run.getStatus/setStatus`, 각종 미사용 helper.
- 존재하지 않는 이미지 참조(`arrow_left.png` 등).

## 5. 테스트 현황

`test/runfeeder.coffee` 단 3케이스(RunFeeder 초기화/feed/diff). penalty, 랭킹, tie-break, ProblemSummary는 무테스트. 재구현 시 1.1~1.2의 규칙을 테스트로 먼저 고정하는 것을 권장.

## 6. 원본 상세 리포트

에이전트 원문 리포트가 필요하면 세션 기록 참조. 이 문서는 세 리포트(domain model / UI·animation / bootstrap·config·award·build)의 종합 요약이며, 필드명과 수치는 원문에서 검증된 값을 그대로 옮김 (domain 리포트는 contest.coffee를 실제 컴파일·실행해 검증함).
