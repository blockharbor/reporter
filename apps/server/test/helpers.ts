import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createLocalUser } from '../src/services/users.js';
import { generateApiKey } from '../src/services/apikeys.js';

const TABLES = [
  'goal_evidence',
  'goal_findings',
  'activity_goals',
  'target_activities',
  'engagement_targets',
  'evidence_findings',
  'evidence_tags',
  'finding_tags',
  'evidence_metadata',
  'evidence',
  'findings',
  'finding_categories',
  'generated_reports',
  'report_templates',
  'saved_queries',
  'tags',
  'default_tags',
  'user_engagement_prefs',
  'user_engagement_roles',
  'engagements',
  'sessions',
  'api_keys',
  'recovery_codes',
  'webauthn_credentials',
  'auth_identities',
  'users',
];

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = await buildApp(loadConfig(process.env));
  await app.ready();
  return app;
}

export async function truncateAll(app: FastifyInstance): Promise<void> {
  await app.db.$executeRawUnsafe(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

/** Log in a user over the web plane and return the session cookie header value. */
export async function loginCookie(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/web/login',
    headers: { 'x-requested-with': 'XMLHttpRequest' },
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
  return raw.split(';')[0]!; // "reporter_session=..."
}

/** Create a standard cast of users for tests. */
export async function seedUsers(app: FastifyInstance) {
  const admin = await createLocalUser(app.db, {
    firstName: 'Ada',
    lastName: 'Admin',
    email: 'admin@test.local',
    password: 'password123',
    admin: true,
  });
  const writer = await createLocalUser(app.db, {
    firstName: 'Wendy',
    lastName: 'Writer',
    email: 'writer@test.local',
    password: 'password123',
  });
  const reader = await createLocalUser(app.db, {
    firstName: 'Ravi',
    lastName: 'Reader',
    email: 'reader@test.local',
    password: 'password123',
  });
  return { admin, writer, reader };
}

export async function apiKeyFor(app: FastifyInstance, userId: number) {
  return generateApiKey(app.db, userId);
}

export const WEB_HEADERS = { 'x-requested-with': 'XMLHttpRequest' };
