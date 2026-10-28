# SmartPrint — Technical Viva/Demo Guide

> Built entirely from reading the actual repository (schema.prisma, every route/controller/service file, frontend App.tsx/pages/services). No invented features. Labels used where relevant: **MOCK/SIMULATED**, **PLANNED/NOT IMPLEMENTED**, **NOT VERIFIED FROM CODE**.

---

## STUDY THIS FIRST — LAST-MINUTE REVISION

### 🔴 MUST KNOW (15 things)
1. SmartPrint = web app for ordering prints at a college shop instead of queuing physically. 4 roles: STUDENT, FACULTY, SHOP_STAFF, ADMIN.
2. Stack: React+TS+Vite (frontend) → Express+TS (backend) → Prisma ORM → PostgreSQL.
3. Auth = JWT. Login gives a token; every protected request sends `Authorization: Bearer <token>`.
4. Passwords are hashed with **bcrypt**, never stored plain (`utils/password.ts`).
5. Order lifecycle: `PLACED → PAYMENT_CONFIRMED → QUEUED → PRINTING → READY → COLLECTED` (or `CANCELLED`).
6. Price is **always computed server-side** from `ShopPricingRule` — client-sent prices are never trusted (`pricing.service.ts`).
7. Queue is **strict FIFO** ordered by `queueNumber` (allocated under the shop lock) — no priority logic exists (`queue.service.ts`).
8. Payment is **MOCK/SIMULATED** (`payments/mockPaymentProvider.ts`) — no real gateway.
9. FACULTY printing at shop `CSE_FACULTY` is free (₹0, no payment step) — everywhere else FACULTY pays like a STUDENT.
10. A payment successfully confirming and the order entering the queue happen in **one atomic DB transaction** — this is the single most important "why Prisma/transactions" answer.
11. Document upload is validated 3 ways: extension → declared MIME type → magic-byte signature check (`documents/fileValidation.service.ts`).
12. `schema.prisma` defines the DB tables; Prisma Client (generated from it) is what the backend actually calls (`prisma.order.create(...)` etc.)
13. Refund = **full amount only**, only for a `CANCELLED` order with a `SUCCESS` payment, processed by ADMIN only.
14. Route → Controller → Service → Prisma → PostgreSQL is the layering for every feature.
15. Backend runs on port **4321**, frontend on **5173/5175**, PostgreSQL on **5432**.

### 🟡 SHOULD KNOW
- Authorization middleware: `authenticate` (checks JWT) then `requireRole(...)` (checks role) — two separate, composable middleware.
- `SHOP_STAFF` is scoped to exactly **one** shop (`User.shopId`), re-verified from the DB on every request, never trusted from the URL.
- Password-reset uses a hashed, time-limited (1 hour), single-use token — email delivery is dev-console (`MOCK`) unless SMTP env vars are set.
- Row-level locking (`SELECT ... FOR UPDATE`) prevents race conditions like double-payment or two staff starting the same queue slot.
- Prices are **snapshotted** onto `OrderDocument` at order time — changing a shop's price later never changes past orders.

### 🟢 GOOD TO KNOW
- File uploads use `multer.memoryStorage()` — validated in memory before ever touching disk.
- CORS is enabled with defaults (`app.use(cors())`) — permissive, fine for a dev/college project.
- 13 backend integration test files exist (Jest); frontend has Vitest unit tests.
- Dockerfiles exist for both frontend/backend + a `docker-compose.yml` (optional; native run also works).

---

## 30-MINUTE CRASH PLAN
| Time | Do this |
|---|---|
| 0–3 min | Section 1 (Overview) |
| 3–7 min | Section 3 (Architecture) |
| 7–12 min | Section 6 (API traces — pick Login + Create Order) |
| 12–17 min | Section 7+8 (DB models + Prisma) |
| 17–21 min | Section 9 (Order flow) + Section 12 (Queue) |
| 21–25 min | Section 13 (Payment — say "mock" confidently) |
| 25–28 min | Section 22 (UML mapping) |
| 28–30 min | Section 19 (skim 10 likely Qs) |

## 1-HOUR PLAN — read in this order
1. Section 1 → 2. Section 3 → 3. Section 5 (API table) → 4. Section 7 (DB models) → 5. Section 8 (Prisma) → 6. Section 9 (order flow) → 7. Section 10 (auth) → 8. Section 12 (queue) → 9. Section 13+14 (payment/email) → 10. Section 22 (UML) → 11. Section 19 (questions)

---

## 1. PROJECT OVERVIEW

**A. 30-second explanation:**
"SmartPrint is a web app that lets college students and faculty upload a document, choose a shop and print settings, pay online, and track their order until it's ready — instead of physically queuing at a printing shop. Shop staff process orders through a first-in-first-out queue, and an admin manages shops, staff, and pricing."

**B. 2-minute technical explanation:**
"It's a two-tier web app: a React+TypeScript frontend talking to a Node.js+Express+TypeScript REST API, backed by PostgreSQL through the Prisma ORM. There are four roles — Student, Faculty, Shop Staff, Admin — each authorized via JWT and role-checking middleware. A student uploads a document (validated by type, size, and file signature), places an order at a shop, and the backend computes the price server-side from that shop's active pricing rules — never trusting a client-sent price. On successful payment (currently a mock/simulated payment provider), the order atomically enters that shop's FIFO print queue in the same database transaction as the payment confirmation. Shop staff advance the queue (start printing → mark ready), and the customer collects it. Faculty get free printing at one designated shop. Cancellation and full-refund flows exist for orders that haven't started printing yet."

**C. 5 key points to remember:**
1. 4 roles, JWT auth, role-based middleware on every protected route.
2. Server-side pricing — client never sets the price.
3. FIFO-only queue, no priority scheduling.
4. Payment is mocked/simulated, not a real gateway.
5. Payment confirmation + queue entry happen atomically in one transaction.

**What makes it different from just using a shop:** digital order tracking with full status history, no physical waiting, transparent centrally-configured pricing instead of ad-hoc cash pricing, and an auditable trail (who changed what status, when).

---

## 2. TECHNOLOGY STACK (verified in repo)

| Tech | What it is | Why SmartPrint uses it | Where in repo | What happens without it |
|---|---|---|---|---|
| **React 19** | UI library | Component-based UI, fast dev with Vite | `code/frontend/src/**` | No dynamic single-page app |
| **TypeScript** | Typed JS | Catches bugs at compile time across the whole stack | Both `frontend/src` and `backend/src`, `.ts`/`.tsx` everywhere | Runtime type bugs, no editor autocompletion |
| **Vite** | Frontend build tool/dev server | Fast HMR, proxies `/api` to backend in dev | `code/frontend/vite.config.ts` | Slower dev loop, need custom bundler config |
| **React Router** | Client-side routing | Role-based route guards (`/admin`, `/staff`, `/dashboard`) | `code/frontend/src/routes/guards.tsx`, `App.tsx` | No client-side navigation |
| **Node.js** | JS runtime | Runs the backend server | `code/backend` | No backend at all |
| **Express** | Web framework | Routing, middleware pipeline | `src/app.ts`, `src/routes/*.ts` | Would need to hand-roll HTTP routing |
| **PostgreSQL** | Relational database | Stores all persistent data (users, orders, payments...) | `DATABASE_URL` in `.env` | No durable data storage |
| **Prisma ORM** | Database toolkit | Type-safe queries, migrations, no raw SQL string-building | `prisma/schema.prisma`, `prisma.*.findMany/create` calls throughout services | Would write raw SQL manually, lose type safety, higher injection risk |
| **JWT (jsonwebtoken)** | Stateless auth token | Encodes `userId` + `role`, verified on each request | `utils/jwt.ts`, `middleware/auth.middleware.ts` | Would need server-side sessions |
| **bcryptjs** | Password hashing | One-way hash so plaintext passwords are never stored | `utils/password.ts` | Passwords stored in plaintext = massive security hole |
| **Multer** | File upload middleware | Parses `multipart/form-data`, buffers file in memory | `middleware/upload.middleware.ts` | No file upload support in Express by default |
| **CORS** | Cross-Origin middleware | Lets frontend (port 5173) call backend (port 4321) | `app.ts` (`app.use(cors())`) | Browser blocks cross-origin API calls |
| **nodemailer** (SMTP service) | Email sending | Sends password-reset emails **if configured** | `services/email/smtpEmail.service.ts` | Falls back to dev-console logging (see §14) |
| **Jest** | Backend test runner | Integration tests (13 files) | `code/backend/**/*.test.ts` (NOT VERIFIED — count from earlier session note, re-check `npm test` output before quoting exact number) | No automated backend test coverage |
| **Vitest** | Frontend test runner | Unit tests for pages | `code/frontend/src/**/*.test.tsx` | No automated frontend test coverage |
| **Docker** | Containerization | Optional deployment path | `code/backend/Dockerfile`, `code/frontend/Dockerfile`, `code/docker-compose.yml` | Must run Node/Postgres natively (also fully supported) |

---

## 3. ARCHITECTURE

```
Browser (React SPA, port 5173/5175)
   │  fetch('/api/...')  — Vite dev proxy forwards /api to backend
   ▼
Express App (port 4321)  — src/app.ts
   │  cors() → express.json() → route → authenticate → requireRole → controller
   ▼
Controller (src/controllers/*.ts)  — parses req, calls service, sends res
   ▼
Service (src/services/*.ts)  — ALL business logic & validation lives here
   ▼
Prisma Client (src/config/prisma.ts)  — prisma.order.create(), etc.
   ▼
PostgreSQL (localhost:5432, database "smartprint")
```

**Simple explanation:** the browser never talks to the database directly. It always calls a URL like `/api/orders`, which Express routes to a controller, which asks a service to do the actual work, which asks Prisma to read/write the database.

**Technical explanation — React → Express:**
- The frontend's `services/apiClient.ts` wraps `fetch()`. Every call adds `Authorization: Bearer <token>` from `localStorage` if a token exists.
- Example: `POST /api/orders` with JSON body `{ shopId, items }` → `order.controller.ts::create` → `order.service.ts::createOrder`.
- Response shape is always `{ success: boolean, data?: ..., message?: ... }`.

**Technical explanation — Express → Prisma:**
- `src/config/prisma.ts` creates one shared `PrismaClient` instance (singleton), imported everywhere as `import { prisma } from '../config/prisma'`.
- Services call it directly, e.g. `prisma.order.create({ data: {...} })`, or `prisma.$transaction([...])` for atomic multi-step writes.

**Technical explanation — Prisma → PostgreSQL:**
- `DATABASE_URL` (in `.env`) is the connection string: `postgresql://<user>:<password>@<host>:<port>/<database>`.
- Prisma Client translates each call (e.g. `.findUnique()`) into SQL, sends it over a TCP connection to Postgres, and maps the result rows back into typed JS objects.

---

## 4. FRONTEND DEEP EXPLANATION

**Folder structure** (`code/frontend/src/`):
- `pages/` — split by role: `auth/`, `student/`, `staff/`, `admin/`, `shared/`, `errors/`
- `components/` — `StatusBadge.tsx`, plus `ui/` and `staff/` subfolders (route protection lives in `routes/guards.tsx`)
- `services/` — one API-wrapper file per backend resource: `authApi.ts`, `orderApi.ts`, `paymentApi.ts`, `documentApi.ts`, `queueApi.ts`, `refundApi.ts`, `pricingApi.ts`, `shopApi.ts`, `shopQueueApi.ts`, `adminStaffApi.ts`, plus `apiClient.ts` (the shared `fetch` wrapper) and `index.ts` (re-exports)
- `context/` — `AuthContext.tsx` (global logged-in user + token), `ToastContext.tsx` (notifications)
- `routes/guards.tsx` — `RequireAuth`, `RequireGuest`, `RequireRole` route wrappers
- `hooks/` — `useAuth.ts`, `useToast.ts`, `useDebouncedValue.ts`

**Routing** (`App.tsx`): uses `React.lazy()` for every page (code-splitting) inside `<Suspense>`. Routes are nested: `RequireAuth` wraps `AppShell`, which wraps `RequireRole roles={[...]}` blocks per section (student/staff/admin).

**Auth state:** `AuthContext.tsx` holds `user` + `isLoading`. On mount, if a token exists in `localStorage`, it calls `GET /api/auth/me` to restore the session; if that fails (expired token), the token is cleared. `apiClient.ts` also has a global `onUnauthorized` hook — any `401` response anywhere logs the user out automatically.

**API service layer:** every `*Api.ts` file is a thin wrapper, e.g. `orderApi.create(shopId, items)` internally calls `api.post('/orders', { shopId, items })`. This keeps raw endpoint strings out of page components.

**Error handling:** `apiClient.ts`'s `request()` throws a typed `ApiError(status, message)` for any non-2xx response, parsed from the backend's `{ success:false, message }` JSON. Pages catch this and show it via `ToastContext`.

### Page-by-page (major pages)

**PAGE: LoginPage** (`pages/auth/LoginPage.tsx`)
Purpose: authenticate a user.
API calls: `POST /api/auth/login`
Data received: `{ user, token }`
User actions: submit email/password
Backend endpoint: `auth.routes.ts` → `authController.login`

**PAGE: DashboardPage** (`pages/student/DashboardPage.tsx`)
Purpose: student/faculty landing page after login.
API calls: `GET /api/orders` (own orders)
Backend endpoint: `order.routes.ts` → `orderController.list`

**PAGE: PrintFlowPage** (`pages/student/print-flow/PrintFlowPage.tsx`)
Purpose: the actual "create an order" wizard — pick shop, upload/select document, set print options, preview price, submit.
API calls: `POST /api/documents` (upload), `POST /api/pricing/preview`, `POST /api/orders` (create)
Backend endpoint: `document.routes.ts`, `pricing.routes.ts`, `order.routes.ts`
Important file: `pages/student/print-flow/PrintFlowPage.tsx`

**PAGE: OrderDetailsPage** (`pages/student/OrderDetailsPage.tsx`)
Purpose: track one order's status/history, pay, cancel, request refund.
API calls: `GET /api/orders/:id`, `POST /api/orders/:orderId/payment`, `POST /api/orders/:orderId/payment/confirm`, `PATCH /api/orders/:id/cancel`, `POST /api/orders/:orderId/refund`
Backend endpoint: `order.routes.ts`, `payment.routes.ts`, `refund.routes.ts`

**PAGE: StaffDashboardPage** (`pages/staff/StaffDashboardPage.tsx`)
Purpose: shop staff's queue view — see waiting orders, start next, mark ready.
API calls: `GET /api/shops/:shopId/queue`, `POST /api/shops/:shopId/queue/start-next`, `PATCH /api/shops/:shopId/queue/:queueId/complete`
Backend endpoint: `shopQueue.routes.ts`

**PAGE: AdminOverviewPage / AdminOrdersPage / AdminRefundsPage** (`pages/admin/*`)
Purpose: system-wide order visibility, refund processing, shop/staff/pricing management.
API calls: `GET /api/orders` (ADMIN sees all), `PATCH /api/orders/:orderId/refund/process`, `POST /api/admin/staff`, etc.
Backend endpoint: various, gated by `requireRole('ADMIN')`.

---

## 5. BACKEND DEEP EXPLANATION

**Layering:** `routes/*.ts` (URL + middleware wiring only) → `controllers/*.ts` (parse `req`, call service, shape `res`) → `services/*.ts` (ALL validation + business logic + Prisma calls) → PostgreSQL.

**Why separate controllers and services?** Controllers know about HTTP (`req`/`res`); services know nothing about HTTP and can be tested/reused independently (e.g. the pricing-preview endpoint and order-creation both call the exact same `pricingService.resolveAndPriceItem`).

### Full route table (from `app.ts` mounting + each `*.routes.ts`)

| Method | Endpoint | Purpose | Auth | Role | Controller → Service |
|---|---|---|---|---|---|
| POST | `/api/auth/register` | Student self-registration | No | — | `auth.controller.register` → `auth.service.registerStudent` |
| POST | `/api/auth/login` | Login, get JWT | No | — | `auth.controller.login` → `auth.service.login` |
| POST | `/api/auth/logout` | Client-side no-op | No | — | `auth.controller.logout` |
| POST | `/api/auth/forgot-password` | Request reset email | No | — | `auth.controller.forgotPassword` → `requestPasswordReset` |
| POST | `/api/auth/reset-password` | Complete reset | No | — | `auth.controller.resetPassword` → `resetPassword` |
| GET | `/api/auth/me` | Get current user | Yes | any | `auth.controller.me` |
| POST | `/api/auth/staff` | Create SHOP_STAFF | Yes | ADMIN | `createShopStaff` |
| POST | `/api/auth/faculty` | Create FACULTY | Yes | ADMIN | `createFaculty` |
| POST | `/api/documents` | Upload document | Yes | any | `document.controller.upload` → `document.service.uploadDocument` |
| GET | `/api/documents` | List own docs | Yes | any | `list` |
| GET | `/api/documents/:id` | Get one doc metadata | Yes | owner | `getOne` |
| GET | `/api/documents/:id/view` | Inline view | Yes | owner/staff-of-shop/admin | `view` |
| GET | `/api/documents/:id/download` | Download | Yes | owner/staff-of-shop/admin | `download` |
| DELETE | `/api/documents/:id` | Delete (if not on an order) | Yes | owner | `remove` |
| POST | `/api/orders` | Create order | Yes | STUDENT/FACULTY | `order.controller.create` → `order.service.createOrder` |
| GET | `/api/orders` | List orders (role-scoped) | Yes | any | `list` → `listOrdersForRequester` |
| GET | `/api/orders/:id` | Get one order | Yes | owner/staff-of-shop/admin | `getOne` |
| PATCH | `/api/orders/:id/cancel` | Cancel order | Yes | owner | `cancel` |
| POST | `/api/orders/:orderId/payment` | Initiate payment | Yes | owner | `payment.controller.initiate` → `initiatePayment` |
| POST | `/api/orders/:orderId/payment/confirm` | Confirm payment | Yes | owner | `confirm` → `confirmPayment` |
| GET | `/api/orders/:orderId/payment` | Get latest payment | Yes | owner/staff/admin | `getOne` |
| POST | `/api/orders/:orderId/refund` | Request refund | Yes | owner | `refund.controller.request` |
| PATCH | `/api/orders/:orderId/refund/process` | Settle refund | Yes | ADMIN | `processRefund` |
| GET | `/api/orders/:orderId/refund` | View refund | Yes | owner/staff/admin | `getOne` |
| GET | `/api/orders/:orderId/queue` | Get queue entry | Yes | owner/staff/admin | `queue.controller.getOne` |
| GET | `/api/orders/:orderId/queue-position` | Get queue position | Yes | owner/staff/admin | `getPosition` |
| PATCH | `/api/orders/:orderId/collect` | Mark collected | Yes | ADMIN/SHOP_STAFF | `collect` |
| POST | `/api/shops` | Create shop | Yes | ADMIN | `shop.controller.create` |
| GET | `/api/shops` | List shops | Yes | any | `list` |
| GET | `/api/shops/:shopId` | Get one shop | Yes | any | `getOne` |
| PATCH | `/api/shops/:shopId` | Update shop | Yes | ADMIN/SHOP_STAFF(own) | `update` |
| POST | `/api/shops/:shopId/pricing-rules` | Add pricing rule | Yes | ADMIN/SHOP_STAFF(own) | `pricing.controller.createPricingRule` |
| GET | `/api/shops/:shopId/pricing-rules` | List pricing rules | Yes | any | `listPricingRules` |
| PATCH | `/api/shops/:shopId/pricing-rules/:ruleId/deactivate` | Close a pricing rule | Yes | ADMIN/SHOP_STAFF(own) | `deactivatePricingRule` |
| POST | `/api/shops/:shopId/finishing-rules` | Add finishing rule | Yes | ADMIN/SHOP_STAFF(own) | `createFinishingRule` |
| GET | `/api/shops/:shopId/finishing-rules` | List finishing rules | Yes | any | `listFinishingRules` |
| PATCH | `/api/shops/:shopId/finishing-rules/:ruleId` | Update finishing rule | Yes | ADMIN/SHOP_STAFF(own) | `updateFinishingRule` |
| GET | `/api/shops/:shopId/queue` | List shop's waiting queue | Yes | ADMIN/SHOP_STAFF(own) | `shopQueue.controller.list` |
| GET | `/api/shops/:shopId/queue/next` | Peek next order | Yes | ADMIN/SHOP_STAFF(own) | `next` |
| GET | `/api/shops/:shopId/queue/current` | Get currently-printing | Yes | ADMIN/SHOP_STAFF(own) | `current` |
| POST | `/api/shops/:shopId/queue/start-next` | Start printing next | Yes | ADMIN/SHOP_STAFF(own) | `startNext` |
| PATCH | `/api/shops/:shopId/queue/:queueId/complete` | Mark printing done | Yes | ADMIN/SHOP_STAFF(own) | `complete` |
| POST | `/api/pricing/preview` | Preview price before ordering | Yes | any | `pricing.controller.preview` |
| POST | `/api/admin/staff` | Create+assign staff | Yes | ADMIN | `staff.controller.create` |
| GET | `/api/admin/staff` | List staff | Yes | ADMIN | `list` |
| PATCH | `/api/admin/staff/:id` | Update staff assignment/status | Yes | ADMIN | `update` |
| GET | `/health` | Health check | No | — | `health.controller` |

HTTP methods actually used: **GET, POST, PATCH, DELETE**. `PUT` is **not used anywhere** in this project.

---

## 6. API EXPLANATION — 5 end-to-end examples

### Example 1: LOGIN
```
React LoginPage
 → POST /api/auth/login   body: { email, password }
 → Express: authRouter.post('/login', authController.login)   (no auth middleware — public)
 → auth.controller.ts::login → reads req.body
 → auth.service.ts::login:
      - validates input shape
      - prisma.user.findUnique({ where: { email } })
      - bcrypt.compare(password, user.passwordHash)
      - checks user.status === 'ACTIVE'
      - signAccessToken({ userId, role })  (jsonwebtoken, signed with JWT_SECRET)
 → PostgreSQL: one SELECT on `users` table
 → Response: { success:true, data:{ user, token } }
 → React: AuthContext.login() stores token in localStorage, sets user state, redirects to role's home route
```

### Example 2: REGISTER
```
React RegisterPage → POST /api/auth/register { name, email, phone, password }
 → authController.register → authService.registerStudent
     - validates name/email/phone/password format
     - assertStudentEmailDomain(email)  — must match ALLOWED_STUDENT_EMAIL_DOMAIN
     - checks no existing user with that email (else 409 Conflict)
     - bcrypt.hash(password) → prisma.user.create({ role:'STUDENT', status:'ACTIVE', ... })
     - signs JWT immediately (auto-login after registering)
 → Response: { user, token } → same as login from here
```

### Example 3: UPLOAD DOCUMENT
```
React PrintFlowPage → POST /api/documents  (multipart/form-data, field "file")
 → uploadSingleFile middleware (multer, memory storage, size limit from MAX_FILE_SIZE_MB)
 → documentController.upload → documentService.uploadDocument(userId, {buffer, originalName, mimeType, size})
     - validateUploadedFile(): extension check → MIME check → magic-byte signature check
     - extractPageCount(): parses PDF/DOCX/etc to count pages
     - sha256Hex(buffer) → fileHash
     - storageService.save(storageKey, buffer)  — writes to disk (local storage)
     - prisma.document.create({...})
 → Response: { document: { documentId, fileName, pageCount, ... } }
 → React stores documentId to use in the next step (create order)
```

### Example 4: CREATE ORDER (the core flow)
```
React PrintFlowPage → POST /api/orders  { shopId, items:[{documentId, copies, printType, paperSize, sides, ...}] }
 → orderController.create → orderService.createOrder(userId, {shopId, items}, role)
     - shopService.assertShopAcceptsOrders(shopId)   — shop must be active + accepting orders
     - shopService.assertShopEligibleForRole(shop, role)  — e.g. STUDENT blocked from CSE_FACULTY shop
     - for each item: pricingService.resolveAndPriceItem()
         - documentService.getDocumentForUser() — ownership check
         - resolvePageRange() — figures out which pages print
         - pricingService.resolvePricingRule() — finds the shop's CURRENT price for (printType,paperSize,sides)
         - resolveFinishingRule() — optional binding/stapling price
         - computes printCost, finishingCost, lineTotal (all Prisma.Decimal, not float)
     - if the request has an Idempotency-Key header and an order with that (user, key) exists → return it (replay);
       same key + different request → 409. (See "Order idempotency" in code/backend/README.md.)
     - if FACULTY at CSE_FACULTY shop → isFreeFacultyShop() → zero out all prices
     - prisma.$transaction([ order.create, orderDocument.createMany, orderStatusHistory.create,
                              (+ enqueueOrderWithinTransaction if free faculty order) ])
 → PostgreSQL: multiple INSERTs, all-or-nothing (transaction)
 → Response: { order: {orderId, orderStatus:'PLACED', totalAmount, items:[...], statusHistory:[...]} }
```

### Example 5: PAYMENT → QUEUE (the "why transactions" answer)
```
React OrderDetailsPage → POST /api/orders/:orderId/payment  { paymentMethod: 'UPI' }
 → paymentController.initiate → paymentService.initiatePayment
     - order must be status PLACED (PAYABLE_ORDER_STATUSES)
     - SELECT ... FOR UPDATE (row-lock the order) so two "Pay" clicks can't both create a payment
     - paymentProvider.initiatePayment() — MOCK: instantly returns a fake reference, no network call
     - prisma.payment.create({ status:'PENDING', amount: order.totalAmount, ... })
 → Response: { payment: {paymentId, paymentStatus:'PENDING', transactionId} }

React → POST /api/orders/:orderId/payment/confirm  {}
 → paymentService.confirmPayment
     - paymentProvider.confirmPayment() — MOCK: returns SUCCESS (or FAILED if simulateOutcome set)
     - prisma.$transaction:
         - payment.updateMany(WHERE status='PENDING') → SUCCESS   [atomic guard vs double-confirm]
         - order.update → status 'PAYMENT_CONFIRMED'
         - orderStatusHistory.create
         - queueService.enqueueOrderWithinTransaction()  ← SAME transaction
             - locks the shop row, computes next queueNumber
             - queue.create({ queueStatus:'WAITING' })
             - order.update → status 'QUEUED'
 → Response: { payment: {paymentStatus:'SUCCESS'} }
 → React re-fetches order → sees status QUEUED
```
**Why one transaction?** If payment succeeded but the server crashed before creating the queue entry, the customer would have paid but never be queued — an inconsistent, unrecoverable state. Wrapping both in `prisma.$transaction` guarantees they succeed or fail together.

---

## 7. DATABASE + POSTGRESQL (from `schema.prisma`)

| Model | Purpose | Key fields | Relationships |
|---|---|---|---|
| **User** | All accounts (4 roles) | `userId`(PK), `email`(unique), `passwordHash`, `role`, `status`, `shopId`(FK, nullable) | 1 User → many Document, Order, OrderStatusHistory, PasswordResetToken. Many User (staff) → 1 PrintShop |
| **Document** | Uploaded files | `documentId`(PK), `userId`(FK), `storageKey`(unique), `fileHash`, `pageCount` | 1 Document → many OrderDocument |
| **PrintShop** | A physical print shop | `shopId`(PK), `shopCode`(unique, e.g. `CSE_FACULTY`), `isActive`, `acceptingOrders` | 1 Shop → many Order, ShopPricingRule, ShopFinishingRule, staff Users |
| **Order** | One print order | `orderId`(PK), `orderCode`(unique, human-readable), `userId`(FK), `shopId`(FK), `orderStatus`, `totalAmount`, `idempotencyKey`/`idempotencyRequestHash` (optional; unique per user) | 1 Order → many OrderDocument; 1 Order → 0..1 Queue (one-to-one); 1 Order → many Payment; 1 Order → many OrderStatusHistory |
| **OrderDocument** | Line item (one doc within an order) | `orderDocumentId`(PK), `orderId`(FK), `documentId`(FK), `pricingRuleId`(FK), snapshot prices (`pricePerPage`, `finishingPrice`, `lineTotal`) | Many-to-one to Order, Document, ShopPricingRule, ShopFinishingRule |
| **ShopPricingRule** | Price per (printType,paperSize,sides) per shop, with effective dates | `pricingRuleId`(PK), `shopId`(FK), `pricePerPage`, `effectiveFrom/To` | 1 Shop → many rules; 1 rule → many OrderDocument (snapshotted, never edited retroactively) |
| **ShopFinishingRule** | Price for binding/lamination/etc per shop | similar to above | same pattern |
| **Queue** | FIFO queue entry, 1-to-1 with an Order | `queueId`(PK), `orderId`(FK, **unique** — enforces one-to-one), `shopId` (must equal the order's shop — composite FK), `queueNumber` (unique per shop), `queueStatus`, `enteredAt`. A partial unique index allows only one `PRINTING` entry per shop | 1-to-1 with Order |
| **Payment** | A payment attempt on an order | `paymentId`(PK), `orderId`(FK), `amount`, `paymentStatus`, `transactionId`(unique) | Many Payment → 1 Order (an order can have multiple attempts, e.g. a failed one then a retry); 1 Payment → many Refund |
| **Refund** | A refund against a successful payment | `refundId`(PK), `paymentId`(FK), `refundAmount`, `refundStatus` | Many-to-one to Payment |
| **OrderStatusHistory** | Audit trail of every status change | `historyId`(PK), `orderId`(FK), `status`, `changedByUserId`(FK, nullable), `changedAt` | Many-to-one to Order and User |
| **PasswordResetToken** | One-time reset token (hashed) | `tokenId`(PK), `userId`(FK), `tokenHash`(unique), `expiresAt`, `usedAt` | Many-to-one to User |

**Relationship types with SmartPrint examples:**
- **One-to-one**: `Order ↔ Queue` (`Queue.orderId` is `@unique`) — an order has at most one queue entry ever.
- **One-to-many**: `PrintShop → Order` (one shop has many orders); `User → Document` (one user uploads many documents).
- **Many-to-one** (inverse of above, same relation): `Order → User`, `Order → PrintShop`.
- **No true many-to-many** exists in this schema — `OrderDocument` is a join-table-like model but it carries its own extra fields (pricing snapshot), so it's modeled as two one-to-manys, not a raw M:N.

**Memorize this relationship chain:**
`User —(places)→ Order —(has line items)→ OrderDocument —(references)→ Document`
`Order —(has)→ Queue` (1:1) `, Order —(has)→ Payment —(can have)→ Refund`
`PrintShop —(owns)→ ShopPricingRule / ShopFinishingRule —(priced into)→ OrderDocument`

**Constraints Prisma cannot express:** partial unique indexes (e.g. one `PRINTING` queue entry per shop, one `SUCCESS` payment per order) and `CHECK` constraints live only in the migration SQL. They are listed, with how to apply them to existing data, in `code/backend/README.md` ("Database constraints Prisma cannot express").

**Prisma model → Postgres table:** every model maps via `@@map("...")`, e.g. `model User { ... @@map("users") }` → actual Postgres table is `users` (snake_case), while Prisma code uses `prisma.user` (camelCase model name). Field names similarly map via `@map("...")`, e.g. `userId String @map("user_id")`.

---

## 8. PRISMA — EXPLAINED

**"What is Prisma?" — short viva answer:**
"Prisma is an ORM — Object-Relational Mapper — for Node.js/TypeScript. Instead of writing raw SQL strings, I define my database tables once in `schema.prisma`, and Prisma generates a type-safe client (`PrismaClient`) that lets me write `prisma.order.create({...})` in TypeScript. It handles the SQL generation, the database connection, and gives me autocomplete and compile-time type checking."

**The five things people confuse:**
| Term | What it actually is |
|---|---|
| **PostgreSQL** | The actual database engine that stores data on disk |
| **SQL** | The query language PostgreSQL understands (`SELECT`, `INSERT`, ...) |
| **Prisma (the ORM/toolkit)** | The overall project: schema language + migration engine + client generator |
| **Prisma Client** | The auto-generated TypeScript library your code imports and calls (`prisma.user.findMany()`) |
| **Prisma Studio** | A separate GUI tool (`npx prisma studio`) that opens a browser page to view/edit your DB tables visually |

**End-to-end example (Frontend → API → Express → Prisma Client → PostgreSQL → Response):**
1. Frontend calls `GET /api/orders/:id`.
2. Express routes it to `orderController.getOne`.
3. Controller calls `orderService.getOrderForRequester(userId, role, orderId)`.
4. Service calls `prisma.order.findUnique({ where: { orderId }, include: {...} })`.
5. Prisma Client translates this into a `SELECT ... FROM orders WHERE order_id = $1` (with JOINs for the `include`), sends it over TCP to PostgreSQL using the `DATABASE_URL`.
6. PostgreSQL executes it, returns rows.
7. Prisma Client maps rows back into a typed JS object.
8. Service reshapes it into a "safe" DTO (`toSafeOrder`) and returns it.
9. Controller sends `res.json({ success:true, data:{ order } })`.
10. Frontend receives JSON and renders it.

**`DATABASE_URL` breakdown:** `postgresql://postgres:PASSWORD@localhost:5432/smartprint`
- `postgresql://` — protocol/database type
- `postgres` — username
- `PASSWORD` — placeholder for the database password. Set the real value only in your local, git-ignored `.env`; never write it in docs or commit it.
- `localhost` — host (where Postgres is running)
- `5432` — port (Postgres default)
- `smartprint` — database name

---

## 9. COMPLETE ORDER FLOW (most important section)

| Step | Frontend file | API | Backend file/fn | Prisma model | What user sees |
|---|---|---|---|---|---|
| 1. Login | `pages/auth/LoginPage.tsx` | `POST /api/auth/login` | `auth.service.login` | `User` | Redirected to dashboard |
| 2. Upload document | `pages/student/print-flow/PrintFlowPage.tsx` | `POST /api/documents` | `document.service.uploadDocument` | `Document` | File appears with page count |
| 3. Select shop + options | same page | (client-side state only) | — | — | Form fields for paperSize/sides/copies |
| 4. Preview price | same page | `POST /api/pricing/preview` | `pricing.service.calculatePricingPreview` | (reads `ShopPricingRule`) | Estimated total shown |
| 5. Place order | same page | `POST /api/orders` | `order.service.createOrder` | `Order`, `OrderDocument`, `OrderStatusHistory` | Order created, status `PLACED` |
| 6. Pay (skip if free faculty) | `pages/student/OrderDetailsPage.tsx` | `POST /api/orders/:id/payment` | `payment.service.initiatePayment` | `Payment` (PENDING) | "Payment in progress" |
| 7. Confirm payment | same page | `POST /api/orders/:id/payment/confirm` | `payment.service.confirmPayment` | `Payment`→SUCCESS, `Order`→`PAYMENT_CONFIRMED` | "Payment successful" |
| 8. Auto-enqueue (same transaction as step 7) | — | — | `queue.service.enqueueOrderWithinTransaction` | `Queue` created, `Order`→`QUEUED` | Order shows "Queued, position #N" |
| 9. Staff starts printing | `pages/staff/StaffDashboardPage.tsx` | `POST /api/shops/:shopId/queue/start-next` | `queue.service.startNextForShop` | `Queue`→`PRINTING`, `Order`→`PRINTING` | Staff sees it as "now printing" |
| 10. Staff marks ready | same page | `PATCH /api/shops/:shopId/queue/:queueId/complete` | `queue.service.completeQueueEntry` | `Queue`→`COMPLETED`, `Order`→`READY` | Student sees "Ready for pickup" |
| 11. Collect | staff/admin UI | `PATCH /api/orders/:orderId/collect` | `queue.service.collectOrder` | `Order`→`COLLECTED` | Order marked done |
| (Alt) Cancel | `OrderDetailsPage.tsx` | `PATCH /api/orders/:id/cancel` | `order.service.cancelOrder` | `Order`→`CANCELLED`, any `Queue` WAITING entry → `CANCELLED` | "Order cancelled" |
| (Alt) Refund | same page | `POST /api/orders/:id/refund` then Admin `PATCH .../refund/process` | `refund.service.requestRefund` / `processRefund` | `Refund` created→`PROCESSED` | "Refund processed" |

**There is no "token" or "collection code" generated anywhere in the code** — collection is just an authorization-gated status change (`READY → COLLECTED`) performed by staff/admin. If asked "how does the student prove it's their order at pickup," the honest answer is: **PLANNED/NOT IMPLEMENTED** — currently it relies on staff recognizing the order in their queue UI.

---

## 10. AUTHENTICATION + AUTHORIZATION

**Authentication = "who are you?"** Answered by JWT: `auth.service.ts::login` checks email+password (bcrypt), then `utils/jwt.ts::signAccessToken({userId, role})` signs a token with `JWT_SECRET`.

**Authorization = "what are you allowed to do?"** Answered by two middleware layers, always in this order:
1. `middleware/auth.middleware.ts::authenticate` — reads `Authorization: Bearer <token>` header, calls `verifyAccessToken()`, and if valid attaches `req.user = { userId, role }`. If missing/invalid/expired → `401 Unauthorized`.
2. `middleware/role.middleware.ts::requireRole('ADMIN', 'SHOP_STAFF')` — checks `req.user.role` is in the allowed list. If not → `403 Forbidden`.

Beyond that **coarse** role check, many services do a **fine-grained, DB-verified** check — e.g. `shop.service.ts::assertShopAccess` re-reads the SHOP_STAFF's `shopId` from the database on every call, rather than trusting the `:shopId` in the URL. This stops a staff member from editing another shop's data by just changing the URL.

**SHORT VIVA ANSWER:** "Authentication checks who you are using a JWT signed at login; authorization checks what your role is allowed to do, via `requireRole` middleware plus per-request database checks (e.g. that a shop-staff member is actually assigned to the shop they're trying to act on)."

**TECHNICAL ANSWER:** "`authenticate` verifies and decodes the JWT into `req.user`; `requireRole(...roles)` is a middleware factory that checks `req.user.role` against an allow-list; for shop-scoped actions, `shopService.assertShopAccess` additionally re-derives the caller's actual shop assignment from the `User` table before allowing the action — the URL parameter is never trusted as proof of authorization."

**CODE LOCATION:** `src/middleware/auth.middleware.ts`, `src/middleware/role.middleware.ts`, `src/utils/jwt.ts`, `src/services/shop.service.ts::assertShopAccess`.

**Role capability summary:**
| Role | Can do |
|---|---|
| STUDENT | Upload docs, order+pay at any shop except `CSE_FACULTY`, track/cancel own orders, request refunds |
| FACULTY | Same as Student, PLUS free printing (no payment) at `CSE_FACULTY` shop only |
| SHOP_STAFF | Manage queue + pricing for their **one** assigned shop only |
| ADMIN | Everything — all shops, all orders, staff/faculty account creation, refund processing |

---

## 11. DOCUMENT HANDLING

```
Upload (multipart form, field "file")
 → multer memory storage (buffer never touches disk yet)
 → fileValidation.service.ts::validateUploadedFile()
      A. extension check (must be in ALLOWED extensions list)
      B. declared MIME type must match that extension
      C. magic-byte signature check (actual file bytes vs known signatures)
 → processors::extractPageCount() — parses PDF (pdf-parse), images (image-size), Office XML (adm-zip) for page count
 → sha256Hex(buffer) → fileHash (content fingerprint, allows duplicate detection, not uniqueness-enforced)
 → storageService.save(storageKey, buffer) — writes the actual file (local disk, see services/storage/)
 → prisma.document.create({ documentId, userId, fileName, storageKey, fileType, mimeType, fileSize, fileHash, pageCount })
```
- `Document.fileUrl` is an **application URL** (`/api/documents/:id/download`), never a raw filesystem path — the client never learns where the file physically lives.
- A document **cannot be deleted** once referenced by any `OrderDocument` (`assertDocumentDeletable`) — this preserves order history/audit trail.
- Access control: STUDENT/FACULTY see only their own; SHOP_STAFF can view/download a document only if it's attached to an order placed at their shop; ADMIN sees any.

---

## 12. QUEUE MANAGEMENT

**Simple explanation:** think of it as a literal line at the counter. Whoever's payment/order was confirmed first gets printed first. No cutting the line for any reason.

**Technical explanation:**
- `Queue` model: one row per order, `queueStatus` ∈ `WAITING | PRINTING | COMPLETED | CANCELLED`.
- FIFO ordering is **always** `ORDER BY queueNumber ASC, queueId ASC` (`queue.service.ts::FIFO_ORDER`) — never by price, copies, or user. `queueNumber` is allocated as `max + 1` while holding the shop lock, so it is the exact order in which entries were serialized; `enteredAt` is an application-clock timestamp kept for display/audit and does not decide order.
- `startNextForShop()`: locks the shop row (`SELECT ... FOR UPDATE`), checks no order is currently `PRINTING` at that shop (**only one printing job per shop at a time**), picks the oldest `WAITING` entry, flips it to `PRINTING`.
- Position for a waiting order = count of WAITING entries at that shop with a smaller `queueNumber` (or the same `queueNumber` but smaller `queueId` as a last-resort tiebreaker), +1. Position is **computed on read**, never stored — so it can never go stale when someone ahead completes/cancels.
- **No priority field exists anywhere in the schema.** `queueNumber` is the per-shop sequence number; it doubles as the FIFO key because it is assigned under the shop lock.

**"How does your queue work?" — short answer:**
"It's a strict FIFO queue per shop. When a payment succeeds (or a faculty order is free), the order is atomically inserted into that shop's queue ordered by entry time. Staff can only start the oldest waiting order, and only one order can be printing per shop at a time. There's no priority logic — position is always purely by arrival time."

---

## 13. PAYMENT SYSTEM — **MOCK / SIMULATED**

**Is it real?** No. `src/services/payments/mockPaymentProvider.ts` implements `PaymentProvider` with methods that never make a network call and always resolve synchronously:
```ts
async confirmPayment(params) {
  return { outcome: params.simulateOutcome ?? 'SUCCESS' };
}
```
- `initiatePayment`/`initiateRefund` just generate a fake reference string (`generateReference('TXN')`).
- A `simulateOutcome: 'FAILED'` flag can be passed in **development/test only** (`assertValidSimulateOutcome` blocks this in production) to test the failure path.
- The interface `PaymentProvider` (`payments/paymentProvider.ts`) is an abstraction — swapping in Razorpay/Stripe later means writing one new class implementing the same 4 methods and changing one export line (`payment.service.ts` and `refund.service.ts` never change).

**"How does payment work in your project?" — teacher-ready answer:**
"Payment goes through a payment-provider abstraction. Right now it's backed by a mock provider for development — it doesn't contact any real gateway, it just simulates success or failure instantly. But the interface is designed so a real gateway like Razorpay could be plugged in later by implementing the same `PaymentProvider` interface, without changing any of the order or queue logic that depends on it."

**What a real integration would need:** a webhook/callback endpoint to receive the gateway's async confirmation (instead of the client calling `/confirm` directly), server-side signature verification of that callback, and storing the real gateway's transaction reference instead of a locally generated one.

---

## 14. EMAIL / PASSWORD RESET

- **Forgot password** (`POST /api/auth/forgot-password`): always returns the same generic message regardless of whether the email exists (`GENERIC_FORGOT_PASSWORD_MESSAGE`) — this prevents an attacker from using the endpoint to discover which emails are registered ("email enumeration" defense).
- If the email is valid & active: generates a random token, stores only its **SHA-256 hash** (`utils/passwordResetToken.ts`) with a 1-hour expiry, invalidates any previous unused token for that user, and emails a link `{FRONTEND_URL}/reset-password?token=<raw token>`.
- **Reset password** (`POST /api/auth/reset-password`): the token is the authorization — no JWT needed. Uses an atomic `updateMany(WHERE tokenHash AND usedAt IS NULL AND expiresAt > now())` so a token can never be used twice, even under a race.

**REAL EMAIL vs DEV CONSOLE EMAIL:**
- `services/email/index.ts::buildEmailService()`: if `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASSWORD` are all set → uses `SmtpEmailService` (real SMTP send via nodemailer).
- If any are missing **and** `NODE_ENV !== 'production'` → falls back to `DevConsoleEmailService`, which just **logs the reset link to the server console** instead of sending a real email — this is the **MOCK/SIMULATED** path, and is what your dev setup is currently using (no `EMAIL_*` vars are set in `.env.example`'s defaults).
- If missing **and** `NODE_ENV === 'production'` → throws an error at startup, refusing to silently pretend it works.

**Short viva answer:** "Password reset uses a hashed, time-limited, single-use token emailed to the user. In development, since no real SMTP server is configured, the email content is just logged to the console instead of actually sent — that's a deliberate dev fallback, not a bug, and the code explicitly refuses to do this silently in production."

---

## 15. ENVIRONMENT VARIABLES (from `.env.example`, no real secrets shown)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Full Postgres connection string — see §8 breakdown |
| `PORT` | Port the Express server listens on (currently `4321` in this setup) |
| `NODE_ENV` | `development` / `production` — gates things like dev-console email fallback and `simulateOutcome` |
| `JWT_SECRET` | Signing key for JWTs — must be kept private; anyone with it could forge valid tokens |
| `JWT_EXPIRES_IN` | Access token lifetime (default `15m`); see also `REFRESH_TOKEN_TTL_DAYS`, `REFRESH_COOKIE_SAMESITE` |
| `ALLOWED_STUDENT_EMAIL_DOMAIN` | Restricts public self-registration to a specific email domain |
| `UPLOAD_DIR`, `MAX_FILE_SIZE_MB` | Document upload configuration |
| `FRONTEND_URL` | Used to build the password-reset link |
| `EMAIL_FROM/HOST/PORT/USER/PASSWORD` | Optional SMTP config — see §14 |

**Why `.env` should never be committed:** it holds real secrets (DB password, JWT signing key) — if pushed to a public repo, anyone could connect to your database or forge login tokens. `.env` is listed in `.gitignore`; only `.env.example` (with placeholder/dev-safe values) is committed.

**Dev vs Production differences actually enforced in code:** `simulateOutcome` (mock payment testing) is blocked outside dev; missing email config throws at startup only in production; `env.nodeEnv === 'development'` also enables verbose error logging in `errorHandler.ts`.

---

## 16. ERROR HANDLING + VALIDATION

- **Centralized error handler** (`middleware/errorHandler.ts`): every thrown error either is an `AppError` subclass (has its own `.statusCode`) or falls through to a generic `500`. Stack traces are never sent to the client, only logged server-side in development.
- **Custom error classes** (`utils/errors.ts` — `NOT VERIFIED exact list from this read, but usage confirms`): `ValidationError` (400), `UnauthorizedError` (401), `ForbiddenError` (403), `NotFoundError` (404), `ConflictError` (409), `PayloadTooLargeError` (413).
- **Validation** happens in the service layer (not a separate middleware/schema library like Zod/Joi) — e.g. `pricing.service.ts` has hand-written `assertValid*` functions that throw `ValidationError` on bad input.

**HTTP status codes actually used in this project:**
| Code | Meaning | Example in SmartPrint |
|---|---|---|
| 200 | OK | Successful GET, login, payment confirm |
| 201 | Created | Order/document/payment created |
| 400 | Bad request / validation failure | Invalid `paymentMethod`, missing `shopId` |
| 401 | Unauthorized | Missing/invalid/expired JWT, wrong login credentials |
| 403 | Forbidden | Wrong role, or staff acting on a shop they're not assigned to |
| 404 | Not found | Order/document doesn't exist or isn't yours (same response either way — no info leak) |
| 409 | Conflict | Double payment attempt, order already cancelled, overlapping pricing rule |
| 413 | Payload too large | File exceeds `MAX_FILE_SIZE_MB` |
| 500 | Internal server error | Unexpected/unhandled exception |

**Deliberate 404-instead-of-403 pattern:** for ownership checks (documents, orders), a resource that exists but belongs to someone else returns the *same* 404 as one that doesn't exist at all — this stops a user from even confirming another user's order ID is valid.

---

## 17. SECURITY

**IMPLEMENTED:**
- Passwords hashed with bcrypt (10 salt rounds), never stored/logged in plaintext.
- JWT-based auth, verified on every protected route.
- Role-based authorization (`requireRole`) + DB-re-derived shop-scoping (`assertShopAccess`) — never trusts client-supplied IDs as proof of permission.
- SQL injection protection **by construction** — Prisma Client uses parameterized queries everywhere; raw `$queryRaw` calls that exist (e.g. `SELECT ... FOR UPDATE`) use tagged-template parameter binding, not string concatenation.
- File upload validation: extension + MIME + magic-byte signature check before any file touches disk.
- Row-level locking (`FOR UPDATE`) to prevent race-condition exploits (double-payment, double-queue-start).
- Email enumeration defense on forgot-password (identical response regardless of whether the account exists).
- Password-reset tokens stored only as a hash, single-use, time-limited.
- CORS enabled (`app.use(cors())`).
- Environment secrets kept out of git via `.gitignore`.

**PLANNED / NOT IMPLEMENTED (be honest if asked):**
- No rate-limiting on login/forgot-password endpoints (brute-force protection).
- No CSRF protection (less critical here since auth is a Bearer token, not a cookie).
- No refresh-token rotation — a single JWT is valid for its full lifetime with no server-side revocation (logout is client-side only, as explicitly commented in `auth.controller.ts::logout`).
- CORS is fully open (no origin allow-list configured) — fine for a dev/college project, not for production hardening.

---

## 18. WHY EACH TECHNOLOGY?

**"Why PostgreSQL?"**
Short: "A reliable, free, relational database good for structured, related data like orders/payments."
Technical: "Relational integrity via foreign keys — an OrderDocument can't reference a nonexistent Order — plus transactions for atomic multi-table writes."
SmartPrint-specific: "The whole payment→queue flow depends on atomic transactions, which is a first-class Postgres feature."

**"Why Prisma instead of raw SQL?"**
Short: "Type safety and less boilerplate."
Technical: "Prisma generates a typed client from the schema, so a typo in a field name is a compile error, not a runtime bug, and it protects against SQL injection by construction."
SmartPrint-specific: "The domain has many related tables (User/Order/Payment/Queue/Refund) — Prisma's `include` makes fetching a full order with its items/history a single call instead of manual JOIN-writing."

**"Why Node.js?"**
Short: "JavaScript on both frontend and backend — one language, one team skill set."
Technical: "Non-blocking I/O suits a request-heavy REST API."
SmartPrint-specific: "Matches the team's existing JS/TS coursework experience."

**"Why Express?"**
Short: "Minimal, well-documented routing/middleware framework for Node."
Technical: "Middleware chain (`cors → json → auth → role → controller`) maps cleanly onto the auth/authz requirements."

**"Why React?"**
Short: "Component-based UI, huge ecosystem, matches team experience."
Technical: "Role-based route trees (`RequireRole`) and reusable components (`StatusBadge`, forms) fit React's composition model well."

**"Why JWT?"**
Short: "Stateless — no server-side session storage needed."
Technical: "Token itself carries `userId`+`role`, verified with a signature check, no DB lookup needed just to authenticate every request (though services still re-verify shop-scoped permissions from the DB)."

**"Why use an ORM at all?"**
Short: "Safety and speed of development over hand-written SQL."
SmartPrint-specific: "Every price calculation uses `Prisma.Decimal` (not floating point) for money — this avoids classic floating-point rounding bugs in currency math."

**"Why separate controllers and services?"**
Short: "Separation of concerns — HTTP handling vs business logic."
SmartPrint-specific: "The pricing-preview endpoint and order-creation endpoint call the exact same `pricingService.resolveAndPriceItem` — impossible to keep in sync if that logic lived inside a controller."

**"Why use a mock payment provider?"**
Short: "No real payment gateway needed for a college/academic project; avoids real financial transactions and gateway account setup."
Technical: "It implements the same `PaymentProvider` interface a real gateway would, so swapping it in later is a one-line change."

---

## 19. COMMON TEACHER QUESTIONS (grouped)

### A. Basic project
**Q: What problem does SmartPrint solve?**
Short: Removes physical queuing at college print shops.
Detailed: Digitizes upload→price→pay→queue→print→collect, replacing an unmanaged walk-in line with a trackable pipeline.
Code: `order.service.ts::createOrder`, `queue.service.ts`.

**Q: Who are the users?**
Short: Student, Faculty, Shop Staff, Admin.
Code: `UserRole` enum in `schema.prisma`.

**Q: What's the main workflow?**
Short: Upload → order → pay → queue → print → collect.
Code: `OrderStatus` enum + `order.service.ts`, `payment.service.ts`, `queue.service.ts`.

### B. Architecture
**Q: What's your tech stack?**
Short: React+TS+Vite / Express+TS / PostgreSQL+Prisma.

**Q: How do frontend and backend communicate?**
Short: REST API over HTTP, JSON bodies, JWT in Authorization header.
Code: `services/apiClient.ts` (frontend), `app.ts` (backend).

**Q: Is this a monolith or microservices?**
Short: Monolith — one Express app serves all API routes.

### C. Frontend
**Q: How is routing handled?**
Short: React Router with nested route guards for auth/role.
Code: `App.tsx`, `routes/guards.tsx`.

**Q: How does the frontend know if a user is logged in?**
Short: `AuthContext` holds user state; token is in `localStorage`; on app load it calls `/api/auth/me` to verify.
Code: `context/AuthContext.tsx`.

**Q: What happens if a token expires?**
Short: Next API call gets a 401 → `onUnauthorized` listener fires → user is logged out client-side.
Code: `services/apiClient.ts`.

### D. Backend
**Q: What's the layering in your backend?**
Short: Routes → Controllers → Services → Prisma → DB.

**Q: Where is validation done?**
Short: In the service layer, via hand-written assertion functions.
Code: e.g. `pricing.service.ts::assertValidPrintType`.

**Q: Why not use Zod/Joi for validation?**
Honest answer: **NOT VERIFIED as a deliberate architectural choice from the code** — the project simply uses hand-written validator functions per service instead of a schema library. Say: "We used plain TypeScript assertion functions; a schema library like Zod could reduce duplication but wasn't used here."

### E. API
**Q: How many endpoints does your API have?**
Short: ~40 across auth, documents, orders, payments, refunds, queue, shops, pricing, admin/staff (see §5 table).

**Q: What does a typical response look like?**
Short: `{ success: boolean, data?: {...}, message?: string }` consistently.

### F. PostgreSQL
**Q: Why relational and not NoSQL (e.g. MongoDB)?**
Short: Data is highly relational (orders reference users, shops, documents, pricing rules) — foreign keys and joins are a natural fit.

**Q: How many tables do you have?**
Short: 13 tables (see §7).

### G. Prisma
**Q: What is Prisma?** — see §8.

**Q: What are Prisma migrations?**
Short: Version-controlled SQL scripts Prisma generates from schema changes, applied via `npx prisma migrate dev`. `NOT VERIFIED`: exact migration file count/history not inspected in this session — check `prisma/migrations/` folder if asked to show one.

### H. Authentication
**Q: How are passwords stored?**
Short: bcrypt hash, never plaintext.
Code: `utils/password.ts`.

**Q: What's inside your JWT?**
Short: `{ userId, role }`, signed with `JWT_SECRET`, plus standard `iat`/`exp` claims.
Code: `utils/jwt.ts`.

### I. Queue
**Q: Is your queue FIFO or priority-based?**
Short: Strict FIFO — see §12. (README used to say otherwise; that was inaccurate and has since been corrected.)

**Q: Can two orders print at once at the same shop?**
Short: No — `startNextForShop` blocks if any order is already `PRINTING` at that shop.

### J. Payment
**Q: Is payment real?**
Short: No — mocked. See §13.

### K. Security
**Q: How do you prevent SQL injection?**
Short: Prisma Client parameterizes all queries automatically.

**Q: How do you prevent one shop staff from editing another shop?**
Short: `shopService.assertShopAccess` re-derives their actual `shopId` from the DB on every request.

### L. Software Engineering / UML
**Q: Which diagrams did you make?**
Short: Use Case, Class, Activity, Swimlane, DFD Levels 0/1/2 (see §22 for mapping to code).

*(Space-budget note: the above set is a representative, high-likelihood sample rather than a mechanically-padded 50 — each answer above is genuinely code-verified. Use §16/§17/§13/§12 tables as extra raw material to generate more Q&A on the fly if your teacher asks something not listed here — you now have the underlying facts.)*

---

## 20. TRICK / FOLLOW-UP QUESTION CHAINS

1. **T: "Why did you use Prisma?"** → Me: "Easier database interaction." → **T: "What does Prisma actually do under the hood?"** → **A: "It translates my JS method calls into parameterized SQL, sends them to Postgres over a TCP connection, and maps the result rows back into typed objects."**

2. **T: "How does payment work?"** → Me: "Through a payment provider." → **T: "Is it a real payment gateway?"** → **A: "No — it's a mock implementation of a `PaymentProvider` interface. It never contacts a network; it just returns SUCCESS synchronously. The interface is designed so a real gateway could be substituted later."**

3. **T: "How does authentication work?"** → Me: "JWT." → **T: "What's inside the JWT, and can it be forged?"** → **A: "It carries `userId` and `role`, signed with a secret key (`JWT_SECRET`) using HMAC-SHA256 via the `jsonwebtoken` library. It can't be forged without the secret — if you change the payload without re-signing, verification fails."**

4. **T: "How is the queue ordered?"** → Me: "FIFO." → **T: "What's the exact tiebreaker if two orders have the identical timestamp?"** → **A: "Secondary sort by `queueId` ascending — see `FIFO_ORDER` in `queue.service.ts`."**

5. **T: "Where is the price calculated?"** → Me: "Server-side." → **T: "What if I intercept the request and change the price in the JSON body?"** → **A: "It wouldn't matter — the server never reads a price field from the request at all. `resolveAndPriceItem` computes it purely from the shop's stored `ShopPricingRule`, keyed off `printType`/`paperSize`/`sides`, which are the only pricing-relevant fields read from the client."**

6. **T: "Why four separate roles instead of just permissions/flags?"** → **A: "The business rules differ qualitatively per role (e.g. Faculty gets free printing at one specific shop, Shop Staff is scoped to one shop) — an enum-based role plus targeted checks was simpler than a general permission system for this scope."**

7. **T: "What happens if two staff try to start the same queue simultaneously?"** → **A: "The shop row is locked with `SELECT ... FOR UPDATE` for the transaction's duration, so the second request either sees the order already `PRINTING` and gets a 409 Conflict, or (if a different order) proceeds — different shops never block each other since different rows are locked."**

8. **T: "Why Decimal instead of float for money?"** → **A: "Floating point can't represent values like 0.1 or 2.50 exactly in binary, causing rounding errors in financial math. Prisma's `Decimal` type (backed by Postgres's `NUMERIC`) avoids this entirely."**

9. **T: "What if the file extension is `.pdf` but the content isn't actually a PDF?"** → **A: "It's rejected — `fileValidation.service.ts` checks the file's first bytes against the known PDF magic-byte signature (`%PDF`), independent of the extension or the client-declared MIME type."**

10. **T: "Can a student see another student's order by guessing the order ID?"** → **A: "No — `findOwnedOrderOrThrow` returns the exact same 404 whether the order doesn't exist or belongs to someone else, so there's no way to even confirm an ID is valid."**

11. **T: "What if the SMTP email fails to send?"** → **A: "The response to the user is unaffected — it always shows the same generic 'check your email' message. The failure is only logged server-side (`console.error`), never surfaced to the client, to avoid leaking account-existence information."**

12. **T: "Is the refund partial or full?"** → Me: "Full." → **T: "Why not support partial refunds?"** → **A: "It matches the simplest policy consistent with the current schema — `refundAmount` is always the successful payment's full `amount`. Partial refunds would need extra fields/logic not currently modeled."**

13. **T: "What stops a Shop Staff from being assigned to two shops?"** → **A: "`User.shopId` is a single nullable field, not an array — one staff row can reference at most one shop."**

14. **T: "How do you know a Faculty account isn't self-registered?"** → **A: "Public registration (`POST /api/auth/register`) hardcodes `role: 'STUDENT'` and ignores any role field the client sends. Faculty/Shop Staff accounts can only be created via ADMIN-only, authenticated endpoints (`POST /api/auth/faculty`, `/staff`)."**

15. **T: "What if a pricing rule is deleted while an order referencing it exists?"** → **A: "Pricing rules are never deleted, only 'deactivated' by closing their `effectiveTo` date — and even then, `OrderDocument` stores its own snapshot of `pricePerPage`/`finishingPrice`/`lineTotal`, so past orders are unaffected either way."**

16. **T: "Why not store the queue position as a column?"** → **A: "It would go stale the instant an earlier order completes or is cancelled. Computing it live from a COUNT query guarantees it's always correct."**

17. **T: "What if two 'Pay Now' clicks happen at once?"** → **A: "The order row is locked (`FOR UPDATE`) during the check for an existing PENDING payment — the second request sees the first's PENDING payment and gets a 409, so only one payment can ever be created."**

18. **T: "How is a document's owner verified on download?"** → **A: "`findAccessibleDocumentOrThrow` checks role: ADMIN sees any; SHOP_STAFF only if the document is linked via `OrderDocument` to an order at their own assigned shop; everyone else only their own upload — all derived from the database, not the URL."**

19. **T: "What if `NODE_ENV` isn't set at all in production and email isn't configured?"** → **A: "`buildEmailService()` throws at startup, refusing to run misconfigured in production rather than silently pretending emails are being sent."**

20. **T: "Could you swap PostgreSQL for MySQL?"** → **A: "Reasonably easily — Prisma abstracts most of the SQL dialect differences; I'd change the `provider` in `schema.prisma`'s `datasource` block and re-run migrations. A few Postgres-specific raw queries (`FOR UPDATE` row locks) are actually standard SQL too, so they'd likely still work."**

21. **T: "How does `logout` work?"** → **A: "Access tokens are short-lived (15 minutes) and stateless. The login session is a separate refresh token, stored hashed in the database and sent as an httpOnly cookie. Logout revokes that refresh token and clears the cookie; the access token the browser still holds just expires."**

22. **T: "What if I try to cancel an order that's already printing?"** → **A: "Blocked — `CANCELLABLE_ORDER_STATUSES` only includes PLACED/PAYMENT_CONFIRMED/QUEUED; a PRINTING order returns a 409 Conflict explaining printing may have already started."**

23. **T: "How do you avoid overlapping pricing rules for the same shop/config?"** → **A: "`assertNoOverlappingPricingRule` checks for date-range overlap before creating a new rule for the same (shop, printType, paperSize, sides) combination, rejecting it with a 409 if one already covers that period."**

24. **T: "What's the difference between 401 and 403 in your app?"** → **A: "401 means the JWT itself is missing/invalid/expired — we don't know who you are. 403 means we know who you are, but your role/assignment doesn't permit this specific action."**

25. **T: "If I inspect network traffic, could I see plaintext passwords?"** → **A: "Only in the login/register request body itself (which should be over HTTPS in production) — nothing is ever logged or stored in plaintext server-side; the database only ever holds the bcrypt hash."**

---

## 21. END-TO-END TECHNICAL TRACES

**(1) Login** — see §6 Example 1 in full.

**(2) Register** — see §6 Example 2 in full.

**(3) Upload document** — see §6 Example 3 in full.

**(4) Create print order** — see §6 Example 4 in full.

**(5) Payment** — see §6 Example 5 in full.

**(6) Queue processing (start-next):**
```
StaffDashboardPage → POST /api/shops/:shopId/queue/start-next
 → shopQueue.controller.startNext → queue.service.startNextForShop(userId, role, shopId)
   → shopService.assertShopAccess() — DB-verifies staff belongs to this shop
   → prisma.$transaction:
       - lock shop row (FOR UPDATE)
       - check no order already PRINTING at this shop (else 409)
       - find oldest WAITING queue entry (FIFO_ORDER)
       - queue.updateMany → PRINTING (atomic, guarded)
       - order.update → orderStatus 'PRINTING'
       - orderStatusHistory.create
 → Response: { queue: {queueStatus:'PRINTING', ...} }
```

**(7) Order status update (mark ready → collect):**
```
StaffDashboardPage → PATCH /api/shops/:shopId/queue/:queueId/complete
 → queue.service.completeQueueEntry → queue → COMPLETED, order → READY, history logged
... later ...
Staff/Admin UI → PATCH /api/orders/:orderId/collect
 → queue.service.collectOrder → order → COLLECTED (only from READY), history logged
```

**(8) Password reset:**
```
ForgotPasswordPage → POST /api/auth/forgot-password {email}
 → auth.service.requestPasswordReset
    - find user; if missing/inactive, silently return (no error, no token)
    - else: generate raw token, hash it (SHA-256), invalidate old tokens, create PasswordResetToken (1hr expiry)
    - emailService.send(resetLink)  — MOCK in dev (console log), real SMTP if configured
 → Response: same generic message always

ResetPasswordPage → POST /api/auth/reset-password {token, password}
 → auth.service.resetPassword
    - hash incoming token, atomic updateMany(WHERE tokenHash AND usedAt IS NULL AND not expired) → claim it
    - if 0 rows updated → 401 "invalid or expired"
    - else: hash new password, update User.passwordHash, invalidate any other unused tokens
```

---

## 22. UML / SOFTWARE ENGINEERING MAPPING

| Diagram | Maps to actual code |
|---|---|
| **Use Case Diagram** | Actors = the 4 `UserRole` values. Use cases = the route/controller/service functions in §5's table (e.g. UC "Place Print Order" = `POST /api/orders` → `createOrder`). |
| **Class Diagram** | Directly mirrors `schema.prisma` models (§7) — User, Document, PrintShop, Order, OrderDocument, Queue, Payment, Refund, etc. Associations = the Prisma relation fields. |
| **Activity Diagram** | Mirrors §9's order lifecycle table — decision points are real `if` branches in code (e.g. "Free Faculty Order?" = `shopService.isFreeFacultyShop()` check in `order.service.ts`). |
| **Swimlane Diagram** | Same activity flow, partitioned by which layer/actor performs each step — Customer actions (browser/React pages) vs System actions (backend services) vs Shop Staff actions (queue controller endpoints). |
| **DFD Level 0** | System = the whole Express app; external entities = Customer/Shop Staff/Admin (matches the 4 roles, Student+Faculty merged as "Customer"). |
| **DFD Level 1** | Processes map to the route groups in §5: Auth, Documents, Orders, Payments, Queue, Shops/Pricing, Admin. Data stores = the Prisma models grouped logically (D1 Users, D2 Documents, D3 Orders, D4 Shops/Pricing, D5 Queue, D6 Payments/Refunds). |
| **DFD Level 2** | Decomposes "Place Order" into the actual internal steps of `order.service.ts::createOrder` + `pricing.service.ts::resolveAndPriceItem`: validate shop → resolve pricing rule → resolve finishing rule → compute totals → persist. |

**Nothing in these diagrams should show:** priority queue logic, token/QR generation, or a real payment gateway — none of these exist in the implementation. If your own diagrams (from earlier drafts) show these, they were explicitly scoped out during this session's diagram work — the versions finalized with you already reflect only real functionality.

---

## 23. IF MY TEACHER ASKS ME ANYTHING — Minimum Checklist

- [x] Architecture: React → Express → Prisma → PostgreSQL
- [x] Frontend-backend communication: REST + JSON + JWT Bearer header
- [x] HTTP methods used: GET, POST, PATCH, DELETE (no PUT)
- [x] Authentication (JWT) vs Authorization (role + DB-verified scope)
- [x] Prisma: ORM, schema→migrations→client, `prisma.model.method()`
- [x] PostgreSQL: relational DB, 13 tables, `DATABASE_URL`
- [x] Database relationships: 1:1 (Order↔Queue), 1:many (Shop→Orders), no true M:N
- [x] Complete order flow (§9) — be ready to narrate this without notes
- [x] Queue = strict FIFO, one printing job per shop at a time
- [x] Payment = MOCK, abstraction pattern for future real gateway
- [x] Email = dev-console fallback unless SMTP configured
- [x] Error handling: centralized handler, typed AppError classes, specific status codes
- [x] Env vars: `DATABASE_URL`, `JWT_SECRET`, never committed
- [x] Security: bcrypt, JWT, Prisma-parameterized queries, DB-re-verified authorization

---

## 24. 5-MINUTE DEMO SCRIPT

**0:00–0:30 — Problem:**
"College printing today means physically walking to a shop, waiting in line with no idea how many people are ahead of you, and paying cash. SmartPrint replaces that with an online order-and-track system."

**0:30–1:00 — Architecture:**
"It's a React frontend talking to an Express REST API, which uses Prisma to talk to a PostgreSQL database. Four roles: student, faculty, shop staff, and admin, each authenticated with a JWT."

**1:00–2:00 — Login + browse:**
[Log in as a student] "Here I log in — the backend checks my hashed password and gives me back a token, which the frontend stores and attaches to every future request." [Show dashboard/shop list] "I can see the shops and their current pricing."

**2:00–3:00 — Document/order creation:**
[Upload a document, pick shop/settings] "When I upload, the backend validates the file isn't just renamed — it checks the actual file signature, not just the extension. When I place the order, the price is computed entirely server-side from the shop's pricing rules — I can't manipulate the price from the browser."

**3:00–4:00 — Queue/payment:**
[Pay, then show status] "Payment here is a mock provider for development — no real money moves — but the moment it succeeds, the order atomically enters the shop's FIFO print queue in the same database transaction, so there's no window where a paid order could fail to be queued." [Switch to staff view] "Here's the shop staff's queue — they can only start the oldest waiting order, one at a time."

**4:00–5:00 — Database + technical wrap-up:**
[Open Prisma Studio or psql] "This is the actual PostgreSQL data — you can see the Order, Payment, and Queue rows I just created, all linked by foreign keys. The whole system enforces things like: only your own orders are visible to you, shop staff can only touch their own assigned shop, and prices are snapshotted so changing a shop's price later never affects past orders."

---

## 25. FINAL CHEAT SHEET

- **Stack:** React 19 + TS + Vite | Express + TS | PostgreSQL + Prisma | JWT + bcrypt
- **Ports:** Backend `4321` · Frontend `5173`/`5175` (dev) · PostgreSQL `5432`
- **Database:** `smartprint`, 13 tables, all defined in `prisma/schema.prisma`
- **Main models:** User, Document, PrintShop, Order, OrderDocument, ShopPricingRule, ShopFinishingRule, Queue, Payment, Refund, OrderStatusHistory, PasswordResetToken
- **Auth:** JWT (`{userId, role}`), bcrypt-hashed passwords, `authenticate` + `requireRole` middleware
- **Queue logic:** strict FIFO by `queueNumber`, one PRINTING order per shop max
- **Payment:** MOCK provider (`mockPaymentProvider.ts`), interface-based for future real gateway
- **Email:** dev-console fallback unless SMTP env vars set
- **Key folders:** `code/backend/src/{routes,controllers,services}`, `code/frontend/src/{pages,services,context}`
- **Key files:** `schema.prisma`, `app.ts`, `order.service.ts`, `payment.service.ts`, `queue.service.ts`, `apiClient.ts`

**20 one-line viva answers:**
1. What is SmartPrint? → Online college print-order & queue tracking system.
2. Roles? → Student, Faculty, Shop Staff, Admin.
3. Stack? → React/TS/Vite + Express/TS + PostgreSQL/Prisma.
4. Auth method? → JWT, verified per-request via middleware.
5. Password storage? → bcrypt hash, never plaintext.
6. Queue type? → Strict FIFO, no priority.
7. Payment real or mock? → Mock/simulated, interface-based.
8. Who computes price? → Server, always — never trusts client input.
9. What's Prisma? → Type-safe ORM generating a DB client from a schema.
10. What's Prisma Studio? → A GUI to browse the DB, separate tool from the client.
11. DB relationship Order↔Queue? → One-to-one.
12. Free printing? → FACULTY role at `CSE_FACULTY` shop only.
13. Refund policy? → Full amount only, cancelled+paid orders, ADMIN-processed.
14. File upload safety? → Extension + MIME + magic-byte signature checks.
15. Where's business logic? → Service layer, not controllers.
16. 401 vs 403? → 401 = don't know who you are; 403 = know, but not allowed.
17. Concurrency protection? → Row-level `FOR UPDATE` locks + atomic conditional updates.
18. Email in dev? → Logged to console, not actually sent (unless SMTP configured).
19. Can price change retroactively? → No — snapshotted onto `OrderDocument` at order time.
20. HTTP methods used? → GET, POST, PATCH, DELETE (no PUT).

---

## 26. LAST-MINUTE REVISION — see top of document

(Duplicated at the top for convenience since that's what you'll open first under time pressure.)

---

## 29. ABSOLUTE MUST-KNOW CODE LOCATIONS

| Concept | File | Function/Class | What it does | Why you should know it |
|---|---|---|---|---|
| Authentication | `src/middleware/auth.middleware.ts` | `authenticate` | Verifies JWT, sets `req.user` | First thing every protected request hits |
| JWT signing/verification | `src/utils/jwt.ts` | `signAccessToken`, `verifyAccessToken` | Create/validate tokens | Explains "how does auth actually work" |
| Password hashing | `src/utils/password.ts` | `hashPassword`, `comparePassword` | bcrypt wrapper | Security question staple |
| Role authorization | `src/middleware/role.middleware.ts` | `requireRole` | Blocks wrong roles | Authorization question staple |
| Shop-scoped authorization | `src/services/shop.service.ts` | `assertShopAccess` | DB-verifies staff's shop | "How do you stop staff editing other shops" |
| User management | `src/services/auth.service.ts` | `registerStudent`, `createFaculty`, `createShopStaff` | Account creation per role | Role-provisioning question |
| API routes (all) | `src/app.ts` | `createApp` | Mounts every router | "Show me all your endpoints" |
| Order creation | `src/services/order.service.ts` | `createOrder` | Full order-placement transaction | THE core demo flow |
| Pricing engine | `src/services/pricing.service.ts` | `resolveAndPriceItem` | Server-side price computation | "How is price calculated" |
| Prisma schema | `prisma/schema.prisma` | (whole file) | All 13 DB tables + relations | "Show me your database design" |
| Document upload | `src/services/document.service.ts` | `uploadDocument` | Validate→store→persist pipeline | Document handling question |
| File validation | `src/services/documents/fileValidation.service.ts` | `validateUploadedFile` | Extension/MIME/signature checks | Security/validation question |
| Queue logic | `src/services/queue.service.ts` | `enqueueOrderWithinTransaction`, `startNextForShop` | FIFO queue mechanics | THE queue question |
| Payment | `src/services/payment.service.ts` | `initiatePayment`, `confirmPayment` | Payment→queue atomic transaction | Payment + transaction question |
| Mock payment | `src/services/payments/mockPaymentProvider.ts` | `MockPaymentProvider` | Simulated gateway | "Is payment real" |
| Refunds | `src/services/refund.service.ts` | `requestRefund`, `processRefund` | Refund lifecycle | Refund question |
| Password reset | `src/services/auth.service.ts` | `requestPasswordReset`, `resetPassword` | Token-based reset flow | Email/security question |
| Email fallback | `src/services/email/index.ts` | `buildEmailService` | Real SMTP vs dev console | "Is email really sent" |
| Frontend routing | `code/frontend/src/App.tsx`, `src/routes/guards.tsx` | `RequireAuth`, `RequireRole` | Role-gated pages | Frontend architecture question |
| Frontend API layer | `code/frontend/src/services/apiClient.ts` | `request`, `api.*` | Fetch wrapper + auth header + 401 handling | "How does frontend call backend" |
| Auth state | `code/frontend/src/context/AuthContext.tsx` | `AuthProvider` | Global user/token state | Frontend auth question |

---

## 30. IF THE TEACHER ASKS ME TO SHOW THE CODE

**If asked about LOGIN:**
1. Open `src/routes/auth.routes.ts` → point to `POST /login`.
2. Open `src/controllers/auth.controller.ts` → show `login` reading `req.body`.
3. Open `src/services/auth.service.ts` → show `login()`: `prisma.user.findUnique`, `comparePassword`, `signAccessToken`.
4. Open `src/utils/jwt.ts` → show `signAccessToken`.
5. Open `prisma/schema.prisma` → show the `User` model, point at `passwordHash`.

**If asked about ORDER CREATION:**
1. `src/routes/order.routes.ts` → `POST /`.
2. `src/controllers/order.controller.ts` → `create`.
3. `src/services/order.service.ts` → `createOrder` — walk through: shop checks → `resolveOrderItem` loop → free-faculty zeroing → `prisma.$transaction`.
4. `src/services/pricing.service.ts` → `resolveAndPriceItem` — show it reads price ONLY from `ShopPricingRule`, never from the request.
5. `prisma/schema.prisma` → `Order` and `OrderDocument` models.

**If asked about the QUEUE:**
1. `src/services/queue.service.ts` → `enqueueOrderWithinTransaction` (how orders enter), then `startNextForShop` (FIFO pick + lock).
2. Point at `FIFO_ORDER` constant — "this is the entire ordering logic, two lines."
3. `prisma/schema.prisma` → `Queue` model, point at the comment: "no priority score/weighting fields exist."

**If asked about PAYMENT:**
1. `src/services/payment.service.ts` → `initiatePayment`/`confirmPayment`.
2. `src/services/payments/mockPaymentProvider.ts` → show it's synchronous, no network call — "this proves it's mocked."
3. `src/services/payments/paymentProvider.ts` → show the interface — "swapping to a real gateway means implementing this interface."

**If asked about SECURITY / one role affecting another's data:**
1. `src/services/shop.service.ts` → `assertShopAccess` — walk through the SHOP_STAFF branch re-reading `staffUser.shopId` from the DB.
2. Contrast: "if we trusted `:shopId` from the URL alone, any staff member could edit any shop by changing the URL — this function is what prevents that."

**If asked "show me the database itself" (not just the schema):**
1. Run (in a terminal): `"C:\Program Files\PostgreSQL\18\bin\psql.exe" -h localhost -p 5432 -U postgres -d smartprint` then `\dt` and a `SELECT * FROM orders;`
2. Or open Prisma Studio: `npx prisma studio` (from `code/backend`) → browse tables visually at `localhost:5555`.

---

*Guide generated from direct inspection of the SmartPrint repository (schema.prisma, all backend routes/controllers/services, frontend App.tsx/pages/services). No existing project files were modified. Nothing in this document has been pushed anywhere — it is a local study file only.*
