-- AlterTable
ALTER TABLE "documents" ADD COLUMN "print_storage_key" TEXT,
ADD COLUMN "print_file_size" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "documents_print_storage_key_key" ON "documents"("print_storage_key");
