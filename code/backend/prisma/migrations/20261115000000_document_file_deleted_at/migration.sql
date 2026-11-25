-- AlterTable
ALTER TABLE "documents" ADD COLUMN "file_deleted_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "documents_file_deleted_at_uploaded_at_idx" ON "documents"("file_deleted_at", "uploaded_at");
