# Week 5: CI, and Sessions That Can Actually Be Revoked

Harbani Kaur
Roll No: 1024030848
19–25 October 2026

## 1 Context

Week 4 ended with a clean repository and a list of my remaining tasks. This week I started
with the foundation for everything else: automated checks (CI), so every later change gets
tested before it reaches `main`. Then I fixed a security weakness I noticed in our login: a
deactivated user could keep using the app. Both looked small in the plan and each hid one
real design question.

## 2 CI: Making the Computer Say No (PR #16)

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

## 3 Sessions: A Deactivated User Could Still Use the App (PRs #17, #18)

**Problem:** our login gave a JWT valid for one day, and the server only checked its signature.
So an admin could deactivate a user, or a user could change their password, and the old token
kept working until it expired. A JWT is stateless: the server does not remember it, so the
server cannot take it back.

I solved this in three steps.

1. **Check the database on every request (#17).** The auth middleware now loads the user and
   rejects an inactive account immediately. It also rejects a token issued *before* the
   user's `passwordChangedAt`. Cost: one indexed lookup per request. Benefit: deactivation is
   instant.
2. **Short access tokens plus rotating refresh tokens (#18).** The access token now lives 15
   minutes. A random refresh token (stored only as a SHA-256 hash, sent as an httpOnly cookie
   that JavaScript cannot read) gets a new access token when the old one expires. Every refresh
   *rotates* the token. If an already-used token appears again, the whole family of tokens is
   revoked, because it probably means a copy was stolen. A 10-second grace window covers two
   browser tabs refreshing at the same moment.
3. **Real logout (#18).** Logout now revokes the refresh token on the server and clears the
   cookie. Before, "logout" only deleted something in the browser.

Two details I almost missed:

- **CSRF and CORS.** Cookies are sent automatically, so the refresh and logout endpoints
  require a custom header (`X-SmartPrint-Client`) that another website cannot add without
  CORS permission. CORS now allows credentials only for origins on our allow-list.
- **Clock skew.** I compare `passwordChangedAt` (written by the app) with a refresh token's
  `createdAt` (originally written by the database). Two different clocks can disagree, so a
  freshly issued token could look older than a password change. I now set both from the app
  clock.

## 4 Test Failures Worth Remembering

After the session change, several tests failed in CI. Some expected 403/404 for inactive staff
and now correctly get 401. One rate-limit test used users that did not exist, which the new
database check rejects, so it now creates real users. One pricing test had been flaky on `main`
already (two timestamps in the same instant); making the past date explicit fixed it. A red
test is information: here it told me exactly which old assumptions my change broke.

## 5 Outcome

- PRs #16, #17 and #18 merged, with both CI jobs required on `main`.
- Sessions are now revocable, short-lived and rotated; deactivation takes effect on the next
  request, and logout really logs out.
- Documented in `SECURITY_CONFIGURATION.md` (a new Sessions section).

## 6 Follow-ups

- Account management on top of the new sessions: profile editing and change-password.
- Order pagination and filtering.
- Tell Ina about the session changes. Her admin deactivate button only needs to set the user's
  status to inactive, and the new middleware does the rest.
- Review the `npm audit` findings carefully, without `--force`, and add a cleanup for expired
  refresh tokens.
