-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('STUDENT', 'SHOP_STAFF', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PrintType" AS ENUM ('BW', 'COLOR');

-- CreateEnum
CREATE TYPE "PaperSize" AS ENUM ('A4', 'A3', 'LETTER');

-- CreateEnum
CREATE TYPE "Sides" AS ENUM ('SINGLE', 'DOUBLE');

-- CreateEnum
CREATE TYPE "FinishingType" AS ENUM ('NONE', 'STAPLING', 'SPIRAL_BINDING', 'HARD_BINDING', 'LAMINATION');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'PAYMENT_CONFIRMED', 'QUEUED', 'PRINTING', 'READY', 'COLLECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('WAITING', 'PRINTING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PROCESSED', 'FAILED');

-- CreateTable
CREATE TABLE "user" (
    "user_id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "shop_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "document" (
    "document_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_url" TEXT NOT NULL,
    "page_count" INTEGER NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "print_shop" (
    "shop_id" SERIAL NOT NULL,
    "shop_code" TEXT NOT NULL,
    "shop_name" TEXT NOT NULL,
    "location" TEXT,
    "contact" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "accepting_orders" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "print_shop_pkey" PRIMARY KEY ("shop_id")
);

-- CreateTable
CREATE TABLE "shop_pricing_rule" (
    "pricing_rule_id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "print_type" "PrintType" NOT NULL,
    "paper_size" "PaperSize" NOT NULL,
    "sides" "Sides" NOT NULL,
    "price_per_page" DECIMAL(10,2) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),

    CONSTRAINT "shop_pricing_rule_pkey" PRIMARY KEY ("pricing_rule_id")
);

-- CreateTable
CREATE TABLE "shop_finishing_rule" (
    "finishing_rule_id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "finishing_type" "FinishingType" NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),

    CONSTRAINT "shop_finishing_rule_pkey" PRIMARY KEY ("finishing_rule_id")
);

-- CreateTable
CREATE TABLE "order" (
    "order_id" SERIAL NOT NULL,
    "order_code" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "order_status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "total_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,

    CONSTRAINT "order_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "order_document" (
    "order_document_id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "document_id" INTEGER NOT NULL,
    "pricing_rule_id" INTEGER NOT NULL,
    "finishing_rule_id" INTEGER,
    "copies" INTEGER NOT NULL,
    "price_per_page" DECIMAL(10,2) NOT NULL,
    "finishing_price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "order_document_pkey" PRIMARY KEY ("order_document_id")
);

-- CreateTable
CREATE TABLE "queue" (
    "queue_id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "queue_number" INTEGER NOT NULL,
    "queue_status" "QueueStatus" NOT NULL DEFAULT 'WAITING',
    "entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "queue_pkey" PRIMARY KEY ("queue_id")
);

-- CreateTable
CREATE TABLE "payment" (
    "payment_id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "payment_method" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "payment_pkey" PRIMARY KEY ("payment_id")
);

-- CreateTable
CREATE TABLE "refund" (
    "refund_id" SERIAL NOT NULL,
    "payment_id" INTEGER NOT NULL,
    "refund_amount" DECIMAL(10,2) NOT NULL,
    "refund_reason" TEXT NOT NULL,
    "refund_status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "refund_transaction_id" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "refund_pkey" PRIMARY KEY ("refund_id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "history_id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "changed_by_user_id" INTEGER,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("history_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_email_idx" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_shop_id_idx" ON "user"("shop_id");

-- CreateIndex
CREATE INDEX "document_user_id_idx" ON "document"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "print_shop_shop_code_key" ON "print_shop"("shop_code");

-- CreateIndex
CREATE INDEX "print_shop_shop_code_idx" ON "print_shop"("shop_code");

-- CreateIndex
CREATE INDEX "shop_pricing_rule_shop_id_print_type_paper_size_sides_idx" ON "shop_pricing_rule"("shop_id", "print_type", "paper_size", "sides");

-- CreateIndex
CREATE INDEX "shop_finishing_rule_shop_id_finishing_type_idx" ON "shop_finishing_rule"("shop_id", "finishing_type");

-- CreateIndex
CREATE UNIQUE INDEX "order_order_code_key" ON "order"("order_code");

-- CreateIndex
CREATE INDEX "order_user_id_idx" ON "order"("user_id");

-- CreateIndex
CREATE INDEX "order_shop_id_idx" ON "order"("shop_id");

-- CreateIndex
CREATE INDEX "order_shop_id_order_status_idx" ON "order"("shop_id", "order_status");

-- CreateIndex
CREATE INDEX "order_document_order_id_idx" ON "order_document"("order_id");

-- CreateIndex
CREATE INDEX "order_document_document_id_idx" ON "order_document"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "queue_order_id_key" ON "queue"("order_id");

-- CreateIndex
CREATE INDEX "queue_queue_status_entered_at_idx" ON "queue"("queue_status", "entered_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transaction_id_key" ON "payment"("transaction_id");

-- CreateIndex
CREATE INDEX "payment_order_id_idx" ON "payment"("order_id");

-- CreateIndex
CREATE INDEX "payment_transaction_id_idx" ON "payment"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "refund_refund_transaction_id_key" ON "refund"("refund_transaction_id");

-- CreateIndex
CREATE INDEX "refund_payment_id_idx" ON "refund"("payment_id");

-- CreateIndex
CREATE INDEX "order_status_history_order_id_idx" ON "order_status_history"("order_id");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "print_shop"("shop_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_pricing_rule" ADD CONSTRAINT "shop_pricing_rule_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "print_shop"("shop_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_finishing_rule" ADD CONSTRAINT "shop_finishing_rule_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "print_shop"("shop_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "print_shop"("shop_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_document" ADD CONSTRAINT "order_document_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_document" ADD CONSTRAINT "order_document_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("document_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_document" ADD CONSTRAINT "order_document_pricing_rule_id_fkey" FOREIGN KEY ("pricing_rule_id") REFERENCES "shop_pricing_rule"("pricing_rule_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_document" ADD CONSTRAINT "order_document_finishing_rule_id_fkey" FOREIGN KEY ("finishing_rule_id") REFERENCES "shop_finishing_rule"("finishing_rule_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue" ADD CONSTRAINT "queue_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("payment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Native sequence backing the human-readable queue token (queue_number).
-- FIFO order itself is always determined by queue.entered_at, never by this
-- value -- it only needs to be a safe, ever-increasing token. Using a
-- sequence (instead of MAX(queue_number)+1) makes reservation atomic under
-- concurrent payment confirmations.
CREATE SEQUENCE IF NOT EXISTS queue_number_seq START WITH 1 INCREMENT BY 1;

-- Business rule: only one payment per order may be SUCCESS.
-- A partial unique index enforces this at the database level regardless of
-- application-level bugs/races -- Prisma's schema DSL has no way to express
-- a partial unique index, so it is added here directly.
CREATE UNIQUE INDEX "payment_order_id_success_unique"
  ON "payment" ("order_id")
  WHERE "payment_status" = 'SUCCESS';

-- CHECK constraints not expressible in the Prisma schema DSL.
ALTER TABLE "shop_pricing_rule"
  ADD CONSTRAINT "pricing_rule_valid_range"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");

ALTER TABLE "shop_finishing_rule"
  ADD CONSTRAINT "finishing_rule_valid_range"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");

ALTER TABLE "order_document"
  ADD CONSTRAINT "order_document_copies_positive"
  CHECK ("copies" > 0);

ALTER TABLE "refund"
  ADD CONSTRAINT "refund_amount_positive"
  CHECK ("refund_amount" > 0);
