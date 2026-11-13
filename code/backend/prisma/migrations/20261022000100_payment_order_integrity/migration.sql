-- Phase 2: database-enforced payment / refund / order invariants.
--
-- Every rule below already holds in application code (order.service.ts,
-- payment.service.ts, refund.service.ts, pricing.service.ts); this migration
-- makes PostgreSQL refuse the states those checks are meant to prevent, so a
-- bug, a manual edit or a missed race cannot store them.
--
-- Prisma cannot express partial unique indexes or CHECK constraints; they
-- live only in this file (see backend/README.md).
--
-- Not enforced here, because a plain constraint cannot express it (it would
-- need a trigger): orders.total_amount = SUM(order_documents.line_total) and
-- payments.amount = orders.total_amount. Both are written once, inside one
-- transaction, from the same computed values.
--
-- Nothing here deletes or rewrites existing rows. If historical data
-- violates a rule, the preflight below aborts the whole migration (it runs
-- in one transaction) and names the rule, so the data can be fixed by hand.

DO $$
DECLARE
  problems text := '';
  n integer;
BEGIN
  SELECT count(*) INTO n FROM (SELECT order_id FROM payments WHERE payment_status = 'PENDING' GROUP BY order_id HAVING count(*) > 1) t;
  IF n > 0 THEN problems := problems || format(E'\n  - %s order(s) with more than one PENDING payment', n); END IF;

  SELECT count(*) INTO n FROM (SELECT order_id FROM payments WHERE payment_status = 'SUCCESS' GROUP BY order_id HAVING count(*) > 1) t;
  IF n > 0 THEN problems := problems || format(E'\n  - %s order(s) with more than one SUCCESS payment', n); END IF;

  SELECT count(*) INTO n FROM (SELECT payment_id FROM refunds WHERE refund_status IN ('REQUESTED', 'PROCESSED') GROUP BY payment_id HAVING count(*) > 1) t;
  IF n > 0 THEN problems := problems || format(E'\n  - %s payment(s) with more than one active (REQUESTED/PROCESSED) refund', n); END IF;

  SELECT count(*) INTO n FROM orders WHERE total_amount < 0;
  IF n > 0 THEN problems := problems || format(E'\n  - %s order(s) with a negative total_amount', n); END IF;

  SELECT count(*) INTO n FROM orders WHERE (order_status = 'CANCELLED') <> (cancelled_at IS NOT NULL);
  IF n > 0 THEN problems := problems || format(E'\n  - %s order(s) where cancelled_at disagrees with order_status', n); END IF;

  SELECT count(*) INTO n FROM order_documents
  WHERE copies < 1 OR print_page_count < 1 OR price_per_page < 0 OR finishing_price < 0 OR line_total < 0;
  IF n > 0 THEN problems := problems || format(E'\n  - %s order_documents row(s) with copies/page count < 1 or a negative price', n); END IF;

  SELECT count(*) INTO n FROM payments
  WHERE amount < 0 OR (payment_status = 'SUCCESS') <> (paid_at IS NOT NULL);
  IF n > 0 THEN problems := problems || format(E'\n  - %s payment(s) with a negative amount or paid_at disagreeing with payment_status', n); END IF;

  SELECT count(*) INTO n FROM refunds
  WHERE refund_amount < 0 OR (refund_status = 'REQUESTED') <> (processed_at IS NULL);
  IF n > 0 THEN problems := problems || format(E'\n  - %s refund(s) with a negative amount or processed_at disagreeing with refund_status', n); END IF;

  SELECT count(*) INTO n FROM shop_pricing_rules
  WHERE price_per_page < 0 OR (effective_to IS NOT NULL AND effective_to < effective_from);
  IF n > 0 THEN problems := problems || format(E'\n  - %s shop_pricing_rules row(s) with a negative price or effective_to before effective_from', n); END IF;

  SELECT count(*) INTO n FROM shop_finishing_rules
  WHERE price < 0 OR (effective_to IS NOT NULL AND effective_to < effective_from);
  IF n > 0 THEN problems := problems || format(E'\n  - %s shop_finishing_rules row(s) with a negative price or effective_to before effective_from', n); END IF;

  IF problems <> '' THEN
    RAISE EXCEPTION 'payment_order_integrity: existing data violates the new constraints; fix it and re-run:%', problems;
  END IF;
END $$;

-- At most one in-flight payment per order (initiatePayment checks this under
-- the order lock; this is the database backstop).
CREATE UNIQUE INDEX "payments_one_pending_per_order" ON "payments"("order_id") WHERE "payment_status" = 'PENDING';

-- At most one successful payment per order: once a payment succeeds the
-- order leaves PLACED and is no longer payable (PAYABLE_ORDER_STATUSES).
CREATE UNIQUE INDEX "payments_one_success_per_order" ON "payments"("order_id") WHERE "payment_status" = 'SUCCESS';

-- At most one active refund per payment (requestRefund checks this under the
-- payment row lock). A FAILED refund does not count, so a retry stays possible.
CREATE UNIQUE INDEX "refunds_one_active_per_payment" ON "refunds"("payment_id") WHERE "refund_status" IN ('REQUESTED', 'PROCESSED');

ALTER TABLE "orders" ADD CONSTRAINT "orders_total_amount_non_negative" CHECK ("total_amount" >= 0);

-- cancelled_at is set exactly by the transition to CANCELLED (cancelOrder).
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancelled_at_matches_status" CHECK (("order_status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL));

-- copies / page counts are validated >= 1 at order creation; prices are
-- snapshots of rules that may be 0 (free finishing) but never negative.
ALTER TABLE "order_documents" ADD CONSTRAINT "order_documents_copies_positive" CHECK ("copies" >= 1);
ALTER TABLE "order_documents" ADD CONSTRAINT "order_documents_print_page_count_positive" CHECK ("print_page_count" >= 1);
ALTER TABLE "order_documents" ADD CONSTRAINT "order_documents_prices_non_negative" CHECK ("price_per_page" >= 0 AND "finishing_price" >= 0 AND "line_total" >= 0);

ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_non_negative" CHECK ("amount" >= 0);
-- paid_at is set exactly when a payment settles to SUCCESS (confirmPayment).
ALTER TABLE "payments" ADD CONSTRAINT "payments_paid_at_matches_status" CHECK (("payment_status" = 'SUCCESS') = ("paid_at" IS NOT NULL));

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_non_negative" CHECK ("refund_amount" >= 0);
-- processed_at is set when a refund leaves REQUESTED (processRefund).
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_processed_at_matches_status" CHECK (("refund_status" = 'REQUESTED') = ("processed_at" IS NULL));

-- Prices are validated >= 0 (zero is allowed). effective_to == effective_from
-- is legal: it is how a rule is closed the instant it starts (see
-- assertValidDeactivationDate in pricing.service.ts).
ALTER TABLE "shop_pricing_rules" ADD CONSTRAINT "shop_pricing_rules_price_non_negative" CHECK ("price_per_page" >= 0);
ALTER TABLE "shop_pricing_rules" ADD CONSTRAINT "shop_pricing_rules_effective_range" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");
ALTER TABLE "shop_finishing_rules" ADD CONSTRAINT "shop_finishing_rules_price_non_negative" CHECK ("price" >= 0);
ALTER TABLE "shop_finishing_rules" ADD CONSTRAINT "shop_finishing_rules_effective_range" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");
