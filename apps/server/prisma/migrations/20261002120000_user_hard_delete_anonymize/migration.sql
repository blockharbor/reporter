-- Deleting a user is now a hard delete: the row is really removed and the evidence
-- it captured is anonymized rather than deleted (the evidence is the client
-- deliverable). Both FKs into users were RESTRICT, which blocked the delete, so
-- they become nullable + ON DELETE SET NULL.

-- DropForeignKey
ALTER TABLE "evidence" DROP CONSTRAINT IF EXISTS "evidence_operator_id_fkey";

-- DropForeignKey
ALTER TABLE "evidence_comments" DROP CONSTRAINT IF EXISTS "evidence_comments_author_id_fkey";

-- AlterTable
ALTER TABLE "evidence" ALTER COLUMN "operator_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "evidence_comments" ALTER COLUMN "author_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_comments" ADD CONSTRAINT "evidence_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
