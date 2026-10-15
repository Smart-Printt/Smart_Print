# Week 3: A Parallel Backend, a Shadowed Config, and a README That Described Another Project

Ina Sharma
Roll No: 1024030866
14–20 September 2026

## 1 Context

The Week 2 rescue commit got everything onto GitHub in one piece, but "everything" turned out
to include more than one version of the project. This week I tried to make the repository
build cleanly from scratch, and found three problems:
- a second, older backend living alongside the real one
- a stale config file silently overriding the real one
- a README describing a system we never built

Alongside that, Harbani and I wrote the mid-semester prototype report.

## 2 Debugging: Two Backends in One Folder

**Error encountered:** `npm run build` on the backend failed. `npx tsc --noEmit` reported more
than ten type errors, even though the server itself ran fine in development.

**Relevant context:** the running server is wired up in `app.ts`, which mounts the routers in
`src/routes/*.routes.ts` and their controllers and services. But the backend also contained a
complete parallel tree under `src/modules/`, with its own controller, routes and service for
each of `auth`, `documents`, `finishing`, `orders`, `orderStatus`, `payments`, `pricing`,
`queue`, `refunds`, `shops` and `users`. It also had `middleware/auth.ts`,
`middleware/shopAccess.ts`, `routes/index.ts` and `lib/{payment,storage}.ts`.

**Key observation:** `app.ts` didn't mount anything in `src/modules/`. It was an earlier
generation of the backend that had been replaced but never deleted. It was invisible at
runtime because nothing imported it. But TypeScript type-checks *every* file in the project,
and the old code defined its own user types that conflicted with the real
`AuthUser`/`AuthenticatedUser`. The dev server (`ts-node-dev --transpile-only`) skips
type-checking, which is exactly why "it runs" and "it builds" disagreed.

**Solution:** deleted the unmounted tree and its helpers, 37 files and 1,510 lines, and the
build passed again.

**Because** dead code isn't harmless just because nothing calls it. A compiler, a linter or a
test runner reads the whole folder, not just the import graph your app happens to follow at
runtime, so unused files still get to break the build.

## 3 Debugging: The Config File That Was Found First

**Error encountered:** the frontend dev server started, but the `@/` import alias and the
`/api` proxy to the backend didn't work.

**Relevant context:** `code/frontend/` contained both the real `vite.config.ts`, with the `@`
alias and the `/api` proxy, and a stale, git-tracked `vite.config.js` (plus a `.d.ts`): an
eight-line config with only the React plugin and a port number.

**Key observation:** when Vite looks for its config file, it checks `vite.config.js` *before*
`vite.config.ts`. It found the stale JavaScript file first and used it without saying so; the
real TypeScript config was never read. Nothing printed a warning, because as far as Vite could
tell, it had found a perfectly valid config.

**Solution:** deleted the stale `vite.config.js` and `vite.config.d.ts`, leaving
`vite.config.ts` as the only config.

**Because** a tool that looks for a config by filename stops at the first one it finds and
ignores the rest. A leftover generated `.js` next to a hand-written `.ts` is a trap, and
generated files like this one belong in `.gitignore`, not in a commit.

## 4 The README Was Describing a Different Project

The README still described our Week 1 brainstorm rather than the system we actually built: a
single Student role, **priority** handling, and **token generation** for the queue. The real
system has four roles (Student, Faculty, Shop Staff, Admin) and a strictly **FIFO** queue,
which is exactly what our senior advised in Week 1.

I rewrote it around the real four-role model, the real FIFO queue and the real feature set,
with concrete setup steps. I also updated `.env.example` to default to a native PostgreSQL on
port 5432, because the Docker Compose database is published on 5433, which collided with other
projects' containers on my machine. I documented the Docker option and the seeded development
accounts too.

A README is the first thing a reviewer, a new teammate or a viva examiner reads. If it
promises priority queues and tokens, they'll go looking for them, and every missing feature
looks like a failure when it was actually a deliberate scoping decision.

## 5 The Prototype Report

Harbani and I wrote the mid-semester prototype report together: use-case templates (UC-01 to
UC-08), activity and swimlane diagrams, DFDs (levels 0 to 2) and an SRS. From the backend
side, the most satisfying part was tracing the Week 1 survey into actual requirements. The
"faculty print free at the CSE department printer" rule, which shop staff used to enforce by
recognizing faces, is now a branch in the order flow: a free faculty order skips payment
entirely and goes straight into the queue.

## 6 Outcome

- The backend builds cleanly; the unmounted `src/modules/` generation is gone.
- The frontend dev server reads the right config again, with the alias and the proxy working.
- The README and `.env.example` describe the system that actually exists.
- Mid-semester prototype report written and committed with Harbani.

## 7 Follow-ups

- The Week 2 rescue commit clearly bundled more than one generation of the code. The same
  kind of leftovers may still be hiding elsewhere: frontend pages, migrations, build
  artifacts.
- `.env.example` now says 5432 while Docker Compose publishes 5433. Both work, but the repo
  should pick one documented default.
- Add generated files like `*.tsbuildinfo` and compiled config to `.gitignore`, so a stale
  copy can't shadow a real one again.
