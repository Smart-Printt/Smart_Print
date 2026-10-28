-- CreateIndex
CREATE INDEX "orders_user_id_order_status_created_at_idx" ON "orders"("user_id", "order_status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "orders_shop_id_order_status_created_at_idx" ON "orders"("shop_id", "order_status", "created_at" DESC);
