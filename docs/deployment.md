# 현재 기본 실행: 사용자 컴퓨터

2026-10-13부터 앱/연구/상태 DB/시장 데이터는 로컬 Node + SQLite + Parquet다.
Cloudflare 자격증명 없이 `npm run data:setup && npm run local`로 실행한다.
Vercel을 연구 서버나 데이터 저장소로 사용하지 않는다. 이 변경에서는 배포하지 않았다.
설치·백업·이전·다운로드·정책은 [로컬 실행 문서](local-runtime.md)를 따른다.

아래는 과거 배포 구성 기록이며 현재 연구 실행의 필수 조건이 아니다.

# GitHub / Vercel deployment

- Repository: https://github.com/sunshade8/qquan
- Production branch: `main`
- Vercel project: `sunshade8s-projects/qquan`
- Vercel settings: https://vercel.com/sunshade8s-projects/qquan/settings

Vercel's GitHub integration is connected. Every push to `main` requests a production
build; other branches receive preview builds. Do not add a second deploy workflow
that would build the same commit twice.

## Current runtime prerequisite

The default build retains the vinext Cloudflare Worker and D1 `DB` binding used by
private Sites. Vercel now uses `npm run build:vercel` (vinext + Nitro, Node 24,
`.vercel/output`, 300-second maximum function duration, icn1). The `cloudflare:workers`
import is aliased to the Node environment adapter for this build only.

The Node adapter accesses the **existing** D1 database through parameterized D1 REST
queries and atomic batches. Configure these server-only variables first:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_D1_DATABASE_ID`
- `CLOUDFLARE_D1_API_TOKEN` with access to that database

These credentials were unavailable during CT implementation. The private Sites
binding does not expose a transferable REST token. There is no ephemeral or empty
DB fallback: data APIs return a clear 503 when the connection is unconfigured.
A READY deployment alone is therefore not confirmation that research or account
APIs work. The existing private Sites deployment remains at
https://qquant-research.stevenpark119.chatgpt.site.

D1 REST shares the Cloudflare global API limit and is primarily an administrative
interface. Measure production read/write load before continuous multi-book trading;
a scoped authenticated Worker proxy is a possible follow-up if the REST limit is
insufficient. Long-running research/trading still needs the independent runner;
Vercel function timers are not permanent workers. See [CT](ct.md).

Do not call a successful Cloudflare build a successful Vercel deployment. Verify
that the production deployment is READY and its data APIs work. Keep Vercel's
access protection: this project includes account and live-order APIs and previously
relied on the private Sites access gate.

## Environment variables

`.dev.vars`, `.env*` (except `.env.example`), and `.vercel/` are ignored by Git.
`.env.example` contains names and non-secret defaults only. Never paste secret
values into Git, logs, commit messages, or chat.

Link the checkout and synchronize existing local values:

```sh
vercel link --yes --project qquan --scope sunshade8s-projects
node scripts/deploy/sync-vercel-env.mjs
node scripts/deploy/sync-vercel-env.mjs --apply
```

The first invocation only lists key names. `--apply` updates Production, Preview,
and Development using encrypted variables, passing values through stdin. Local
files override example defaults. Empty optional values are skipped; absent keys
are not deleted remotely. Rerun after changing local environment values and before
pushing the commit that needs them. Vercel applies changes to the next deployment.

Toss account/order API access also requires a permitted outbound IP. Never mint
a test token during deployment verification: issuance invalidates the running
session's previous token. See `docs/toss-api.md`.
