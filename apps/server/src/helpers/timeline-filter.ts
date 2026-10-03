import type { Prisma } from '@prisma/client';
import type { ParsedQuery } from '@reporter/shared';

/**
 * Translate a parsed evidence-timeline query into a Prisma `where` filter,
 * scoped to one engagement. Prisma builds parameterized SQL from this — no string
 * concatenation. Multiple tags/text terms are ANDed; multiple date ranges ORed.
 */
export function buildEvidenceWhere(
  q: ParsedQuery,
  engagementId: number,
  userId: number,
): Prisma.EvidenceWhereInput {
  const and: Prisma.EvidenceWhereInput[] = [{ engagementId }];

  for (const term of q.text) {
    and.push({ description: { contains: term, mode: 'insensitive' } });
  }

  // Every requested tag must be present on the evidence.
  for (const tagName of q.tags) {
    and.push({ tags: { some: { tag: { name: tagName, engagementId } } } });
  }

  // Evidence whose operator has been deleted (operator_id NULL) matches no slug and so
  // drops out — correct, since this filter asks for a named operator.
  if (q.operators.length > 0) {
    and.push({ operator: { slug: { in: q.operators } } });
  }

  if (q.types.length > 0) {
    and.push({ contentType: { in: q.types } });
  }

  if (q.uuids.length > 0) {
    and.push({ uuid: { in: q.uuids } });
  }

  if (q.dateRanges.length > 0) {
    const or: Prisma.EvidenceWhereInput[] = [];
    for (const range of q.dateRanges) {
      const occurredAt: Prisma.DateTimeFilter = {};
      if (range.from) occurredAt.gte = new Date(`${range.from}T00:00:00.000Z`);
      if (range.to) occurredAt.lte = new Date(`${range.to}T23:59:59.999Z`);
      if (occurredAt.gte || occurredAt.lte) or.push({ occurredAt });
    }
    if (or.length > 0) and.push({ OR: or });
  }

  if (q.withFinding === true) {
    and.push({ findings: { some: {} } });
  } else if (q.withFinding === false) {
    and.push({ findings: { none: {} } });
  }

  // Starring is per-user: only the requesting user's prefs count.
  if (q.starred === true) {
    and.push({ userPrefs: { some: { userId, isFavorite: true } } });
  } else if (q.starred === false) {
    and.push({ userPrefs: { none: { userId, isFavorite: true } } });
  }

  // Hide evidence that is a comment (linked evidence) on another piece.
  if (q.noComments === true) {
    and.push({ parentEvidenceId: null });
  }

  // `excludeFromReport` is deliberately not filtered here: evidence excluded from the
  // report stays fully visible in the app (badged) so it can be un-excluded. Only
  // report output — the PDF, the supporting-files ZIP, the JSON export — applies it.
  return { AND: and };
}
