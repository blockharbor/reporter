import type { FastifyInstance } from 'fastify';
import { HttpError } from '../../auth/guards.js';
import { authRoutes } from './auth.js';
import { engagementRoutes } from './engagements.js';
import { evidenceRoutes } from './evidence.js';
import { findingRoutes } from './findings.js';
import { goalRoutes } from './goals.js';
import { reportRoutes } from './report.js';
import { reportSettingsRoutes } from './report-settings.js';
import { reportTemplateRoutes } from './report-templates.js';
import { tagRoutes } from './tags.js';
import { categoryRoutes } from './finding-categories.js';
import { queryRoutes } from './queries.js';
import { adminRoutes } from './admin.js';
import { accountRoutes } from './account.js';

/** Registers the web plane (`/web/*`) — session-cookie auth + CSRF guard. */
export async function registerWebRoutes(app: FastifyInstance): Promise<void> {
  // CSRF: browsers won't send a custom header cross-origin, so requiring one on
  // mutations (alongside SameSite=Lax cookies) blocks CSRF cheaply.
  app.addHook('preHandler', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (!req.headers['x-requested-with']) {
      throw new HttpError(403, 'Missing X-Requested-With header');
    }
  });

  await app.register(authRoutes);
  await app.register(engagementRoutes);
  await app.register(evidenceRoutes);
  await app.register(findingRoutes);
  await app.register(goalRoutes);
  await app.register(reportRoutes);
  await app.register(reportSettingsRoutes);
  await app.register(reportTemplateRoutes);
  await app.register(tagRoutes);
  await app.register(categoryRoutes);
  await app.register(queryRoutes);
  await app.register(adminRoutes);
  await app.register(accountRoutes);
}
