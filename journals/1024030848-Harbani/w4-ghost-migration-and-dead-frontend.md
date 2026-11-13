# Week 4: The Ghost Migration, the Dead Frontend, and Deleting My Own Code

Harbani Kaur
Roll No: 1024030848
12–18 October 2026

## 1 Context

We split the remaining SmartPrint work between Ina and me, aiming for equal effort and minimal
overlap. My share: frontend cleanup, account and profile management, order pagination and
filtering, Docker and configuration, and testing infrastructure with CI. Before building
anything new, I tried the most basic test a project can pass: set it up from a fresh clone and
run the migrations. It failed, and following that failure turned this whole week into a dig
through the Week 2 rescue commit.

## 2 Debugging: The Migration That Was Deleted in a Journal, but Not in Git

**Error encountered:** on a fresh database, `npx prisma migrate dev` stopped with **P3006** in
the shadow database — migration `20260902130600_init` failed because type `"UserRole"` already
existed.

**Relevant context:** the migrations folder contained **two** initial migrations,
`20260901123600_init` and `20260902130600_init`. They weren't duplicates: the first used
singular table names (`user`, `order`), integer `SERIAL` ids and an order status called
`CREATED`; the second used plural tables (`users`, `orders`), UUID text ids and `PLACED`.
Prisma applies migrations in timestamp order, so the older draft always ran first and the
real schema then tried to create the same enums again.

**Key observation:** Ina's own Week 2 journal explains exactly where this came from — she
found modeling problems in her first migration, dropped it, and generated a corrected one the
next day. But the first migration's folder was never removed from the *repository*, and the
single rescue commit carried both into history. I confirmed which one
was real before touching anything:

- `schema.prisma` maps every model to the plural tables with `@default(uuid())` ids — only
  the second init matches it.
- All seven later migrations alter plural tables (`users`, `documents`, `print_shops`), so
  they were built on the second init and would fail on the first.
- My local `_prisma_migrations` table listed exactly eight applied migrations, from the
  second init onwards, with checksums identical to the committed files. The first init had
  never been applied anywhere it could have succeeded.
- `prisma migrate diff` from my database to `schema.prisma` came back empty: the eight
  migrations alone reproduce the current schema exactly.

**Solution:** delete only the orphaned `20260901123600_init` folder — no rewriting of applied
migrations, and no new "squashed" baseline (that would have forced Ina and me to manually
mark migrations as applied on our databases). Before committing, I verified it against a
brand-new, empty database: all eight migrations applied, `migrate dev` ran clean with no
P3006, `migrate status` on my existing database still said "up to date", and the full backend
suite passed (13 suites, 336 tests). Merged as PR #4.

**Because** a migration history is a log, not a folder of options: every file in it will be
replayed, in timestamp order, on every fresh database. Deciding to abandon a migration is only
half the job — the file has to go too, or the decision exists only in your memory (and, in
this case, in a journal).

## 3 Proving Code Is Dead Before Deleting It

My first assigned task was frontend cleanup, and it held a surprise: several of the files on
the list were **mine**. `ProtectedRoute.tsx`, the `Login`/`Register` pages and the
`useAuth`-from-`AuthContext` pattern I wrote in Week 2 had all been replaced by a later
rewrite (`routes/guards.tsx`, `LoginPage.tsx`, `RegisterPage.tsx`, `hooks/useAuth.ts`). The old
versions were still sitting in `src/`, unused.

"Unused" is a claim, so I proved it for each of the 15 candidate files instead of trusting a
quick search:

- **Import graph.** I resolved every real `import`, `export … from` and lazy `import()` —
  including the `@/` alias — starting from `index.html` → `main.tsx` → `App.tsx`. The app
  reaches 79 of 108 source files; none of the 15 was reachable from the app or from any test.
- **Router.** All 24 routes in `App.tsx` point to `*Page.tsx` components; none to the old files.
- **Compiler.** The old files couldn't even build: `api/client.ts` imports `axios`, which
  isn't a dependency, and seven files imported a `useAuth` that `AuthContext` no longer
  exports. They were the source of all **22** TypeScript errors breaking `npm run build`.
- **Backend contract.** The old pages called endpoints that no longer exist (`/queue/*`,
  `/payments/orders/:id`, `/refunds`, `/users`) and stored the login token under a different
  key from the current app — so they couldn't have worked even if routed.
- **A fossil.** A stale, committed `tsconfig.tsbuildinfo` recorded the file list of an
  earlier version of the app: the old pages, `NavBar`, `ProtectedRoute`, `api/client.ts` —
  and none of today's pages. It was a snapshot of the frontend before the rewrite.

One file got special treatment: `AdminUsers.tsx` was the only old page with **no** current
replacement, and its feature (admin user management) is Ina's next task. I tried keeping it,
but it imports the deleted API layer, so the build broke again. Final decision: delete it and
point Ina to its last version in history (`git show 9987fb4^:code/frontend/src/pages/admin/AdminUsers.tsx`).

Two more files (`StatusBadge.tsx`, `services/index.ts`) also looked unreachable — but they
weren't part of the reviewed list, so they stayed out of the PR. **A pull request should have
one clear scope**: a reviewer can approve "these 15 files, each proven dead" in minutes; a
cleanup that keeps growing while you work is much harder to trust. Result (PR #7): 15 files
and about 1,500 lines removed, build errors 22 → 0, all 78 frontend tests passing. Small
follow-ups that same day: the stale `tsbuildinfo` files were untracked and ignored, and
`mkdocs.yml` stopped pointing at a theme folder that was never committed, which had been
failing every docs build.

## 4 Smaller Lessons

- **Security warnings need context.** `npm install` reported two "high severity"
  vulnerabilities (`undici`, `source-map-js`). Both turned out to be dev-only, indirect
  dependencies (the test environment and the build tool) that never reach a student's
  browser. Low real risk, but a tiny lock-file-only fix, so I patched it anyway (PR #5).
- **"Port in use" is information, not noise.** Vite moved to 5174 because 5173 was taken —
  by our own Docker frontend container, which, it turned out, had never served a page: Vite
  inside the container only listened on the container's own `localhost`. This is the
  Docker-and-configuration work I own next.
- **Know which folder your containers came from.** Docker Desktop showed the running
  containers were built from a *different* clone of the repo than the one I was editing, so
  changes in one would never show up in the other.
- **Seed passwords are fine — until production.** The development seed gives every account
  the same published password. Harmless locally, but nothing stops the seed from running
  against a real deployment. A production guard belongs with Ina's security work, so I've
left it as a follow-up for her rather than patching it on my own.

## 5 Outcome

- Fresh clones can migrate again (PR #4); `npm run build` passes again (PR #7).
- Frontend dependency audit clean (PR #5); docs build and build-artifact hygiene fixed.
- My Week 2 scaffold is officially retired — replaced by better code, and removed on purpose,
  with evidence.

## 6 Follow-ups

- Docker and configuration: make Vite listen on all interfaces inside the container, point
  its proxy at the backend container, use the project's Node version in the images, and pick
  one port story for everyone.
- Separate development and test databases — the backend tests currently run against whatever
  `DATABASE_URL` the developer's `.env` points at.
- Ina should run `npx prisma migrate status` after pulling, to confirm her database agrees
  with the cleaned-up history.
