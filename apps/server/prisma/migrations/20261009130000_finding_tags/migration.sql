-- Finding tags: a finding can now carry the engagement's existing `Tag` labels —
-- the same pool evidence draws from. A pure join table mirroring `evidence_tags`
-- exactly (composite primary key, both foreign keys ON DELETE CASCADE, an index on
-- the non-leading key) rather than a second vocabulary or an applies-to flag on
-- `tags`: one engagement, one set of labels. Deleting a tag therefore strips it
-- from findings as well as evidence, which is what the cascade already meant here.
--
-- Purely additive — no backfill, no data rewrite, no change to an existing table —
-- so it is safe to apply to a live database.

-- CreateTable
CREATE TABLE "finding_tags" (
    "finding_id" INTEGER NOT NULL,
    "tag_id" INTEGER NOT NULL,

    CONSTRAINT "finding_tags_pkey" PRIMARY KEY ("finding_id","tag_id")
);

-- CreateIndex
CREATE INDEX "finding_tags_tag_id_idx" ON "finding_tags"("tag_id");

-- AddForeignKey
ALTER TABLE "finding_tags" ADD CONSTRAINT "finding_tags_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "findings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding_tags" ADD CONSTRAINT "finding_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
