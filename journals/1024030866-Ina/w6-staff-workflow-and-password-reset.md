# Week 6: Staff Collection, Missing Files, and Hardening Password Reset

Ina Sharma
Roll No: 1024030866
26 October – 1 November 2026

## 1 Context

After the backend safety work of Week 5, this week was about the parts a user actually sees:
the staff workflow, what happens when a file has gone missing, and the forgot-password flow.
Two pull requests were merged, #14 and #15.

## 2 Staff and Student Workflow (PR #14)

**Collection.** The staff order page now has "Mark as Collected" for `READY` orders, shown only
to the `SHOP_STAFF` role. It uses the existing collect endpoint, then re-reads the order, so a
double click or a colleague collecting first shows the real state. The button shows a loading
state and ignores a second click while the request is running.

**Resume payment.** An unpaid order now shows "Pay now", or "Retry payment" after a failure,
and it reopens the payment screen for the **same** order. No new order is created, so the
idempotency key is not involved. This also fixed a real bug: if a user left between "initiate"
and "confirm", the server answered 409 ("payment already in progress"), and the app showed
"Payment failed" on every retry. The app now treats that 409 as "carry on and confirm".

**"Next up" card.** The staff dashboard shows the next order's documents with View and
Download, instead of a bare list of names.

**Orders with missing files.** An order could be created for a document whose stored file no
longer existed, leaving staff with something they cannot print. Order creation now checks every
file inside the order transaction:

- 409 if one or more files are missing, naming them;
- 503 if the storage itself could not be checked (so "your file is gone" is never confused with
  "storage is unhealthy");
- 404 stays the answer for documents that belong to someone else.

Any failure aborts the transaction, so no half-created order remains, and a rejected request
does not use up its idempotency key.

**Errors that were being hidden.** The payment and refund lookups return 404 when there is
simply none yet, and the pages used `.catch(() => null)` for everything. That also hid real
server errors, and on the staff dashboard a failed lookup showed a false "Payment pending"
badge. Now a 404 means "none yet", and every other failure shows an error or an unknown state.

## 3 Password Reset Hardening (PR #15)

The forgot/reset flow was already reasonable: one generic reply, a hashed token that works once
and expires in an hour. Testing it still found three real gaps.

1. **Timing leak.** The email was sent *before* replying, so an existing account took as long as
   the mail provider while an unknown address answered instantly. That difference reveals which
   emails have accounts. The email is now handed off without waiting, and a delivery failure is
   only logged.
2. **Deactivated accounts.** A reset link issued while the account was active could still work
   after an admin deactivated it. It is now rejected like any other bad link. Recovery only
   ever writes the password, so it can never reactivate an account or change a role.
3. **Production link.** The link comes from `FRONTEND_URL`, which defaults to localhost. A
   production deployment that forgot to set it would email links that cannot work. Production
   now refuses to start unless it is an `https` address that is not localhost.

I also added a configurable email provider (`smtp`, `console` or `mock`) chosen in one place,
like the payment provider. Tests always use the in-memory mock, so a test run can never send a
real email, and the mock is refused in production.

**Rate-limit messages.** When a user hits the limit (HTTP 429) the pages said "Something went
wrong", which is misleading because retrying immediately fails again. They now show the
server's message. On the reset page a 429 is explicitly **not** a bad link: the form and the
valid token stay, and the user can try again later.

## 4 Outcome

- Staff can mark orders collected, and students can finish a payment they left half-way.
- Orders for missing files are rejected cleanly, and real errors are no longer hidden.
- Password reset no longer leaks which emails exist, and respects deactivation.
- PRs #14 and #15 merged.

## 5 Follow-ups

- Admin user management page, pickup code, and the ready-for-collection email are still ahead.
- Known limitation: after a password reset, old tokens stayed valid. Harbani's session work
  (#17, #18) now rejects tokens issued before a password change, so this should be rechecked.
- Close PR #9, and add the production guard to the development seed.
