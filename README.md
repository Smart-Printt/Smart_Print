# 🖨️ SmartPrint

> A web-based printing management system that lets students and faculty submit print orders online and track them through a shop's print queue, instead of queuing physically at the counter.

## 📌 Overview

**SmartPrint** is a two-tier web application for college printing shops: a React/TypeScript frontend and a Node.js/Express/TypeScript REST API backend, backed by PostgreSQL via Prisma.

Traditional college printing requires a student to physically carry a document to the shop, wait while it's printed, and pay in cash on collection. SmartPrint replaces that with a digital flow: upload a document, choose print settings, pay online, and track the order's status until it's ready for collection.

---

## 🎯 Problem Statement

College printing shops often face:

- Long physical queues during peak hours (before deadlines/exams)
- No visibility into how many jobs are ahead of a given request
- Manual, cash-based pricing and no digital record of what was printed or charged
- No structured way for shop staff to track multiple pending jobs

### 💡 Our Solution

SmartPrint provides a centralized platform where students and faculty can:

1. Upload a document.
2. Choose a shop and print settings (paper size, sides, colour mode, copies, page range, optional finishing).
3. Pay online (through a payment abstraction; a real gateway can later be substituted).
4. Track the order's status until it's ready.
5. Visit the shop only to collect the finished print.

---

## 👥 Roles

SmartPrint has four roles, each with dedicated backend authorization and frontend routes:

- **Student** — self-registers, uploads documents, places and pays for print orders.
- **Faculty** — provisioned by an Admin; prints for free at the dedicated CSE department shop, pays like a student elsewhere.
- **Shop Staff** — provisioned by an Admin, assigned to exactly one shop; operates that shop's print queue and pricing.
- **Admin** — manages shops, staff/faculty accounts, and pricing; can view every order system-wide.

---

## ✨ Key Features

### 👨‍🎓 Student / Faculty Features

- 🔐 Login/registration with JWT-based authentication
- 📄 Upload documents (PDF, Word, Excel, PowerPoint, images), validated by file type, size, and file-signature check
- 🖨️ Specify print settings and get a server-computed price (never trusted from the client)
- 💳 Pay online through the payment abstraction (mock provider in development)
- 📊 Track an order's full status history (placed → paid → queued → printing → ready → collected)
- ❌ Cancel an order before it starts printing, and request a refund for a cancelled, paid order

### 🏪 Shop Staff Features

- 📥 View the shop's print queue
- ▶️ Start the next waiting order (only one order prints per shop at a time)
- ✅ Mark an order ready, then collected
- 💲 Manage the shop's own per-page pricing and finishing rules

### 🛡️ Admin Features

- 🏬 Create and manage shops
- 👤 Create and manage Shop Staff and Faculty accounts, including shop assignment
- 💲 Manage pricing/finishing rules for any shop
- 💰 Process refund requests
- 📊 View every order across every shop

### ⚙️ Queue Management

Each shop's print queue is **strict first-in-first-out (FIFO)**, ordered by the time an order is confirmed for printing. There is no priority-based or dynamic scheduling in the current implementation.

---

## 🔄 System Workflow

```text
Student / Faculty
   │
   ▼
Login
   │
   ▼
Upload Document
   │
   ▼
Select Shop & Print Options
   │
   ▼
Order Created (PLACED) — price resolved server-side
   │
   ├── Faculty at CSE shop → total = 0, skip payment
   │
   ▼
Pay Online (PAYMENT_CONFIRMED)
   │
   ▼
Order Enters Shop's FIFO Queue (QUEUED)
   │
   ▼
Shop Staff Starts Printing (PRINTING)
   │
   ▼
Marked Ready (READY)
   │
   ▼
Collected (COLLECTED)

   (At any point before PRINTING: Cancel → CANCELLED → optional Refund Request → Admin processes it)
```

---

## 🛠️ Tech Stack

- **Frontend:** React 19, TypeScript, Vite, React Router
- **Backend:** Node.js, Express, TypeScript (route/controller/service layers)
- **Database:** PostgreSQL, managed through Prisma ORM migrations
- **Auth:** JSON Web Tokens, bcrypt-hashed passwords
- **File handling:** Multer, with per-type processors for page-count extraction
- **Testing:** Jest (backend integration tests), Vitest (frontend unit tests)
- **Deployment:** Dockerfiles provided for both frontend and backend

---

## 🚀 Getting Started

### 1. Database

Either install PostgreSQL locally, **or** start one with Docker:

```bash
cd code
docker compose up db -d
```

### 2. Backend

```bash
cd code/backend
cp .env.example .env      # fill in DATABASE_URL to match your Postgres install
npm install
npx prisma migrate dev
npx prisma db seed        # creates demo accounts, see .env.example for the list
npm run dev               # http://localhost:4000
```

### 3. Frontend

```bash
cd code/frontend
npm install
npm run dev                # http://localhost:5173 (proxies /api to the backend)
```

Log in with any seeded account from `code/backend/.env.example` (all share the password `DevPassword123!`).

---

## ⚠️ Out of Scope (Current Build)

The following are **not** implemented, by design, in the current codebase:

- Real payment gateway integration (a mock/simulated provider is used)
- Priority-based or dynamic queue scheduling (FIFO only)
- Reprint requests or collection QR codes/tokens
