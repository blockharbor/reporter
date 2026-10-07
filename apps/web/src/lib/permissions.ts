import { ROLE_RANK, type Engagement, type EngagementRole, type User } from '@reporter/shared';
import { useAuth } from '../auth.js';
import { useEngagement } from '../api/hooks.js';

/** `title` for controls disabled because the user's engagement role is read-only. */
export const READ_ONLY_TITLE = 'You have read-only access to this engagement';
/** `title` for controls that need the engagement admin role. */
export const ADMIN_ONLY_TITLE = 'Requires engagement admin';
/**
 * `title` for controls that need a site admin — a stronger bar than
 * {@link ADMIN_ONLY_TITLE}, which an engagement's own admin satisfies. Used by
 * actions with no engagement to scope a role to, such as importing an engagement.
 */
export const SITE_ADMIN_ONLY_TITLE = 'Requires a site admin';

/**
 * Does the user hold `atLeast` on the engagement? Site admins bypass every
 * engagement role check — mirrors the server's guards, which also let them
 * through — so an admin viewing an engagement they're not a member of
 * (role undefined) still gets live controls.
 */
function hasRole(
  user: User | null | undefined,
  eng: Pick<Engagement, 'role'> | null | undefined,
  atLeast: EngagementRole,
): boolean {
  if (user?.admin) return true;
  return eng?.role !== undefined && ROLE_RANK[eng.role] >= ROLE_RANK[atLeast];
}

/** May the user create/edit/delete content (evidence, findings, tags, queries)? */
export function canWrite(
  user: User | null | undefined,
  eng: Pick<Engagement, 'role'> | null | undefined,
): boolean {
  return hasRole(user, eng, 'write');
}

/** May the user administer the engagement (details, members, deletion)? */
export function canAdmin(
  user: User | null | undefined,
  eng: Pick<Engagement, 'role'> | null | undefined,
): boolean {
  return hasRole(user, eng, 'admin');
}

/**
 * Effective permissions for the current user on one engagement. Purely
 * presentational — the server enforces the same rules, and every mutation's
 * error toast stays as the backstop. While the engagement is still loading
 * this reports false (controls briefly render disabled) unless the user is a
 * site admin.
 */
export function useEngagementPermissions(slug: string): { canWrite: boolean; canAdmin: boolean } {
  const { user } = useAuth();
  const { data: eng } = useEngagement(slug);
  return { canWrite: canWrite(user, eng), canAdmin: canAdmin(user, eng) };
}
