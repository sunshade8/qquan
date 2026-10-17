# 디자인 시스템 (2026-10-13)

데이터 밀도가 높은 트레이딩 터미널이다. 랜딩 페이지가 아니다. 규칙이 충돌하면
**기능·데이터 정확성 > 트레이딩 가독성(숫자·상태·리스크) > apple-design > taste 스킬 > 개인 취향** 순으로 따른다.
스킬은 `.agents/skills/`(apple-design, emil-design-eng, design-taste-frontend, redesign-existing-projects, minimalist-ui)에 있다.
gpt-taste, stitch-design-taste와 랜딩/포트폴리오 전용 규칙(히어로, 스크롤 연출, 무한 모션)은 적용하지 않는다.

## 토큰 (`app/globals.css` `:root`, 다크 값은 `prefers-color-scheme: dark` 블록)

| 구분 | 토큰 |
| --- | --- |
| 표면 | `--bg` `--panel` `--panel-alt` `--surface-sunken`, 보더 `--line` `--line-strong` |
| 텍스트 | `--text` `--secondary` `--tertiary`(장식·비활성 전용, 정보 텍스트는 `--secondary`) |
| 액센트 | `--accent`(=`--blue`) `--accent-soft` `--accent-solid`(흰 글자 버튼 배경, 대비 확보) `--accent-ink` `--focus` |
| 손익·방향 | `--up`(=`--green`) `--down`(=`--red`) `--up-soft` `--down-soft`. **손익과 방향에만** 쓴다 |
| 경고·오류 | `--warn` `--warn-text` `--warn-soft`(앰버 하나), `--danger` `--danger-soft`(오류와 파괴 동작에만) |
| 간격 | `--sp-1..7` = 4 8 12 16 24 32 48 |
| 타입 | `--fs-1..6` = 11 12 13 15 18 24, `--lh-tight/ui/read`, `--font-mono` |
| 반경 | `--r-1` 6(작은 컨트롤) `--r-2` 10(컨트롤) `--r-3` 14(컨테이너), `--control-h` 32 |
| 그림자·레이어 | `--shadow-pop`(팝오버·드로어 전용), `--z-sticky/rail/pop/drawer` |
| 모션 | `--ease-out-strong` `--ease-out` `--press` `--hover` `--settle` |

원칙: 표면 분리는 그림자가 아니라 hairline 보더와 미세한 배경 차이. 반투명 blur는 rail, command bar, CT sticky 상태바에만.
숫자는 `font-variant-numeric: tabular-nums`, 해시와 코드는 mono, 한글은 `word-break: keep-all`.
모든 모션은 `prefers-reduced-motion`을 존중한다. 데이터 카테고리 색(캘린더 이벤트 종류, 차트 계열)은 의미 색이므로 토큰화 대상이 아니다.

## 프리미티브 (`app/ui.css`, 접두사 `ui-`)

`ui-btn`(`primary` `ghost` `danger` `sm` `lg`), `ui-field`/`ui-input`, `ui-card`(`pad` `quiet`), `ui-badge`(`data-tone`),
`ui-dot`, `ui-segmented`, `ui-disclosure`(details), `ui-metrics`/`ui-metric`, `ui-empty`, `ui-alert`(`data-tone` warn/danger/info/quiet),
`ui-meter`(값/한도, 80%부터 앰버), `ui-table`, `ui-num` `ui-mono` `ui-sr-only` `ui-korean`.
새 UI 라이브러리나 모션 라이브러리는 추가하지 않는다. 아이콘은 lucide-react만 쓴다.

## CT 진행 추적 (`app/ct-progress.tsx`)

이미 폴링하는 `job`/`ct`(+ 실행 중 작업의 `liveMeter`)에서 파생한다. 파생 규칙은 `lib/ct-activity.ts`.
스타일 `app/ct.css`는 `globals.css`의 `@import`가 아니라 `app/ct-*.tsx`가 직접 import한다(전략 탭 `strategy-research.css`와 같은 방식). `@import`로 넣으면 dev 핫리로드 때 새 마크업이 이전 스타일시트와 짝지어져 레이아웃이 풀린 채 보일 수 있다.

- `LiveStatusBar`: 상태 점, 단계 n/11, 경과, 후보 n/최대, 백테스트, 비용 미터(80% 이상 앰버), 러너, 일시정지/재개/취소. 비용과 후보 수는 여기에만 둔다.
  running/paused에서는 `position: sticky`. 낭독용 `aria-live`는 단계·상태 문구가 바뀔 때만 바뀐다.
- `PhaseStepper`: 11단계. 완료/진행/대기/실패/중단/건너뜀. 설계-실험-수정 루프는 "후보 n · 수정 m회차"를 표시한다.
  통과 후보가 없어 실행하지 않은 단계(위험 검토, 최종 평가, 독립 최종 검토)는 완료가 아니라 "건너뜀"으로 표시한다.
  스테퍼 아래 한도 미터는 활성 시간만 보여 준다(비용과 후보는 상태 바에 있다). 예상 완료 시각은 만들지 않는다.
- `ActivityFeed`: `ct.tools` 최신순 한 줄 요약. 원시 JSON과 결과 다운로드는 펼친 항목에만 있다.
- `LatestTrialCard`: 최신 후보의 통과/미달, 사유, 개발 구간 핵심 지표.
- `NowPanel`: 현재 작업 주체 한 문장(작업이 바뀔 때만 220ms 블러-페이드로 교체, 낭독도 그때만), 모델 호출 경과 시계와
  실시간 토큰(출력 한도 80%부터 앰버), 재시도 카운트다운, 멈춤 경고, 에이전트 6개 카드(작업 중=액센트, 재시도/실패=앰버, 미사용=점선).
  작업 중 아이콘의 회전 링은 상시 모션이라 linear, reduced-motion에서는 정지. 폰에서는 카드가 촘촘한 목록으로 바뀌고 역할 설명과 모델명을 숨긴다.
- `ActivityFeed`는 도구와 모델 호출을 한 시간순으로 섞고 `도구`/`모델` 표식으로 구분한다. 마운트 이후 새로 온 행만 들어오는 모션을 쓴다.
- 폴링은 응답 원문이 같으면 상태를 갱신하지 않는다. 후보 이력, 출처, 피드는 변경이 있을 때만 다시 그린다.

## 전체 UI 감사 요약 (redesign-existing-projects 절차)

| 발견 | 조치 |
| --- | --- |
| 액센트가 3개(파랑, 보라 `#684bd1`, 주황 `#c2410c`)이고 투자 탭 강조가 보라 | 모두 `--accent`로 통일 |
| 앰버 하드코딩 10여 종 | `--warn` / `--warn-text`로 통일, 다크 값 추가 |
| `ct.css` 폴백 색 `#626fe6` `#30343e` `#8a929e` | 토큰으로 교체(파일 재작성) |
| 글자 크기 6.5~12px가 혼재 | 투자·전략·급등주·트레이딩 대시보드 구간을 5~6단계 스케일로 정렬. 랩, 뉴스, 캘린더는 레이아웃이 7~9px에 맞춰져 있어 이번에는 유지 |
| 반경 5~16px 혼재 | 16px 이하를 `--r-1/2/3`로 정렬 |
| 흰 글자 파랑 버튼 대비 부족(4.0:1) | `--accent-solid`로 4.5:1 이상 확보 |
| `--tertiary` 대비 부족 | 라이트 `#86868c`, 다크 `#8a8a91`로 상향 |
| 포커스 링이 `summary`, `a`에 없음 | 전역 `:focus-visible` 확장 |
| 시작/정지 버튼이 초록/빨강 채움 | 시작은 accent, 정지는 danger(스타일만 변경, 로직 무변경) |

## UI 정리 2026-10-17 (apple-design + design-taste-frontend)

지시서 `docs/prompts/ui-polish-apple-taste.md`. 문제 목록, 정보 구조 제안, 전후 스크린샷은 `docs/ui-audit/`(README, `before/`, `after/`).
로직·API·폴링·저장 형식은 그대로고 마크업, 배치, CSS만 바꿨다.

원칙: 한 화면에 주 행동 하나(primary 하나), 점진적 공개(과정과 참고 자료는 접기), 같은 숫자는 한 곳에만, 상태는 중립/앰버/danger, 정보는 위(상태·결과) → 가운데(접힌 과정) → 아래(접힌 참고 자료).

CT·T 연구 탭 배치 (`ct-workspace.tsx`, `t-workspace.tsx`, 두 파일은 같은 구조):

- 툴바 한 줄: 시장(주식/코인) + 연구/검증/운용 탭. 헤더는 제목과 한 줄 설명.
- 연구가 없으면: 시작 카드(primary "전략 생성", 선택 설정은 접힘) → 빈 상태.
- 연구가 있으면: 상태 바(진행 중이면 sticky) → 지금 하는 일(`NowPanel`, 에이전트 카드는 "에이전트 n개"로 접힘) → 결과 카드(끝난 연구) →
  `진행 단계와 활동 기록`(진행/일시정지 중 펼침, 끝나면 접힘) → 등록된 전략 → `새 연구 시작` → `연구 상세 기록`(항상 접힘: 설계 세션, 플레이북, 후보 이력, 근거 차트, 출처, 부품·북, 고급).
- 접힌 묶음은 `.ct-steps`, `.ct-detail-group`(카드 모양 `ui-disclosure`), 레이아웃 컨테이너는 `.ct-research`(grid), 툴바는 `.ct-toolbar`.
- T의 `모델 배치` 표는 접힌 카드(`.t-models`)로 옮겼다. 운용 탭의 연결 상태 표는 `ui-disclosure`, 패키지 선택은 `.ct-package`.
- 설정의 로컬 데이터 카드: 상태 한 줄과 버튼(`ui-btn`)만 보이고 저장 위치와 검증 범위는 접었다. 작업 오류는 접힌 영역 밖에 경고로 둔다.
- `ct.css`의 하드코딩 색(`#0f9d58`, `#b45309`, `#fff`, `#ddd`)과 반경 6/8px를 토큰(`--up`, `--warn-text`, `--panel-alt`, `--line-strong`, `--r-1/2`)으로 바꿨다. 검증 탭 수제 폼은 `ui-input`과 같은 모양.
- 모바일: 투자 서브탭의 설명 줄을 숨기고 가로로 스크롤, 시장 설명 문구 숨김, 접힌 묶음 좌우 여백 축소.

감사 요약 (상세는 `docs/ui-audit/README.md`):

| 발견 | 조치 |
| --- | --- |
| 끝난 연구의 결과가 스테퍼·피드 아래 | 결과를 상태 바 바로 아래로, 과정은 접기 |
| 상세 기록 7종이 펼친 채 세로로 쌓임 (연구 한 건 약 2,400px) | 한 묶음으로 접음 (약 560px) |
| 비용·후보가 상태 바와 스테퍼에 중복 | 스테퍼에는 활성 시간만 |
| 헤더·시장·서브탭 세 줄 | 툴바 한 줄 |
| 설정 데이터 카드의 맨 버튼과 긴 문단 | `ui-btn`, 세부는 접기 |
