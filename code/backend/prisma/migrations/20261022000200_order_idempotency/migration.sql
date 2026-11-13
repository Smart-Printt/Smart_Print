-- Phase 2: duplicate-order protection for POST /api/orders.
--
-- A client may send an Idempotency-Key header. The key and a fingerprint of
-- the request are stored on the order itself, in the same transaction that
-- creates it, so "the key is recorded" and "the order exists" can never
-- disagree. The unique index is what makes concurrent duplicates safe: two
-- simultaneous requests with the same (user, key) cannot both insert.
--
-- Existing orders keep both columns NULL (no key was ever supplied).
ALTER TABLE "orders" ADD COLUMN "idempotency_key" TEXT,
ADD COLUMN "idempotency_request_hash" TEXT;

-- NULL keys are distinct in PostgreSQL, so unkeyed orders never collide.
CREATE UNIQUE INDEX "orders_user_id_idempotency_key_key" ON "orders"("user_id", "idempotency_key");

-- A key and its request hash exist together or not at all.
ALTER TABLE "orders" ADD CONSTRAINT "orders_idempotency_pair" CHECK (("idempotency_key" IS NULL) = ("idempotency_request_hash" IS NULL));

-- Same format the API accepts (utils/idempotency.ts): 8-128 chars from
-- [A-Za-z0-9._~:-]; the hash is a lowercase SHA-256 hex digest.
ALTER TABLE "orders" ADD CONSTRAINT "orders_idempotency_key_format" CHECK ("idempotency_key" IS NULL OR "idempotency_key" ~ '^[A-Za-z0-9._~:-]{8,128}$');
ALTER TABLE "orders" ADD CONSTRAINT "orders_idempotency_hash_format" CHECK ("idempotency_request_hash" IS NULL OR "idempotency_request_hash" ~ '^[0-9a-f]{64}$');
