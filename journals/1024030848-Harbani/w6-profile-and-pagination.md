# Week 6: Profile Editing, and Pagination That Does Not Trust the Browser

Harbani Kaur
Roll No: 1024030848
26 October – 1 November 2026

## 1 Context

With sessions fixed in Week 5, I built two features on top of them: account management
(profile editing and change-password) and server-side pagination and filtering for orders. I
also tested pagination properly in the browser and prepared a revision guide for the viva.

## 2 Profile and Change Password (PR #19)

Users can now edit their name and phone number, and change their password. Changing a password
revokes every other session and gives the current device a fresh one, so the user stays signed
in but a thief does not. The endpoint has its own rate limit (5 attempts per 15 minutes per
user), because it accepts the current password and is therefore a guessing target. The frontend
shows the password rules live, using one shared policy file so the rules cannot drift apart.

## 3 Pagination: The Server Decides, Not the Browser (PR #20)

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

## 4 Understanding What I Built

Because a viva can ask "why", I wrote a revision guide for myself covering the architecture,
a glossary, the order workflow, and a deep dive for each feature (sessions, change password,
pagination, CI), with the reason behind every design choice and sample questions with short
answers. Writing the reasons down showed me which choices I could not yet explain, and I fixed
that before moving on.

## 5 Outcome

- PRs #19 and #20 merged (pagination as a squash merge, CI green, tested in the browser, demo
  data cleaned up afterwards).
- Students and staff get fast, filterable order lists, and every user can manage their own
  account safely.

## 6 Follow-ups

- Tell Ina to run `npx prisma migrate dev` after pulling, because PR #20 adds an indexes
  migration.
- Docker and configuration: one documented `.env` setup and a fresh-clone check, still not done.
- Register and reset-password pages could reuse the shared password rules component.
