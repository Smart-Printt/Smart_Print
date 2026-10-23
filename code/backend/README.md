# SmartPrint Backend — Phase 1

Backend foundation and database for SmartPrint, an intelligent college printing
order management system. This phase sets up the project skeleton, the
PostgreSQL schema (via Prisma), and a minimal Express server with a health
check. No business APIs, auth, payments, or queue logic are implemented yet.

## Stack

- Node.js + TypeScript + Express
- PostgreSQL + Prisma ORM

## Prerequisites

- Node.js and npm installed
- PostgreSQL running locally, with a database named `smartprint`

## Setup

```bash
cd backend
npm install
cp .env.example .env   # then edit DATABASE_URL with real credentials
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev
```

Verify the server is up:

```bash
curl http://localhost:4000/health
```

> npm 11+ blocks dependency install scripts by default. Prisma needs its
> postinstall/preinstall scripts to download engine binaries, so after
> `npm install` you may need to run `npm install-scripts approve @prisma/client @prisma/engines prisma`
> followed by `npm rebuild` before `prisma generate`/`migrate` will work.
> This project's `package.json` already records the approval (`allowScripts`).

## Environment variables

See `.env.example`:

- `DATABASE_URL` — PostgreSQL connection string
- `PORT` — server port (default 4000)
- `NODE_ENV` — `development` / `production`

## Project structure

```
backend/
├── src/
│   ├── config/       # env loading, shared Prisma client
│   ├── controllers/  # request handlers
│   ├── middleware/   # error handling, 404 handler
│   ├── routes/       # route definitions
│   ├── services/     # business logic (empty in this phase)
│   ├── utils/        # shared helpers (empty in this phase)
│   ├── types/        # shared TypeScript types (empty in this phase)
│   ├── app.ts         # Express app assembly
│   └── server.ts      # entrypoint, DB connect + listen
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
└── tests/
```

## Notes for later phases

- The printing queue is strictly FIFO, ordered by `Queue.queueNumber` (then
  `queueId` as a last-resort tie-break). `queueNumber` is allocated as
  `max + 1` per shop while the shop row is locked, so it is exactly the order
  in which entries were serialized; `enteredAt` is a display/audit timestamp
  only (it can tie or step backwards). No priority scoring exists in this
  schema.
- `OrderDocument.pricePerPage`, `finishingPrice`, and `lineTotal` are
  historical snapshots taken at order-placement time; they must not be
  recomputed from the current `ShopPricingRule` / `ShopFinishingRule` rows.
- "Only one `SUCCESS` payment per order" (and the other rules listed under
  *Database constraints Prisma cannot express* below) is enforced by the
  database as well as by the payment service.

## Database constraints Prisma cannot express

`schema.prisma` has no syntax for PostgreSQL partial unique indexes or `CHECK`
constraints, so these exist **only in the migration SQL**. Prisma does not
report them as drift (`prisma migrate diff` stays empty), but nothing other
than replaying the migrations recreates them - never rebuild the schema from
`schema.prisma` alone (`prisma db push`).

Migrations: `20261022000000_queue_integrity`,
`20261022000100_payment_order_integrity`, `20261022000200_order_idempotency`.

Expressed in `schema.prisma` (Prisma-native):

| Rule | Mechanism |
|---|---|
| A queue entry's shop is its order's shop | `Queue.shopId` (backfilled from the order) + composite FK `(order_id, shop_id) -> orders(order_id, shop_id)`, `ON UPDATE RESTRICT` |
| Unique queue number within a shop | `@@unique([shopId, queueNumber])` |
| One queue entry per order | `Queue.orderId @unique` |
| One order per (user, Idempotency-Key) | `@@unique([userId, idempotencyKey])` (NULL keys never collide) |

`Order @@unique([orderId, shopId])` and `Queue @@unique([orderId, shopId])` are
logically redundant with the primary key / `orderId @unique`; PostgreSQL needs
the first as the target of the composite FK, and Prisma needs the second to
accept a composite one-to-one relation.

Migration-only (not in `schema.prisma`):

| Name | Rule |
|---|---|
| `queue_one_printing_per_shop` | `UNIQUE (shop_id) WHERE queue_status = 'PRINTING'` - at most one PRINTING entry per shop |
| `payments_one_pending_per_order` | `UNIQUE (order_id) WHERE payment_status = 'PENDING'` |
| `payments_one_success_per_order` | `UNIQUE (order_id) WHERE payment_status = 'SUCCESS'` |
| `refunds_one_active_per_payment` | `UNIQUE (payment_id) WHERE refund_status IN ('REQUESTED','PROCESSED')` (a FAILED refund can be retried) |
| `queue_number_positive` | `queue_number >= 1` |
| `queue_status_timestamps_consistent` | WAITING has no timestamps; PRINTING has `started_at`; COMPLETED has `started_at` + `completed_at`; CANCELLED has `cancelled_at` |
| `orders_total_amount_non_negative`, `order_documents_*`, `payments_amount_non_negative`, `refunds_amount_non_negative`, `shop_*_rules_price_non_negative` | money `>= 0`; `copies` and `print_page_count` `>= 1` |
| `orders_cancelled_at_matches_status` | `cancelled_at` is set exactly when the order is CANCELLED |
| `payments_paid_at_matches_status` | `paid_at` is set exactly when the payment is SUCCESS |
| `refunds_processed_at_matches_status` | `processed_at` is set exactly when the refund has left REQUESTED |
| `shop_*_rules_effective_range` | `effective_to IS NULL OR effective_to >= effective_from` (equal is legal: it closes a rule at its start) |
| `orders_idempotency_*` | key and request hash exist together; key is 8-128 chars of `[A-Za-z0-9._~:-]`; hash is a SHA-256 hex digest |

Deliberately **not** enforced by a constraint (it would need a trigger):
`orders.total_amount = SUM(order_documents.line_total)` and
`payments.amount = orders.total_amount`. Both are written once, in one
transaction, from the same computed values.

### Applying these migrations to existing data

Each migration starts with a preflight that **aborts the whole migration**
(it runs in one transaction, so nothing is half-applied) and names the rule
if existing rows would violate it. Nothing is ever deleted or rewritten
silently. The checks were run against the development and test databases
before these migrations were written: no violations, and queue rows backfill
their `shop_id` from their order. If a deployment database does fail the
preflight:

1. Fix the reported rows by hand (e.g. complete or cancel the extra PRINTING
   entry; renumber a duplicated queue number).
2. `npx prisma migrate resolve --rolled-back <migration_name>`, then
   `npx prisma migrate deploy` again.

## Order idempotency (`Idempotency-Key`)

`POST /api/orders` accepts an optional `Idempotency-Key` header (8-128
characters from `A-Z a-z 0-9 . _ ~ : -`; a UUID is ideal). Generate one key
per "place order" attempt and reuse it for every retry of that attempt.

| Situation | Result |
|---|---|
| No header | Behaves as before: every call creates an order |
| New key | Order created (201); the key and a SHA-256 of the request are stored on the order in the same transaction |
| Same key, same request | `201` with the **existing** order and `Idempotent-Replayed: true`; nothing new is written |
| Same key, different (normalized) request | `409`; nothing is written |
| Same key, simultaneous requests | Exactly one creates the order; the others wait on the unique index and get the replay |
| Malformed header | `400` |
| Request rejected (validation, 4xx) | The key is **not** consumed; the client may retry with a corrected body |

Notes: keys are scoped to the authenticated user, are kept for the life of
the order (no expiry), and a replay returns the order in its *current* state
(it may since have been paid, cancelled, or queued). The request hash covers
the shop and each item's document, copies, print type, paper size, sides,
page range, finishing rule and special instructions, in order, normalized the
way the server reads them: JSON property order does not matter, and absent /
`null` / empty / whitespace-only optional fields and surrounding whitespace
are all equivalent. Prices are never request fields (they are resolved from
the database), so a retry after a price change still replays the original
order. Free faculty orders behave identically (one order, one
queue entry). The frontend generates the key in `PrintFlowPage` and reuses it
while the order content is unchanged, including when the user goes back from
the payment step and places the same order again.

Payment initiation is not keyed: a second "Pay" is already refused (`409`)
while a payment is pending, and a second success is impossible.
