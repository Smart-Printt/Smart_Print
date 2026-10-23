-- Phase 2: database-enforced queue integrity.
--
-- Adds queue.shop_id (backfilled from the entry's order) and enforces, in
-- PostgreSQL rather than application code alone:
--   1. queue.shop_id always equals the shop of the entry's order
--      (composite foreign key);
--   2. queue numbers are unique within a shop;
--   3. at most one PRINTING entry per shop (partial unique index);
--   4. queue_number >= 1 and queue_status agrees with the lifecycle
--      timestamps (CHECK constraints).
-- (order_id is already UNIQUE from the init migration, so an order already
-- has at most one queue entry.)
--
-- Prisma cannot express the partial unique index or the CHECK constraints;
-- they live only in this file (see backend/README.md).
--
-- Nothing here deletes or rewrites existing queue rows. If historical data
-- violates a new rule, the preflight checks below abort the whole migration
-- (it runs in one transaction) with a message saying what to fix by hand.

-- Preflight 1: more than one PRINTING entry in the same shop.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT o.shop_id
    FROM queue q JOIN orders o ON o.order_id = q.order_id
    WHERE q.queue_status = 'PRINTING'
    GROUP BY o.shop_id HAVING count(*) > 1
  ) t;
  IF n > 0 THEN
    RAISE EXCEPTION 'queue_integrity: % shop(s) have more than one PRINTING queue entry; resolve them (complete or cancel the extras) and re-run', n;
  END IF;
END $$;

-- Preflight 2: the same queue number used twice within a shop.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT o.shop_id, q.queue_number
    FROM queue q JOIN orders o ON o.order_id = q.order_id
    GROUP BY o.shop_id, q.queue_number HAVING count(*) > 1
  ) t;
  IF n > 0 THEN
    RAISE EXCEPTION 'queue_integrity: % (shop, queue_number) pair(s) are duplicated; renumber them and re-run', n;
  END IF;
END $$;

-- Preflight 3: rows that would violate the new CHECK constraints.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM queue
  WHERE queue_number < 1
     OR NOT (
          (queue_status = 'WAITING'   AND started_at IS NULL     AND completed_at IS NULL     AND cancelled_at IS NULL)
       OR (queue_status = 'PRINTING'  AND started_at IS NOT NULL AND completed_at IS NULL     AND cancelled_at IS NULL)
       OR (queue_status = 'COMPLETED' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND cancelled_at IS NULL)
       OR (queue_status = 'CANCELLED' AND completed_at IS NULL   AND cancelled_at IS NOT NULL)
     );
  IF n > 0 THEN
    RAISE EXCEPTION 'queue_integrity: % queue row(s) have a queue_number < 1 or timestamps that do not match queue_status; fix them and re-run', n;
  END IF;
END $$;

-- Add shop_id nullable, backfill from the order, then make it required.
ALTER TABLE "queue" ADD COLUMN "shop_id" TEXT;

UPDATE "queue" q
SET "shop_id" = o."shop_id"
FROM "orders" o
WHERE o."order_id" = q."order_id";

ALTER TABLE "queue" ALTER COLUMN "shop_id" SET NOT NULL;

-- Unique target for the composite foreign key. order_id is already unique
-- (primary key); PostgreSQL still needs a unique index on exactly
-- (order_id, shop_id) to accept the foreign key below.
CREATE UNIQUE INDEX "orders_order_id_shop_id_key" ON "orders"("order_id", "shop_id");

-- Replace the single-column order foreign key with the composite one:
-- an entry can only reference an order that belongs to the same shop.
-- ON UPDATE RESTRICT: an order's shop never changes, and a queue entry must
-- not silently follow it into a shop where its queue number may collide.
ALTER TABLE "queue" DROP CONSTRAINT "queue_order_id_fkey";

CREATE UNIQUE INDEX "queue_order_id_shop_id_key" ON "queue"("order_id", "shop_id");

ALTER TABLE "queue" ADD CONSTRAINT "queue_order_id_shop_id_fkey"
  FOREIGN KEY ("order_id", "shop_id") REFERENCES "orders"("order_id", "shop_id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

-- Queue numbers are allocated per shop as max + 1 over ALL of the shop's
-- entries (cancelled ones included), so they are unique per shop.
CREATE UNIQUE INDEX "queue_shop_id_queue_number_key" ON "queue"("shop_id", "queue_number");

-- At most one PRINTING entry per shop (single printer per shop). Partial
-- unique index: not expressible in schema.prisma.
CREATE UNIQUE INDEX "queue_one_printing_per_shop" ON "queue"("shop_id") WHERE "queue_status" = 'PRINTING';

ALTER TABLE "queue" ADD CONSTRAINT "queue_number_positive" CHECK ("queue_number" >= 1);

-- Lifecycle timestamps must agree with the status (see queue.service.ts):
-- start-next sets started_at with PRINTING, completion sets completed_at,
-- and only a WAITING entry can be cancelled (so a cancelled entry never has
-- started).
ALTER TABLE "queue" ADD CONSTRAINT "queue_status_timestamps_consistent" CHECK (
     ("queue_status" = 'WAITING'   AND "started_at" IS NULL     AND "completed_at" IS NULL     AND "cancelled_at" IS NULL)
  OR ("queue_status" = 'PRINTING'  AND "started_at" IS NOT NULL AND "completed_at" IS NULL     AND "cancelled_at" IS NULL)
  OR ("queue_status" = 'COMPLETED' AND "started_at" IS NOT NULL AND "completed_at" IS NOT NULL AND "cancelled_at" IS NULL)
  OR ("queue_status" = 'CANCELLED' AND "completed_at" IS NULL   AND "cancelled_at" IS NOT NULL)
);
