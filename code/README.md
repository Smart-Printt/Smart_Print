# SmartPrint

Multi-shop college printing management system. Students upload documents, pick
a shop and print options, pay, and get a queue token; shop staff process a
strict FIFO printing queue; admins manage shops and users.

## Stack

- **Frontend**: React + Vite + TypeScript
- **Backend**: Node.js + Express + TypeScript
- **Database**: PostgreSQL, via **Prisma** ORM
- **Auth**: JWT + bcrypt password hashing
- **File storage**: local-disk storage abstraction (`src/lib/storage.ts`) — swappable for object storage later
- **Payments**: mock payment provider abstraction (`src/lib/payment.ts`) — swappable for a real gateway later

## Project layout

```
code/
  backend/     Express API, Prisma schema/migrations, seed script
  frontend/    React + Vite student/staff/admin UI
  docker-compose.yml
```

Backend modules (`backend/src/modules/*`) each contain `*.routes.ts`,
`*.controller.ts`, and `*.service.ts` — routes wire up middleware/authorization,
controllers validate input and shape responses, services hold the business
logic and Prisma calls.

## Running with Docker (recommended)

```bash
cd code
docker compose up -d db
docker compose run --rm backend npx prisma migrate deploy
docker compose run --rm backend npm run prisma:seed
docker compose up -d
```

- Backend: http://localhost:4000 (health check at `/health`)
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

## Key design notes

- **order_code** (e.g. `A101`) and **queue_number** (the human-readable token)
  are generated from native PostgreSQL sequences (`src/lib/sequences.ts`), not
  `MAX()+1`, so they stay correct under concurrent order/payment creation.
- **FIFO** queue processing (`POST /api/queue/start-next`) uses
  `SELECT ... FOR UPDATE SKIP LOCKED` ordered by `queue.entered_at`, so two
  staff members hitting "start next" at once each safely claim a different
  order.
- Pricing/finishing rules use an effective-dated "supersede" pattern: creating
  a new rule for a given combination closes out any currently-open rule in the
  same transaction, so there is never more than one active rule per
  combination.
- A queue entry is only ever created after a payment succeeds, inside the same
  transaction that advances the order to `QUEUED` (see
  `modules/payments/payments.service.ts`).
- Authorization never trusts a `shop_id`/`user_id` from the client — shop
  staff access is always derived from `req.user.shopId` on the verified JWT
  (see `middleware/shopAccess.ts`).
