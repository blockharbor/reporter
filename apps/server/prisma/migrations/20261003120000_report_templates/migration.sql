-- Report templates: the site-wide library of named, reusable report
-- configurations. Global rather than engagement-scoped, so any engagement can
-- apply one or generate with it; `name` is unique because it is how a template is
-- named in the Reports tab. `config` is a reportTemplateConfigSchema payload (the
-- engagement report configuration minus `readinessNa`, which stays per-engagement
-- bookkeeping). `uuid` gets no DB default: Prisma's @default(uuid()) is generated
-- client-side, like every other uuid column here.

-- CreateTable
CREATE TABLE "report_templates" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "config" JSONB NOT NULL,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_templates_uuid_key" ON "report_templates"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "report_templates_name_key" ON "report_templates"("name");

-- AddForeignKey
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
