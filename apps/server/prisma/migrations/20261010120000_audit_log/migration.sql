-- Audit log: one row per recorded event — content writes, sign-in events and
-- the reads that hand data out. Append-only forever: there is no retention
-- window and no pruning route, and the guard trigger at the bottom makes that a
-- database rule rather than an application convention. See `model AuditEntry`
-- in schema.prisma for the full reasoning (snapshots, coalescing, removal).
--
-- `via`, `action`, `entity_type` and `source` are TEXT closed by zod enums in
-- @reporter/shared, as `generated_reports.preset`/`format` are, so a new entity
-- type or action needs no ALTER TYPE. `uuid` gets no DB default: Prisma's
-- @default(uuid()) is generated client-side, like every other uuid column here.
--
-- Purely additive — no backfill, no change to an existing table — so it is safe
-- to apply to a live database. Nothing before this migration can be
-- reconstructed into the log; the UI says so rather than implying completeness.
--
-- Hand-named 20261010120000 so it sorts after 20261009130000_finding_tags.

-- CreateTable
CREATE TABLE "audit_entries" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "engagement_id" INTEGER,
    "engagement_slug" TEXT,
    "engagement_name" TEXT,
    "actor_id" INTEGER,
    "actor_name" TEXT,
    "actor_email" TEXT,
    "via" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "entity_label" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL,
    "changes" JSONB NOT NULL DEFAULT '[]',
    "coalesce_key" TEXT,
    "coalesced_count" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'intent',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "deleted_by_id" INTEGER,
    "deleted_by_name" TEXT,
    "deleted_by_email" TEXT,
    "deleted_reason" TEXT,

    CONSTRAINT "audit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_entries_uuid_key" ON "audit_entries"("uuid");

-- CreateIndex
CREATE INDEX "audit_entries_engagement_id_created_at_idx" ON "audit_entries"("engagement_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_entries_created_at_idx" ON "audit_entries"("created_at");

-- CreateIndex
CREATE INDEX "audit_entries_actor_id_created_at_idx" ON "audit_entries"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_entries_action_created_at_idx" ON "audit_entries"("action", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_entries_actor_name_created_at_idx" ON "audit_entries"("actor_name", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_entries_entity_type_entity_id_created_at_idx" ON "audit_entries"("entity_type", "entity_id", "created_at");

-- CreateIndex
-- Prisma's name for this index: it truncates to Postgres's 63-character limit
-- while keeping the `_idx` suffix, so the full column list does not fit.
CREATE INDEX "audit_entries_actor_id_entity_type_entity_id_coalesce_key_c_idx" ON "audit_entries"("actor_id", "entity_type", "entity_id", "coalesce_key", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_entries_engagement_slug_idx" ON "audit_entries"("engagement_slug");

-- CreateIndex
CREATE INDEX "audit_entries_deleted_by_id_idx" ON "audit_entries"("deleted_by_id");

-- AddForeignKey
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_engagement_id_fkey" FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_deleted_by_id_fkey" FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tamper evidence, enforced here rather than in the service layer (hand-written;
-- Prisma neither generates nor introspects triggers, so this is not drift — but
-- it also means `prisma db push` would create the table WITHOUT this guard. Only
-- the migration path is supported, and the server asserts the trigger at boot).
--
--   * DELETE is refused outright. The only way a row leaves this table is
--     TRUNCATE (which does not fire row triggers — the test harness relies on
--     that) or dropping the database.
--   * A LIVE row is an allowlist, not a free-for-all. It may change in exactly
--     three ways: the coalescing fold (changes, coalesced_count — never
--     decreasing — and last_at — never earlier); a REMOVAL, the transition
--     deleted_at NULL -> NOT NULL, which must carry a non-blank reason and a
--     non-null remover snapshot and must leave no content behind (changes = [],
--     summary = '', entity_label = ''); and a foreign key going to NULL when the
--     actor, remover or engagement is deleted. Everything else — summary, actor
--     snapshot, action, entity, created_at, source — is frozen from the moment
--     the row is written, so nothing can be re-worded through updateMany or raw
--     SQL without the database refusing it.
--   * A REMOVED row is frozen entirely, except for those same referential
--     actions, so deleting the actor, the remover or the engagement later still
--     succeeds. A removal can therefore never be undone or re-worded.
--
-- `to_jsonb(NEW) - <allowed columns>` is compared with the same subtraction on
-- OLD, so the allowlist is the list of subtracted keys and nothing else can move.
CREATE OR REPLACE FUNCTION audit_entries_guard() RETURNS trigger AS $$
DECLARE
  subject_fks_nulling_only boolean;
  deleter_fk_nulling_only boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_entries is append-only: rows are never deleted (remove one instead)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The foreign keys may only ever go to NULL (ON DELETE SET NULL); any other
  -- change to them is a rewrite. The remover's FK is checked separately because
  -- the removal transition is exactly the one write that legitimately SETS it.
  subject_fks_nulling_only :=
        (NEW.engagement_id IS NOT DISTINCT FROM OLD.engagement_id OR NEW.engagement_id IS NULL)
    AND (NEW.actor_id      IS NOT DISTINCT FROM OLD.actor_id      OR NEW.actor_id IS NULL);
  deleter_fk_nulling_only :=
        (NEW.deleted_by_id IS NOT DISTINCT FROM OLD.deleted_by_id OR NEW.deleted_by_id IS NULL);

  IF OLD.deleted_at IS NULL THEN
    IF NEW.deleted_at IS NOT NULL THEN
      -- Removal. Validate what it must carry and what it must not.
      IF NEW.deleted_reason IS NULL OR btrim(NEW.deleted_reason) = ''
         OR NEW.deleted_by_name IS NULL OR NEW.deleted_by_email IS NULL THEN
        RAISE EXCEPTION 'audit_entries: a removal needs a reason and a remover'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.changes <> '[]'::jsonb OR NEW.summary <> '' OR NEW.entity_label <> '' THEN
        RAISE EXCEPTION 'audit_entries: a removed entry carries no content'
          USING ERRCODE = 'check_violation';
      END IF;
      -- Only the removal columns, the blanked content and FK nulling may differ.
      IF NOT subject_fks_nulling_only
         OR (to_jsonb(NEW) - 'changes' - 'summary' - 'entity_label'
                           - 'deleted_at' - 'deleted_by_id' - 'deleted_by_name'
                           - 'deleted_by_email' - 'deleted_reason'
                           - 'engagement_id' - 'actor_id')
            IS DISTINCT FROM
            (to_jsonb(OLD) - 'changes' - 'summary' - 'entity_label'
                           - 'deleted_at' - 'deleted_by_id' - 'deleted_by_name'
                           - 'deleted_by_email' - 'deleted_reason'
                           - 'engagement_id' - 'actor_id') THEN
        RAISE EXCEPTION 'audit_entries: a removal may not rewrite the entry it removes'
          USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN NEW;
    END IF;

    -- A plain update of a live row: only the coalescing fold and FK nulling.
    IF NOT subject_fks_nulling_only OR NOT deleter_fk_nulling_only
       OR NEW.coalesced_count < OLD.coalesced_count
       OR NEW.last_at < OLD.last_at
       OR (to_jsonb(NEW) - 'changes' - 'coalesced_count' - 'last_at'
                         - 'engagement_id' - 'actor_id' - 'deleted_by_id')
          IS DISTINCT FROM
          (to_jsonb(OLD) - 'changes' - 'coalesced_count' - 'last_at'
                         - 'engagement_id' - 'actor_id' - 'deleted_by_id') THEN
      RAISE EXCEPTION 'audit_entries: a live entry may only be folded or removed, never rewritten'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- OLD is removed: frozen except for FK SET NULL.
  IF NOT subject_fks_nulling_only OR NOT deleter_fk_nulling_only
     OR (to_jsonb(NEW) - 'engagement_id' - 'actor_id' - 'deleted_by_id')
        IS DISTINCT FROM
        (to_jsonb(OLD) - 'engagement_id' - 'actor_id' - 'deleted_by_id') THEN
    RAISE EXCEPTION 'audit_entries: a removed entry is frozen'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_entries_guard
  BEFORE UPDATE OR DELETE ON "audit_entries"
  FOR EACH ROW EXECUTE FUNCTION audit_entries_guard();
