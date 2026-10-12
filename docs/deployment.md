# GitHub 및 Sites 배포 기준

Codex가 이 프로젝트의 웹사이트 코드를 수정하면 검증 후 `main`에 commit/push하고,
Sites의 기존 프로젝트에 배포한다. 사용자에게 배포 성공 상태와 실제 사이트 URL을 알린다.
사용자가 로컬 작업만 요청하거나 push/배포하지 말라고 하면 해당 요청이 우선한다.
문서·에이전트 지침만 수정하거나 로컬 데이터만 내려받은 작업에는 사이트 배포가 필요 없다.
Vercel 배포, Vercel 환경변수 동기화, Vercel production 확인은 기본 완료 조건이 아니다.

## 기존 사이트

- GitHub: https://github.com/sunshade8/qquan
- 기본 브랜치: `main`
- Sites 프로젝트: `appgprj_6a91dce3c51c8191bdb6b066a1c71d07`
- 기존 URL: https://qquant-research.stevenpark119.chatgpt.site
- 호스팅 선언: `.openai/hosting.json` (`d1: "DB"`, `r2: null`)

배포 시 Sites 스킬과 도구를 사용한다. 기존 사이트 정보를 조회해 프로젝트와 접근 권한을
확인하고, 같은 프로젝트의 소스 저장소를 열어 검증된 소스를 동기화·패키징한다.
프로젝트 ID와 기존 비공개 접근 권한을 유지하며, 공개 전환은 사용자 요청이 있을 때만 한다.
저장된 버전을 해당 접근 권한에 맞는 Sites 배포 도구로 배포하고 최종 성공 결과를 확인한다.
로컬 빌드 성공이나 GitHub push 성공만으로 배포 완료를 보고하지 않는다.
DB/API 연결이 필요한 변경은 연결과 실제 동작도 확인하고, 실패는 원인과 함께 보고한다.

## 로컬 실행과 호스팅의 경계

2026-10-13부터 앱/연구/상태 DB/시장 데이터의 기본 실행은 로컬 Node + SQLite + Parquet다.
Cloudflare 자격증명 없이 `npm run data:setup && npm run local`로 실행한다.
설치·백업·이전·다운로드·정책은 [로컬 실행 문서](local-runtime.md)를 따른다.

Sites 서버 코드는 Cloudflare Workers에서 동작하며 D1 바인딩을 사용한다.
로컬 `~/.qquan`의 SQLite·Parquet 파일은 배포로 업로드되거나 Sites에서 접근 가능해지지 않는다.
Sites에서 공통 시장 데이터 조회는 인증된 `npm run data:bridge`의 outbound 연결로
같은 로컬 catalog와 snapshot을 사용한다. 연결이 끊기면 데이터 부족으로 판단하지 않고
연결 오류를 반환한다. 설정·실행은 [로컬 실행 문서](local-runtime.md)를 따른다.
로컬 연구 실행과 Sites 호스팅의 런타임 차이를 확인하고, 호환되지 않는 기능을 배포 완료로
간주하지 않는다. 장기 연구·다운로드·거래 감시에는 독립 실행기가 필요하다.
Toss 계좌·주문 API에는 허용된 출구 IP가 필요하며, 확인 중 토큰을 임의로 재발급하지 않는다.
자세한 제약은 [토스 API 문서](toss-api.md)를 따른다.

## 환경변수와 비밀값

`.dev.vars`, `.env*` (예외: `.env.example`)의 비밀값을 Git에 넣지 않는다.
`.env.example`에는 변수 이름과 비밀이 아닌 기본값만 둔다.
호스팅 환경변수 변경은 Sites 환경변수 도구로 기존 프로젝트에 반영한다.
로컬 파일이 호스팅 환경에 자동 반영된다고 가정하지 않는다.

## 기존 Vercel 구성

레포에 남은 Vercel 빌드·배포 스크립트와 GitHub 자동 연동은 과거 구성이다.
이 문서 수정은 Vercel의 실제 연동을 해제하지 않는다. 따라서 `main` push가 기존 Vercel
자동 빌드를 유발할 수 있지만, 이를 Codex 작업의 필수 배포 대상이나 완료 기준으로 사용하지 않는다.
