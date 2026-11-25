# SmartPrint

Multi-shop college printing management system. Students upload documents, pick
a shop and print options, pay, and get a queue token; shop staff process a
strict FIFO printing queue; admins manage shops and users.

## Stack

- **Frontend**: React + Vite + TypeScript
- **Backend**: Node.js + Express + TypeScript
- **Database**: PostgreSQL, via **Prisma** ORM
- **Auth**: JWT + bcrypt password hashing
- **File storage**: local-disk storage abstraction (`backend/src/services/storage/`) — swappable for object storage later
- **Payments**: mock payment provider abstraction (`backend/src/services/payments/`) — swappable for a real gateway later

## Project layout

```
code/
  backend/                  Express API, Prisma schema/migrations, seed script, Jest tests
  frontend/                 React + Vite student/staff/admin UI, Vitest tests
  docker-compose.yml        development stack (hot reload)
  docker-compose.prod.yml   production-style stack (compiled backend, nginx frontend)
  .env.production.example   template for the production stack's settings
```

The backend is layered as `src/routes/*.routes.ts` (URLs, auth and role
middleware) → `src/controllers/*.controller.ts` (input validation, response
shape) → `src/services/*.service.ts` (business logic and Prisma calls).

## Ports

| What | Local / dev Docker | Production stack |
|---|---|---|
| Backend API | 4321 (the `PORT` default; in dev Docker the host's 4321 maps to the container's 4000) | 4000 (inside Docker only) |
| Frontend | 5173 (Vite) | 8080 → nginx on 80 (`FRONTEND_PORT`) |
| PostgreSQL | 5432 native, 5433 for the dev Docker db | inside Docker only |
| Test database | `smartprint_test` (see `backend/.env.test.example`) | — |

## Running with Docker (recommended)

```bash
cd code
docker compose up -d db
docker compose run --rm backend npx prisma migrate deploy
docker compose run --rm backend npm run prisma:seed
docker compose up -d
```

- Backend: http://localhost:4321 (health check at `/health`)
- Frontend: http://localhost:5173

Seed data creates:
- `admin@smartprint.dev` (admin), `staff@smartprint.dev` (shop staff), `faculty@smartprint.dev`, `student1@smartprint.dev`
- All share the password `DevPassword123!` (see `backend/prisma/seed.ts`).

No `.env` file is needed for Docker: a fresh clone runs with the defaults in
`docker-compose.yml`. To change settings, copy `backend/.env.example` to `backend/.env`.

## Running locally without Docker

Requires Node.js 20+ and a running PostgreSQL instance.

```bash
cd backend
cp .env.example .env   # edit DATABASE_URL if needed
npm install
npm run prisma:migrate
npm run prisma:seed
npm run dev

cd ../frontend
cp .env.example .env
npm install
npm run dev
```

## Production stack

`docker-compose.prod.yml` builds `backend/Dockerfile.prod` (compiled
TypeScript, non-root user) and `frontend/Dockerfile.prod` (static build served
by nginx, which also forwards `/api` to the backend).

```bash
cd code
cp .env.production.example .env.production   # fill in real values
docker compose -f docker-compose.prod.yml --env-file .env.production up -d db
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm migrate
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

The backend refuses to start in production with unsafe settings — including
the mock payment provider — so this stack only comes up once a real payment
provider is integrated. See `backend/SECURITY_CONFIGURATION.md`.

## Key design notes

- **FIFO** queue: entries are served in `queueNumber` order per shop, with the
  shop row locked while numbers are allocated (`backend/src/services/queue.service.ts`).
- Order and payment state changes go through the allowed transitions in
  `backend/src/config/orderTransitions.ts`, under row locks
  (`backend/src/services/orderLocks.ts`).
- `POST /api/orders` is idempotent with an `Idempotency-Key` header.
- A queue entry is only created after a payment succeeds, inside the same
  transaction that moves the order to `QUEUED`.
- Authorization never trusts a `shopId`/`userId` from the client — shop staff
  access comes from the verified user record.
- **order_code** (e.g. `SP-LXK3F9-A1B2`) is a random, human-readable display
  identifier (time + random part, `utils/orderCode.ts`); it is unique in the
  database but never used for ordering. **queue_number** (the token students
  see) is `MAX(queue_number) + 1` per shop, computed while the shop's row is
  locked (`SELECT ... FOR UPDATE` on `print_shops`), so two orders paid at the
  same moment for the same shop can't get the same token.
- Pricing/finishing rules use an effective-dated "supersede" pattern: creating
  a new rule for a given combination closes out any currently-open rule in the
  same transaction, so there is never more than one active rule per
  combination.
- **Live queue updates**: students' order pages receive Server-Sent Events
  (`GET /api/orders/:orderId/queue/stream`) when their shop's queue changes,
  with a polling fallback. The notification bus is in-process
  (`services/queueEvents.ts`); running several API instances would need
  PostgreSQL `LISTEN/NOTIFY` or Redis instead.
- **AI wait-time prediction** (`services/waitModel.ts`): Bayesian linear
  regression that learns each shop's real printer speed (set-up time per job,
  minutes per B&W page, per colour page, per binding) from its completed
  orders. A student's wait is the sum of the predicted times of the orders
  ahead plus what is left of the one printing, returned with an 80% range and
  the number of orders it has learned from. It starts from typical speeds with
  a wide uncertainty, so it works with no history and sharpens as the shop
  completes orders. It only informs students: queue order stays strictly FIFO.
  Trained models are cached per shop for 60 s and re-learned when a print
  completes.
  **Safeguards:** if the order printing now runs far past its own predicted
  range (a jam) the student sees "Taking longer than usual", and if orders wait
  with nothing printing for 15 minutes they see "Waiting for the shop to start"
  - in both cases no number is shown, because the model assumes a shop working
  normally. Set `WAIT_ESTIMATES_ENABLED=false` in the backend `.env` to switch
  estimates off everywhere.
- **QR pickup**: a READY order shows a QR code that encodes its order code.
  Staff look it up with `GET /api/orders/by-code/:orderCode` (scoped to their
  own shop) and confirm the handover from the dashboard's Pickup desk.
- **Admin analytics** (`GET /api/admin/analytics?days=7|30|90`, ADMIN only):
  orders, revenue net of refunds, busiest hours, per-shop load and median
  wait/print times, computed in SQL in the Asia/Kolkata timezone.
