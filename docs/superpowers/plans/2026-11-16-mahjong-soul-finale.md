# Selectable Finale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 기존 finale를 `gacha-ssr`로 보존하고, 마지막 회전 대신 수직 발사와 A~M 격자 착지로 결과를 공개하는 `mahjong-soul-like`를 추가합니다.

**Architecture:** 마지막 회전 직전까지 현재 `RevealingCell`을 재사용합니다. 작혼식 후반부는 document.body에 portal로 올린 뷰포트 기준 레이어가 표현하고, 기존 reveal 재생 루틴 하나가 단계 진행을 소유합니다. 순수 award machine의 공개 순서와 판정 규칙은 유지합니다.

**Tech Stack:** React 18, TypeScript, CSS animation, 기존 framer-motion, Zod, Vitest/Testing Library. 새 의존성은 추가하지 않습니다.

**Spec:** 이 문서의 요구사항과 연출 설계 절, 사용자의 2026-11-16 요청. 시제품: `docs/prototypes/mahjong-finale.html` (샘플 데이터, 제품 코드와 연결하지 않은 검토용).

## 요구사항과 확정된 사항

- 설정은 기존 award 블록 안의 `award.finaleType: 'gacha-ssr' | 'mahjong-soul-like'`입니다. 생략 시 `gacha-ssr`로 기존 동작을 보존합니다.
- finale 진입 여부는 기존 `effect.finale` 판정에 따릅니다. 일반 reveal의 가챠 조건과 연출은 변경하지 않습니다.
- 중앙 이동, 확대, rainbow, shake, 중간 회전의 횟수와 속도 곡선은 기존 finale와 같습니다.
- 마지막 회전 **시작 직전** 작혼식 후반부로 전환합니다. 마지막 회전 자체는 재생하지 않습니다. 제출이 하나뿐이면 중앙 확대와 shake 직후 전환합니다.
- 사용자가 확정한 배치: **A~M 전체 슬롯**, 기존 문제 결과를 표시하고 마지막 문제 위치만 비웁니다. 실제 구현은 `contest.problems` 순서를 사용하며 13개나 A~M을 하드코딩하지 않습니다.
- 전체 격자 줄의 중심은 뷰포트 정중앙입니다. 해당 팀의 격자에 스포트라이트를 비추고 나머지 화면은 암전합니다. 넓은 화면에서도 격자 폭에 상한을 두며, 배경 순위표의 셀은 행 높이를 넘지 않게 제한합니다.
- 비행 중에는 직전 표시 상태를 유지합니다. 마지막 결과, 결과색, 시도 횟수, tooltip, DOM 접근성 텍스트는 타격 시점까지 노출하지 않습니다.
- 상승은 화면의 Y축으로만 움직입니다. 상승 궤적에 perspective, translateZ, rotateX/Y를 적용하지 않습니다. 앞부분의 기존 회전은 유지합니다.
- 시제품으로 연출을 검토한 뒤 제품 구현을 진행합니다. 이 문서는 계획이며 제품 코드를 변경하지 않습니다.

## 현재 구조와 구현 방식 선택

- `src/core/config.ts`: Zod 기반 award 설정, 기본값과 잘못된 입력 복구.
- `src/core/award.ts`: 마지막 공개 여부 결정. 이번 변경에 core 판정 로직 수정은 필요하지 않습니다.
- `src/ui/award/revealDriver.ts`: 속도 곡선, active reveal, busy deadline, 5초 finale hold.
- `src/ui/award/AwardView.tsx`: `RevealingCell`에서 실제 회전 재생, 부모에서 dim/confetti 표시.
- `src/store/appStore.ts`: `awardAdvance()`가 machine을 먼저 갱신하지만 화면 snapshot은 `awardCommitSnapshot()`까지 보류합니다.

검토한 방법:

1. 기존 격자 DOM만 이동: 공통 앞부분을 보존하기 쉽지만 framer-motion 행 transform/scale, stacking context, clipping이 수직 비행 및 전체 슬롯 배치에 간섭합니다.
2. **공통 앞부분 유지 + 후반부 portal (권장)**: 회귀 범위가 작고, 후반부의 좌표·크기를 viewport 기준으로 독립 제어할 수 있습니다.
3. 모든 finale를 새 엔진으로 교체: 공통화 폭은 크지만 기존 가챠의 타이밍과 CSS가 바뀔 위험이 큽니다. 이번에는 범위를 제한합니다.

## 연출 설계

앞부분은 기존 타이밍(`FINALE_PREHEAT_MS=1200`, `FINALE_ZOOM_MS=1000`, 기존 intermediate flip schedule)을 그대로 사용합니다. 아래 후반부 시간은 **제안 초깃값**이며 시제품 피드백으로 조정합니다.

| 단계 | 제안 시간 | 화면과 데이터 |
|---|---:|---|
| launch | 450ms | 중앙의 마지막 문제 격자가 가속하며 화면 위로 완전히 이탈합니다. X 고정, Y만 감소합니다. rainbow/shake는 출발 시 종료합니다. |
| lineup | 500ms | 팀 이름과 전체 문제 슬롯을 화면 중앙에 한 줄로 펼칩니다. 마지막 슬롯은 빈자리입니다. |
| anticipation | 180ms | 빈자리를 보여주는 짧은 정적을 둡니다. |
| strike | 120ms | 화면 밖에서 마지막 슬롯 X좌표로 정렬한 격자가 수직으로 빠르게 내려옵니다. 행에 맞는 크기는 화면 밖에서 맞춥니다. |
| impact | 420ms | 접촉 순간 결과를 공개합니다. 50~60ms 정지감, 1.2배 squash/overshoot, 2~3회의 빠르게 감쇠하는 화면 흔들림, 충격파와 짧은 입자 burst를 동기화합니다. |
| settled / hold | 기존 5000ms | 결과를 읽을 수 있도록 유지한 뒤 보드로 복귀합니다. 기존처럼 정착 후 busy를 해제합니다. |

예: 마지막 문제가 H이면 `[A][B][C][D][E][F][G][빈자리][I][J][K][L][M]` → 타격 순간 H가 채워집니다. 실패 finale도 동일한 순서로 실제 No 결과를 표시합니다. Yes만 축하 입자를 사용하고, No에서는 중립 충격파만 사용합니다. 사운드는 별도 자산이 정해지지 않았으므로 이번 초안은 시각 연출로 설계합니다.

시제품은 검토 시간을 줄이기 위해 앞부분을 축약했고, 전체 길이는 10초입니다. 재생/정지, 타임라인 탐색, 마지막 문제 A~M 선택, Yes/No, 0.5배속을 제공합니다. 제품의 기존 앞부분과 타이밍까지 재현한 회귀 기준은 아닙니다.

## Global Constraints

- 기본 `gacha-ssr`의 6단계, 타이밍, Yes confetti, 일반 가챠 조건은 그대로 보존합니다.
- `src/core/types.ts`의 도메인 계약은 수정하지 않습니다. 표현용 타입은 award UI 모듈에서 정의합니다.
- portal 안에서도 `ProblemCell`을 사용하여 문자, 시도 횟수, first/last solve 색 규칙을 공유합니다. portal에는 scoreboard class와 필요한 CSS 변수/폰트 크기를 명시하여 상속 손실을 방지합니다.
- 순위·점수는 impact와 그 정착이 끝나 `onSequenceEnd`가 호출된 뒤에만 commit합니다. 시각 공개는 impact 접촉 순간입니다.
- 비행 레이어는 `position: fixed; inset: 0`이며 행의 transform 바깥에 둡니다. 원본 격자는 후반부 동안 숨기되 레이아웃 공간을 유지합니다.
- 13칸은 줄바꿈 없이 viewport 폭에 맞춥니다. resize 시 슬롯 위치와 비행 좌표를 함께 재계산합니다.
- 새 타이머/RAF/animation 이벤트는 취소 가능해야 하며 sequence id로 중복 완료와 오래된 콜백을 막습니다.

## Review Focus

1. 한 번 제출한 finale: intermediate가 없어도 launch부터 정확히 실행합니다. → Task 3.
2. 실패 finale: 착지 전 결과 누출이 없고 No가 실제로 표시됩니다. → Task 2, 3.
3. 마지막 문제가 A/M, 문제 수가 13이 아닌 대회: 빈자리와 착지 X가 맞고 한 줄이 유지됩니다. → Task 2, 4.
4. StrictMode, unmount, 빠른 키 연타, animationend 누락: 두 번 공개/commit하거나 busy가 남지 않습니다. → Task 3.
5. magnify, 행 transform, 창 크기 변경: 이동이 viewport 수직 방향으로 유지되고 원본과 portal이 이중 표시되지 않습니다. → Task 4.

## Task 1: 설정과 기존 경로 보존

**Files:** Modify `src/core/config.ts`, `test/core/config.test.ts`, `README.md`, `public/config.json`.

**Interfaces:** `AwardConfig['finaleType']`은 두 문자열의 union입니다. UI 모듈에서 `type FinaleType = AwardConfig['finaleType']`으로 참조합니다.

- [x] 설정 테스트: 생략/빈 award → `gacha-ssr`, 두 값 각각 허용, 알 수 없는 값은 오류 보고와 기존 default 복구. 기존 전체 기본값 비교에도 필드를 추가합니다.
- [x] `npx vitest run test/core/config.test.ts`로 실패를 확인합니다.
- [x] Zod enum/default와 README 설정표, public 기본 설정을 추가합니다. 로컬 운영 설정은 자동 변경하지 않습니다.
- [x] 동일 테스트를 통과시키고 기존 `test/ui/award.test.tsx`가 기본 설정에서 유지되는지 확인합니다.

## Task 2: 후반부 표시 모델과 portal 무대

**Files:** Create `src/ui/award/mahjongFinale.ts`, `src/ui/award/MahjongFinaleStage.tsx`, `src/ui/award/mahjongFinale.css`, `test/ui/mahjong-finale.test.tsx`.

**Interfaces:**

- `buildMahjongFinaleModel(problems: readonly Problem[], before: TeamStanding, after: TeamStanding, problemId: string): MahjongFinaleModel`.
- 모델은 문제 표시 순서, 기존 셀의 복사본, 마지막 슬롯 index와 별도의 최종 셀 복사본을 가집니다. before/after map을 변경하지 않습니다.
- `MahjongFinalePhase = 'launch' | 'lineup' | 'anticipation' | 'strike' | 'impact' | 'settled'`.
- `MahjongFinaleStage({model, phase, showFirstSolve, originRect})`: 렌더링만 담당합니다. 단계 진행용 독립 타이머는 만들지 않습니다. `originRect`는 전환 시 측정한 확대 격자의 viewport DOMRect입니다.

- [x] 모델/렌더링 테스트: A~M 전체 13칸, H만 비어 있음, A/M 위치, 3문제 대회 순서, before 불변, impact 전 최종 결과의 텍스트·색·title·접근성 노출 없음, impact 후 accepted/failed 및 실제 색 플래그 일치.
- [x] 새 테스트가 실패하는지 확인하고 모델과 portal 표시를 구현합니다.
- [x] 발사는 `originRect` 중심 X를 유지하고 Y만 감소시킵니다. 마지막 슬롯은 매 프레임 DOM 재측정 대신 단계 진입과 resize에서 측정합니다.
- [x] 테스트를 통과시킵니다. phase를 주입하여 각 장면을 독립 검증합니다.

## Task 3: 마지막 회전 분기와 재생 수명주기

**Files:** Modify `src/ui/award/revealDriver.ts`, `src/ui/award/AwardView.tsx`, `test/ui/award.test.tsx`, `test/ui/mahjong-finale.test.tsx`.

**Interfaces:** `ActiveReveal`에 finale type을 고정 저장합니다. `useRevealDriver`는 설정의 finale type을 입력받고, play 시 이를 캡처합니다. `FinalePhase`에 위 후반부 phase를 포함합니다. 전환 직전 model/originRect를 부모에 전달하고, 기존 `onFinalePhase`로 단계를 보고합니다.

- [x] 통합 테스트: 기존 `gacha-ssr` 전체 순서 유지, 작혼식은 마지막 flip 시작 전 분기, intermediate 수/시간 동일, single-run 바로 launch, 일반 gacha 불변.
- [x] fake timer 테스트: impact 이전 snapshot 미갱신, 정착 후 snapshot commit 1회, accepted/failed 모두 정확, 5초 hold 종료, 재생 중 키 입력 무시.
- [x] StrictMode/unmount/animationend 누락 및 오래된 sequence callback 테스트를 추가하고 실패를 확인합니다.
- [x] 마지막 flip 루프 진입 직전에 type 분기를 추가합니다. 공통 앞부분과 기존 gacha 분기는 재작성하지 않습니다. after 상태는 machine에서 얻되 별도 모델에 보관하고, 보드는 deferred snapshot을 계속 렌더링합니다.
- [x] 작혼식 deadline은 preheat+zoom+intermediate fallback 상한(각 2배)+후반부 총시간+기존 안전 margin으로 계산합니다. 마지막 slow flip 시간은 포함하지 않습니다. 단계 타이머 취소와 idempotent 완료를 구현합니다.
- [x] 마지막 단계 완료 시 기존 snapshot commit/driver 완료 경로를 1회 사용하고 hold를 유지합니다. unmount는 취소만 하고, 재생 중 애니메이션 이벤트 누락은 fallback으로 완료합니다.
- [x] 새 통합 테스트 및 기존 award/store 테스트를 통과시킵니다.

## Task 4: 화면 크기와 타격감 검증

**Files:** Modify 새 `mahjongFinale.css`, 필요 시 `MahjongFinaleStage.tsx`, `test/ui/mahjong-finale.test.tsx`.

- [x] resize/슬롯 계산 테스트: 1280×720, 1920×1080, 3840×2160, magnify on/off, 마지막 문제 A/H/M. 320px 폭에서도 슬롯이 겹치지 않도록 compact 레이아웃을 검증합니다.
- [x] 실제 브라우저에서 수직 발사, viewport 이탈, 빈자리 인지 시간, 착지와 공개의 동시성, hold 후 정상 보드 복귀를 확인합니다. jsdom만으로 타격감 통과를 선언하지 않습니다.
- [x] `prefers-reduced-motion`에서는 큰 이동/진동/flash를 줄이되 빈자리 → 결과 공개 순서와 완료 처리는 유지합니다.
- [x] `npm run typecheck`, `npm test`, `npm run build`를 실행하고 결과를 기록합니다.
- [x] 제품 구현 확인도 샘플 데이터의 재생 가능한 시각화를 사용자에게 제시합니다. 승인 이후 커밋/통합 방법은 해당 시점 요청 범위에 따릅니다.
