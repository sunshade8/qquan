# 에이전트 필독

**토스증권 Open API(계좌·주문·시세·랭킹)를 건드리는 작업 전에 반드시
`docs/toss-api.md`를 읽을 것.** 능력, 요율/수수료, 레이트리밋, IP 허용 목록 제약,
알려진 실수 목록이 정리되어 있다. 이 문서를 안 읽고 "토스는 시세 조회만 된다",
"토큰 재발급해도 괜찮다", "IP 문제인데 자격증명 문제로 오인" 같은 실수를 반복하지 말 것.

## GitHub 및 배포 작업 완료 기준

사용자가 이 프로젝트에서 요청한 수정은 검증 후 `main`에 commit/push하고,
GitHub에 연결된 Vercel `sunshade8s-projects/qquan`의 production 배포 상태까지 확인한다.
사용자가 명시적으로 로컬 작업만 요청하거나 push/배포하지 말라고 하면 그 요청이 우선한다.
파일 저장마다 중간 코드를 올리지 말고, 요청한 변경이 검증된 시점에 반영한다.

- 작업 시작 시 branch/status를 확인한다. 다른 작업의 미완성 변경을 임의로 포함하거나 덮어쓰지 않는다.
- `main` 이외의 브랜치라면 무조건 checkout하거나 force push하지 않는다. 필요한 병합을 안전하게 수행한다.
- `.dev.vars`, `.env*`의 비밀값은 절대 commit하지 않는다. `.env.example`에는 이름과 비밀이 아닌 기본값만 둔다.
- 환경변수를 변경했다면 `scripts/deploy/sync-vercel-env.mjs --apply`로 연결된 Vercel에 먼저 반영한다.
- 배포 구조와 현재 런타임 제약은 `docs/deployment.md`를 읽는다. Cloudflare 빌드 성공과 Vercel 배포 성공을 혼동하지 않는다.
- push 실패, 빌드 실패, DB 연결 미완료는 완료로 보고하지 말고 원인을 명확히 알린다.
