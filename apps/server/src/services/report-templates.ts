/**
 * Report templates: the site-wide library of named report configurations.
 *
 * A template is global, not engagement-scoped — the point is that a teammate on
 * any engagement can produce the same kind of report. It stores a
 * `reportTemplateConfigSchema` payload: the whole engagement report configuration
 * except `readinessNa`, which stays per-engagement bookkeeping and is neither
 * captured here nor touched when a template is applied.
 *
 * Nothing in this module reads or writes an engagement. "Save as template"
 * snapshots a configuration the caller hands in, and "apply" is the client writing
 * the engagement's own `reportConfig` — so a template can never silently mutate an
 * engagement, and generating with one (see routes/web/report.ts) affects that run
 * only.
 */
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import type {
  CreateReportTemplateInput,
  ReportTemplate,
  ReportTemplateConfig,
  UpdateReportTemplateInput,
} from '@reporter/shared';
import { reportTemplateConfigSchema } from '@reporter/shared';
import { HttpError } from '../auth/guards.js';
import { serializeReportTemplate } from './serializers.js';

/** Resolve the author byline every template response carries. */
const templateInclude = {
  createdBy: { select: { slug: true, firstName: true, lastName: true } },
} as const;

/** Message for a name collision, so the pre-check and the race both say it once. */
const DUPLICATE_NAME = 'A report template with that name already exists';

/**
 * Turn Prisma's unique-constraint violation on `name` into the same clean 409 the
 * pre-check raises. The pre-check (matching the duplicate-slug handling in
 * routes/web/engagements.ts) answers the ordinary case; this closes the window
 * between that check and the write, where two concurrent saves of the same name
 * would otherwise surface as a 500.
 */
function rethrowDuplicateName(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new HttpError(409, DUPLICATE_NAME);
  }
  throw err;
}

/** Every template, alphabetical — the order the Reports tab lists them in. */
export async function listReportTemplates(app: FastifyInstance): Promise<ReportTemplate[]> {
  const rows = await app.db.reportTemplate.findMany({
    orderBy: { name: 'asc' },
    include: templateInclude,
  });
  return rows.map(serializeReportTemplate);
}

/** One template by uuid, or a 404. */
export async function getReportTemplate(
  app: FastifyInstance,
  uuid: string,
): Promise<ReportTemplate> {
  const row = await app.db.reportTemplate.findUnique({
    where: { uuid },
    include: templateInclude,
  });
  if (!row) throw new HttpError(404, 'Report template not found');
  return serializeReportTemplate(row);
}

/**
 * The configuration a named template supplies to a single report generation. An
 * unknown uuid is a 404 rather than a quiet fall back to the engagement's own
 * config: a caller that asked for a specific template must never be handed a
 * different report than the one it named.
 */
export async function getReportTemplateConfig(
  app: FastifyInstance,
  uuid: string,
): Promise<{ name: string; config: ReportTemplateConfig }> {
  const row = await app.db.reportTemplate.findUnique({ where: { uuid } });
  if (!row) throw new HttpError(404, 'Report template not found');
  return { name: row.name, config: reportTemplateConfigSchema.parse(row.config ?? {}) };
}

export async function createReportTemplate(
  app: FastifyInstance,
  input: CreateReportTemplateInput,
  createdById: number,
): Promise<ReportTemplate> {
  const existing = await app.db.reportTemplate.findUnique({ where: { name: input.name } });
  if (existing) throw new HttpError(409, DUPLICATE_NAME);
  const created = await app.db.reportTemplate
    .create({
      data: {
        name: input.name,
        description: input.description,
        // The parsed config is a plain JSON object; Prisma's Json input type can't
        // see that through zod's inferred type, hence the one cast.
        config: input.config as unknown as Prisma.InputJsonObject,
        createdById,
      },
      include: templateInclude,
    })
    .catch(rethrowDuplicateName);
  return serializeReportTemplate(created);
}

export async function updateReportTemplate(
  app: FastifyInstance,
  uuid: string,
  input: UpdateReportTemplateInput,
): Promise<ReportTemplate> {
  const row = await app.db.reportTemplate.findUnique({ where: { uuid } });
  if (!row) throw new HttpError(404, 'Report template not found');
  if (input.name !== undefined && input.name !== row.name) {
    const clash = await app.db.reportTemplate.findUnique({ where: { name: input.name } });
    if (clash) throw new HttpError(409, DUPLICATE_NAME);
  }
  const updated = await app.db.reportTemplate
    .update({
      where: { id: row.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.config !== undefined
          ? { config: input.config as unknown as Prisma.InputJsonObject }
          : {}),
      },
      include: templateInclude,
    })
    .catch(rethrowDuplicateName);
  return serializeReportTemplate(updated);
}

/**
 * Delete a template. Engagements that applied it keep the configuration they were
 * given — applying copies into the engagement's own `reportConfig` — so deleting a
 * template only removes the library entry, never changes a report.
 */
export async function deleteReportTemplate(app: FastifyInstance, uuid: string): Promise<void> {
  const row = await app.db.reportTemplate.findUnique({ where: { uuid } });
  if (!row) throw new HttpError(404, 'Report template not found');
  await app.db.reportTemplate.delete({ where: { id: row.id } });
}
