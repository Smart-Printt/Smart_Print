# Week 8: A Fresh Clone That Works in Docker, and a Pull Request With Nothing Left to Merge

Harbani Kaur
Roll No: 1024030848
9 – 15 November 2026

## 1 Context

This week I closed the follow-ups from Week 6: the Docker and configuration work, one shared
password-rules component, and an old pull request that was stuck with merge conflicts. No git
activity happened in Week 7, so this journal picks up straight after Week 6.

## 2 Docker and Configuration (PR #22)

In Week 4 I noticed that the setup instructions only worked on my machine. This week I fixed
the causes:

- **The frontend could not reach the backend in Docker.** The dev server forwarded `/api` to
  `localhost:4321`. Inside a container, `localhost` is the container itself, not the backend. The
  target now comes from `VITE_PROXY_TARGET` (default `http://localhost:4000`), and
  `docker-compose.yml` points it at the `backend` container.
- **The dev server also listens on all interfaces**, otherwise Docker's port mapping cannot
  reach it.
- **`backend/.env` is now optional in Docker.** A fresh clone has no `.env`, and compose used to
  refuse to start without it. `PORT` and `JWT_SECRET` now have defaults in the compose file, and
  `PORT` is fixed to 4000 so a different value in someone's own `.env` cannot break the port
  mapping.
- **One port story:** 4000 everywhere. The old 4321 mention is gone from the README.
- **Node version:** the frontend image uses Node 24, the same as CI.
- **Wrong README logins.** The Docker README listed seed accounts that no longer exist. It now
  lists the real ones from the seed file.

**What I could not test:** I validated the compose file (`docker compose config`) and the
frontend build, but Docker Desktop was not running, so I did not do a full `docker compose up`
on a clean clone. That check is still open.

## 3 Shared Password Rules (PR #24)

The register and reset-password pages each carried their own copy of the password checks and the
rule list. They now use the shared `PasswordRules` component and `passwordPolicy` file that
Change Password already used, so the rules live in one place. There is no visible change; type
checking is clean and all 197 frontend tests pass.

## 4 Debugging: A Pull Request With Conflicts and Nothing Left to Merge (PR #9)

**Error encountered:** PR #9 ("database integrity constraints") showed "Merge conflicts" on
GitHub and could not be merged.

**Relevant context:** the PR was three weeks old. In that time `main` had moved on, including
the removal of the old duplicate `init` migration (Week 4).

**Key observation:** I merged `main` into the branch and resolved three conflicts, always
keeping `main`'s newer version (the deleted migration, and two test setup files). After that, the
PR showed **0 files changed**: everything it set out to do had already reached `main` through
other pull requests. The conflicts were only left over from the same work being done twice.

We keep merged branches and pull requests on GitHub on purpose, so the history stays visible.

## 5 Outcome

- PR #22 merged; PR #24 open; PR #9 merged after conflicts were resolved.
- Setup from a fresh clone is simpler, with one port and no required `.env` file in Docker.

## 6 Follow-ups

- Run a full `docker compose up` from a clean clone with Docker Desktop running, and confirm
  the login works end to end.
- Ina should run `npx prisma migrate dev` after pulling, because PR #20 adds an indexes
  migration.
