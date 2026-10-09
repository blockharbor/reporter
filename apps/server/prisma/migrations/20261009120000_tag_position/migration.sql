-- Tag ordering. Tags carry an explicit per-engagement `position` so the order they
-- appear in pickers, in chips and in the Settings list is curated by the team
-- rather than alphabetical. Backfilled from the old ordering (name, then id) and
-- read as `ORDER BY position, name`, so every existing engagement's tag list comes
-- back in exactly the order it did before this migration ran.
--
-- The plain `engagement_id` index is replaced rather than supplemented: a
-- composite on `(engagement_id, position)` serves the engagement-only lookups as a
-- prefix, and `tags_engagement_id_name_key` already covers that prefix anyway.
-- This mirrors 20260814205125_findings_severity_reorder, which swapped
-- `findings_engagement_id_idx` for `findings_engagement_id_position_idx`.

-- AlterTable
ALTER TABLE "tags" ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- DropIndex
DROP INDEX "tags_engagement_id_idx";

-- CreateIndex
CREATE INDEX "tags_engagement_id_position_idx" ON "tags"("engagement_id", "position");

-- Backfill: preserve today's alphabetical order as the initial curated order.
UPDATE "tags" t
SET "position" = sub.rn
FROM (
  SELECT id, (row_number() OVER (PARTITION BY "engagement_id" ORDER BY "name", id) - 1) AS rn
  FROM "tags"
) sub
WHERE t.id = sub.id;
