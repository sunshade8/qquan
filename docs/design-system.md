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

새 API 없이 이미 폴링하는 `job`/`ct`에서 파생한다.

- `LiveStatusBar`: 상태 점, 단계 n/11, 경과, 후보 n/최대, 백테스트, 비용 미터(80% 이상 앰버), 러너, 일시정지/재개/취소.
  running/paused에서는 `position: sticky`. 낭독용 `aria-live`는 단계·상태 문구가 바뀔 때만 바뀐다.
- `PhaseStepper`: 11단계. 완료/진행/대기/실패/중단/건너뜀. 설계-실험-수정 루프는 "후보 n · 수정 m회차"를 표시한다.
  통과 후보가 없어 실행하지 않은 단계(위험 검토, 최종 평가, 독립 최종 검토)는 완료가 아니라 "건너뜀"으로 표시한다.
  한도(비용, 후보, 활성 시간)는 사용량 미터로 보여 주며 예상 완료 시각은 만들지 않는다.
- `ActivityFeed`: `ct.tools` 최신순 한 줄 요약. 원시 JSON과 결과 다운로드는 펼친 항목에만 있다.
- `LatestTrialCard`: 최신 후보의 통과/미달, 사유, 개발 구간 핵심 지표.
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
