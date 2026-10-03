import type { Prisma, PrismaClient, User } from '@prisma/client';
import { LAST_ADMIN_REASON } from '@reporter/shared';
import { HttpError } from '../auth/guards.js';
import { hashPassword } from '../auth/password.js';
import { slugify, uniqueSlug } from '../helpers/slug.js';

export interface CreateLocalUserArgs {
  firstName: string;
  lastName: string;
  email: string;
  password?: string;
  admin?: boolean;
  headless?: boolean;
  mustResetPassword?: boolean;
}

/**
 * Create a user with a `local` auth identity. Headless users (no password) are
 * used for automated API-only clients. The email is the local identifier.
 */
export async function createLocalUser(db: PrismaClient, args: CreateLocalUserArgs): Promise<User> {
  const slug = await uniqueSlug(
    slugify(`${args.firstName} ${args.lastName}`) || args.email.split('@')[0]!,
    async (s) => (await db.user.count({ where: { slug: s } })) > 0,
  );

  const passwordHash = args.password ? await hashPassword(args.password) : null;

  return db.user.create({
    data: {
      slug,
      firstName: args.firstName,
      lastName: args.lastName,
      email: args.email,
      admin: args.admin ?? false,
      headless: args.headless ?? false,
      identities: {
        create: {
          scheme: 'local',
          identifier: args.email,
          passwordHash,
          mustResetPassword: args.mustResetPassword ?? false,
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Site-admin standing
// ---------------------------------------------------------------------------

/** The fields that decide whether a user can administer the site. */
type AdminStanding = Pick<User, 'admin' | 'disabled' | 'headless' | 'deletedAt'>;

/**
 * Whether this user can actually sign in to the web UI and reach the Admin panel.
 * Disabled users are rejected by the auth guards, headless accounts have no
 * password at all (they exist only for the HMAC client API), and legacy
 * soft-deleted rows are locked out the same way — none of them could rescue a site
 * that had lost its last real admin, so none of them count as one.
 */
function canAdministerSite(u: AdminStanding): boolean {
  return u.admin && !u.disabled && !u.headless && u.deletedAt === null;
}

/**
 * Why `target` must keep its admin standing, or null when the change is safe.
 *
 * `next` is the user's state after the change (`{ admin, disabled }`, both
 * resolved — never `undefined`), or null for a delete. Nothing in the database
 * enforces this, so demoting, disabling or deleting the final admin would
 * otherwise lock everyone out of the Admin panel permanently.
 */
export async function siteAdminBlockReason(
  db: Prisma.TransactionClient,
  target: User,
  next: Pick<User, 'admin' | 'disabled'> | null,
): Promise<string | null> {
  // Only taking away the target's own ability to administer the site can cause a
  // lockout: promotions, and edits to a user who could never reach the Admin panel
  // in the first place, are always safe.
  if (!canAdministerSite(target)) return null;
  if (next !== null && canAdministerSite({ ...target, ...next })) return null;

  const others = await db.user.count({
    where: {
      admin: true,
      disabled: false,
      headless: false,
      deletedAt: null,
      id: { not: target.id },
    },
  });
  if (others > 0) return null;
  return LAST_ADMIN_REASON;
}

/** `siteAdminBlockReason` as a guard: throws 400 with that reason. */
export async function assertSiteKeepsAnAdmin(
  db: Prisma.TransactionClient,
  target: User,
  next: Pick<User, 'admin' | 'disabled'> | null,
): Promise<void> {
  const reason = await siteAdminBlockReason(db, target, next);
  if (reason) throw new HttpError(400, reason);
}

// ---------------------------------------------------------------------------
// Deletion impact
// ---------------------------------------------------------------------------

/**
 * What deleting a user touches. `evidence` and `comments` are *kept* and
 * anonymized — the evidence is the client deliverable, so it outlives its author
 * (ON DELETE SET NULL) and renders as "Deleted user". `engagements` (memberships)
 * and `apiKeys` are destroyed with the row by the DB's cascades.
 */
export interface UserDeletionImpact {
  evidence: number;
  comments: number;
  engagements: number;
  apiKeys: number;
}

/**
 * Count a user's deletion impact. One query via relation `_count` — not four
 * counts — so it is cheap enough to call inside the delete transaction and from a
 * read that runs before the admin confirms. Returns zeros if the row is already
 * gone.
 */
export async function countUserDeletionImpact(
  db: Prisma.TransactionClient,
  userId: number,
): Promise<UserDeletionImpact> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: {
      _count: { select: { evidence: true, evidenceComments: true, roles: true, apiKeys: true } },
    },
  });
  const counts = row?._count;
  return {
    evidence: counts?.evidence ?? 0,
    comments: counts?.evidenceComments ?? 0,
    engagements: counts?.roles ?? 0,
    apiKeys: counts?.apiKeys ?? 0,
  };
}
