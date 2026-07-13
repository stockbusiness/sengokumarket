-- CreateTable
CREATE TABLE "wallet_reminder_emails" (
    "id" UUID NOT NULL,
    "nft_issue_id" UUID NOT NULL,
    "sent_by" UUID NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_reminder_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wallet_reminder_emails_nft_issue_id_idx" ON "wallet_reminder_emails"("nft_issue_id");

-- AddForeignKey
ALTER TABLE "wallet_reminder_emails" ADD CONSTRAINT "wallet_reminder_emails_nft_issue_id_fkey" FOREIGN KEY ("nft_issue_id") REFERENCES "nft_issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_reminder_emails" ADD CONSTRAINT "wallet_reminder_emails_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
