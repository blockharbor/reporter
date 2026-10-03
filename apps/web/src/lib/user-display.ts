import { DELETED_USER_LABEL, type User } from '@reporter/shared';

export { DELETED_USER_LABEL };

/** Display name for an operator / author, or the stand-in once they're deleted. */
export function userDisplayName(user: Pick<User, 'firstName' | 'lastName'> | null): string {
  if (!user) return DELETED_USER_LABEL;
  return `${user.firstName} ${user.lastName}`.trim() || DELETED_USER_LABEL;
}
