import type { FastifyInstance } from 'fastify';
import type { ReportSettings as DbReportSettings } from '@prisma/client';

/**
 * What the branding row holds before anyone has saved one: the schema defaults
 * (Block Harbor house style), mirrored here so a READ never has to write.
 *
 * It used to be an upsert, which minted the row on first read. That put a
 * write on every report render, and once the audit log arrived it meant the
 * first PDF rendered on a fresh database logged "Created report branding"
 * against whichever operator happened to render it. Now the row exists only
 * once an admin saves branding (`PUT /web/report-settings` upserts it) or the
 * seed creates it, so its creation is attributed to the person who chose it.
 * `updatedAt` is the epoch on the virtual row: nothing has ever updated it.
 */
export const REPORT_SETTINGS_DEFAULTS: DbReportSettings = {
  id: 1,
  organizationName: 'Block Harbor',
  accentColor: '#e82434',
  logoDataUri: null,
  footerNote: null,
  updatedAt: new Date(0),
};

/**
 * The single report-branding row (id = 1), or the defaults when none has been
 * saved yet. Shared by the admin settings route and the PDF report renderer.
 */
export async function getReportSettings(app: FastifyInstance): Promise<DbReportSettings> {
  return (await app.db.reportSettings.findUnique({ where: { id: 1 } })) ?? REPORT_SETTINGS_DEFAULTS;
}
