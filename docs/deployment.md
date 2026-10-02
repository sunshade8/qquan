# GitHub / Vercel deployment

- Repository: https://github.com/sunshade8/qquan
- Production branch: `main`
- Vercel project: `sunshade8s-projects/qquan`
- Vercel settings: https://vercel.com/sunshade8s-projects/qquan/settings

Vercel's GitHub integration is connected. Every push to `main` requests a production
build; other branches receive preview builds. Do not add a second deploy workflow
that would build the same commit twice.

## Current runtime prerequisite

The application currently builds a Cloudflare Worker through vinext and uses a
Cloudflare D1 `DB` binding throughout its stores. This output cannot run directly
as a Vercel Function. Before Vercel can serve the application, configure a Node
build (vinext + Nitro) and a database adapter with access to the existing data,
or migrate the database. The existing private Sites deployment remains at
https://qquant-research.stevenpark119.chatgpt.site.

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
