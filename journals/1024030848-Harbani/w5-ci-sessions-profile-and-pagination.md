# Week 5: CI, Real Logout, Profile Editing, and Pagination That Does Not Trust the Browser

Harbani Kaur
Roll No: 1024030848
26 October – 1 November 2026

## 1 Context

Week 4 ended with a clean repository and a list of my remaining tasks. This week I built most
of them: automated checks (CI), a proper session system, profile editing with change-password,
and server-side pagination and filtering for orders. The common thread is that each feature
looked small in the plan and turned out to hide one real design question.

## 2 CI: Making the Computer Say No

I added a GitHub Actions workflow with two jobs: backend (lint, build, test against a real
PostgreSQL service) and frontend (lint, build, test). Then I made both jobs **required** in the
branch ruleset for `main`, and set required approvals to 0, because with two developers a
mandatory review only slows us down. The checks are the safety net instead.

**Error encountered:** the frontend job failed on its very first run, even though everything
passed on my laptop.

**Cause:** the test environment (jsdom, which depends on undici) needs Node 22.13 or newer. My
laptop has Node 24, but the workflow said Node 20. "Works on my machine" was literally true.

**Solution:** set the frontend job to Node 24. The backend job stays on Node 20 and creates its
own `.env.test` pointing at a throwaway database.

**Because** CI only has value if it runs in a known, written-down environment. The workflow file
is now the written-down version of "how to run this project".

## 3 Sessions: A Deactivated User Could Still Use the App

**Problem:** our login gave a JWT valid for one day, and the server only checked its signature.
So an admin could deactivate a user, or a user could change their password, and the old token
kept working until it expired. A JWT is stateless: the server does not remember it, so the
server cannot take it back.

I solved this in three steps, each merged separately (PRs #17, #18).

1. **Check the database on every request.** The auth middleware now loads the user and rejects
   an inactive account immediately. It also rejects a token issued *before* the user's
   `passwordChangedAt`. Cost: one indexed lookup per request. Benefit: deactivation is instant.
2. **Short access tokens plus rotating refresh tokens.** The access token now lives 15 minutes.
   A random refresh token (stored only as a SHA-256 hash, sent as an httpOnly cookie that
   JavaScript cannot read) gets a new access token when the old one expires. Every refresh
   *rotates* the token. If an already-used token appears again, the whole family of tokens is
   revoked, because it probably means a copy was stolen. A 10-second grace window covers two
   browser tabs refreshing at the same moment.
3. **Real logout.** Logout now revokes the refresh token on the server and clears the cookie.
   Before, "logout" only deleted something in the browser.

Two details I almost missed:

- **CSRF and CORS.** Cookies are sent automatically, so the refresh and logout endpoints
  require a custom header (`X-SmartPrint-Client`) that another website cannot add without
  CORS permission. CORS now allows credentials only for origins on our allow-list.
- **Clock skew.** I compare `passwordChangedAt` (written by the app) with a refresh token's
  `createdAt` (originally written by the database). Two different clocks can disagree, so a
  freshly issued token could look older than a password change. I now set both from the app
  clock.

## 4 Profile and Change Password

Users can now edit their name and phone number, and change their password. Changing a password
revokes every other session and gives the current device a fresh one, so the user stays signed
in but a thief does not. The endpoint has its own rate limit (5 attempts per 15 minutes per
user), because it accepts the current password and is therefore a guessing target. The frontend
shows the password rules live, using one shared policy file so the rules cannot drift apart.

## 5 Pagination: The Server Decides, Not the Browser

The order list used to download every order and filter in the browser. That works with 20
orders and fails with 20,000. The API now accepts `page`, `limit`, `status`, `from`, `to`,
`shopId` and `q`, and returns the rows plus page information.

Decisions I had to make on purpose:

- **Limits.** Default 20, maximum 100, so nobody can request a million rows.
- **Stable order.** Newest first, with the order id as a tiebreaker, so rows never repeat or
  vanish between pages.
- **Security first.** A student's own-orders scope is combined with the filters using AND, so a
  filter can narrow results but never widen them.
- **Indexes.** Two composite indexes on `(userId, status, createdAt)` and
  `(shopId, status, createdAt)` match the real queries.
- **Admin summary.** Dashboard totals come from one small `/orders/summary` call, not from
  counting a downloaded list.

**Bug found by testing:** searching for `%` returned every order. The database's LIKE operator
treats `%` and `_` as wildcards, and Prisma's `contains` does not escape them. I now escape
`\`, `%` and `_` before searching, and added a test.

**The red cross that stayed behind.** On GitHub, my first pagination commit shows a red ❌
even though the pull request was green. The reason: CI checks every commit separately. The
first commit failed exactly one test, the `%` search test above, because the fix was not in it
yet. The next commit contained the fix and passed all checks. The old cross stays attached to
the old commit forever, but only the latest commit decides whether a PR can merge, and the
squash merge combined both commits into one clean commit on `main`. This is CI doing its job:
a test caught a real bug before it reached `main`.

**Testing it in the browser.** I tested with 45 fake `DEMO-` orders in my local database
(through a small script that refuses to run on any non-local database). I checked paging,
status and date filters, search, and the admin summary, then removed the demo orders with the
script's `--clean` option. Order pagination needs a database migration, so the backend has to
be stopped while running `npx prisma migrate dev` (on Windows a running backend locks Prisma's
files), and then restarted.

## 6 Test Failures Worth Remembering

After the session change, several tests failed in CI. Some expected 403/404 for inactive staff
and now correctly get 401. One rate-limit test used users that did not exist, which the new
database check rejects, so it now creates real users. One pricing test had been flaky on `main`
already (two timestamps in the same instant); making the past date explicit fixed it. A red
test is information: here it told me exactly which old assumptions my change broke.

## 7 Outcome

- PRs #16 to #20 are all merged (pagination as #20, squash merge, CI green, tested in the
  browser, demo data cleaned up afterwards).
- Sessions are now revocable, short-lived and rotated; deactivation takes effect on the next
  request.
- I also prepared a viva guide for myself covering these designs and the reasons behind them.

## 8 Follow-ups

- Tell Ina to run `npx prisma migrate dev` after pulling, because PR #20 adds an indexes
  migration.
- Docker and configuration: one documented `.env` setup and a fresh-clone check, still not done.
- Tell Ina about the session changes. Her admin deactivate button only needs to set the user's
  status to inactive, and the new middleware does the rest.
- Review the `npm audit` findings carefully, without `--force`, and add a cleanup for expired
  refresh tokens.
