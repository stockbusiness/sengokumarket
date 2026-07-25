-- CreateTable
CREATE TABLE "order_wallet_transactions" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "outbox_event_id" UUID NOT NULL,
    "product_integration_rule_id" UUID,
    "common_user_id" TEXT,
    "transaction_type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reward_rule_id" TEXT,
    "wallet_transaction_id" TEXT,
    "original_wallet_transaction_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'succeeded',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_wallet_transactions_idempotency_key_key" ON "order_wallet_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "order_wallet_transactions_order_item_id_transaction_type_idx" ON "order_wallet_transactions"("order_item_id", "transaction_type");

-- CreateIndex
CREATE INDEX "order_wallet_transactions_original_wallet_transaction_id_idx" ON "order_wallet_transactions"("original_wallet_transaction_id");

-- AddForeignKey
ALTER TABLE "order_wallet_transactions" ADD CONSTRAINT "order_wallet_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_wallet_transactions" ADD CONSTRAINT "order_wallet_transactions_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_wallet_transactions" ADD CONSTRAINT "order_wallet_transactions_outbox_event_id_fkey" FOREIGN KEY ("outbox_event_id") REFERENCES "integration_outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
