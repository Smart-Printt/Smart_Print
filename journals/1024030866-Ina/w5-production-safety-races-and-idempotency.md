# Week 5: Production Safety, Race Conditions, and Making Order Creation Safe to Retry

Ina Sharma
Roll No: 1024030866
19–25 October 2026

## 1 Context

This was my security and correctness week. Four pull requests (#10 to #13) went into `main`,
and all of them answer the same question: what happens when something goes wrong at the worst
moment? A test run points at the wrong database, a user clicks twice, two staff members act on
the same order, or the network drops after an order was already saved.

## 2 Guard Rails Before Features (PRs #10 and #11)

**Test database guard.** The backend tests create and delete data, and until now they ran
against whatever `DATABASE_URL` the developer's `.env` pointed at. One wrong `.env` could wipe
a real database. Tests now run through a wrapper script that loads a separate `.env.test` and
refuses to start unless the database name looks like a test database. An example file
(`.env.test.example`) documents the setup.

**Production safeguards.** The app used to call `cors()` with no restrictions and had no limit
on login attempts. I added:

- `helmet` security headers (including `nosniff`), with `X-Powered-By` removed.
- A CORS allow-list instead of "allow every origin".
- Rate limits for login (5 per minute), registration, forgot-password (3 per 15 minutes),
  reset-password and document upload. Login and password-reset limits count per IP plus email, and
  upload counts per user, so one noisy attacker cannot lock everyone else out.
- A startup check that refuses to run in production with an unsafe setting. The payment
  provider is also chosen in one place, and the mock provider is refused in production.
- A production Dockerfile and `SECURITY_CONFIGURATION.md`, which lists every setting.

**Because** a default that is safe only when nothing goes wrong is not safe. A guard should
stop the mistake, not rely on people remembering.

## 3 Race Conditions in the Order Flow (PR #12)

Two requests that touch the same order at the same instant can leave inconsistent data. For
example, a cancelled order could still end up printing, or a cancelled order could be queued.

My fix has two parts:

1. Every order-changing transaction takes its database locks in **one fixed order** (shop, then
   order, then queue entry). A fixed order is what prevents two transactions from waiting for
   each other forever (a deadlock).
2. Status changes go through a table of **legal transitions** and are re-checked after the lock
   is taken. "Cancel" and "start printing" can no longer both succeed on the same order.

I also changed the queue to use `queueNumber`, allocated under the shop lock, as the FIFO
order. The old millisecond `enteredAt` timestamp can tie or be skewed, so it is now kept only
for display. Two more race fixes: deleting a document and ordering with it at the same time
(the file is now removed only after the database commit), and PDF downloads, which could leak
file handles when a client disconnected halfway. The tests for all of these are deterministic,
so they force the unlucky timing instead of hoping to hit it.

## 4 The Database Should Refuse Bad Data (PR #13)

Code can have bugs, but a database constraint cannot be forgotten. I moved the important rules
into PostgreSQL itself:

- A queue entry's shop must match its order's shop (composite foreign key).
- Queue numbers are unique per shop, and at most one entry per shop can be `PRINTING` (a
  partial unique index).
- At most one successful payment per order, and one active refund per payment.
- No negative money, no zero copies, and status fields must agree with their timestamps.

Prisma's schema file cannot express partial indexes and CHECK constraints, so they live only in
the migration SQL. Each migration starts with a check that aborts and names the broken rule if
existing rows would violate the new constraint, and nothing is deleted silently.

**Idempotency.** If the network drops after the server saved an order, the user presses "Place
order" again and gets a duplicate. `POST /api/orders` now accepts an optional `Idempotency-Key`
header. The key and a hash of the request are stored with the order, unique per user. Same key
and same request returns the original order (marked `Idempotent-Replayed: true`). Same key with
a different request returns 409. Two simultaneous duplicates insert exactly once. The frontend
creates one key per distinct order and reuses it on retry.

## 5 Outcome

- Tests can no longer touch a real database.
- Rate limits, security headers, a CORS allow-list and production startup checks are in place.
- The order lifecycle, queue and payments are protected by locks in code and by constraints in
  the database. Retrying an order is now safe.
- PRs #10 to #13 merged.

## 6 Follow-ups

- PR #9 (`fix/database-integrity-constraints`) is an older version of the same idea and is
  superseded by #13, so I should close it.
- Add a production guard to the development seed (still open from Week 4).
- Account sessions are still stateless JWTs. Harbani is working on revocable sessions.
