import type { FastifyInstance } from 'fastify';
import { createReportTemplateInput, updateReportTemplateInput } from '@reporter/shared';
import { requireAuth, requireReportTemplateManager } from '../../auth/guards.js';
import {
  createReportTemplate,
  deleteReportTemplate,
  listReportTemplates,
  updateReportTemplate,
} from '../../services/report-templates.js';

/** Managing the library needs a report-writing role; see the guard for why not admin-only. */
const manageGuard = [requireAuth, requireReportTemplateManager];

/**
 * Report templates: the site-wide library of named report configurations. Not
 * nested under `/engagements/:slug` — a template belongs to no engagement, and the
 * whole point is that every engagement draws on the same library.
 *
 * Read is open to any authenticated user because using a template (apply it to an
 * engagement, or generate one report with it) is an ordinary reporting action;
 * only changing the library itself is gated.
 */
export async function reportTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/report-templates', { preHandler: [requireAuth] }, async () => {
    return listReportTemplates(app);
  });

  app.post('/report-templates', { preHandler: manageGuard }, async (req, reply) => {
    const input = createReportTemplateInput.parse(req.body);
    const created = await createReportTemplate(app, input, req.authedUser!.id);
    reply.status(201);
    return created;
  });

  app.put('/report-templates/:uuid', { preHandler: manageGuard }, async (req) => {
    const { uuid } = req.params as { uuid: string };
    const input = updateReportTemplateInput.parse(req.body);
    return updateReportTemplate(app, uuid, input);
  });

  app.delete('/report-templates/:uuid', { preHandler: manageGuard }, async (req) => {
    const { uuid } = req.params as { uuid: string };
    await deleteReportTemplate(app, uuid);
    return { ok: true };
  });
}
