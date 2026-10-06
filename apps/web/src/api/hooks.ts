import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Activity,
  AdminEngagement,
  AdminUser,
  ApiKey,
  CreateActivityInput,
  CreateEvidenceInput,
  CreateFindingInput,
  CreateEngagementInput,
  CreateGoalInput,
  CreateReportTemplateInput,
  CreateTagInput,
  CreateTargetInput,
  Evidence,
  EvidenceComment,
  Finding,
  FindingCategory,
  FindingDetail,
  FindingEvidence,
  FindingsImportResult,
  GeneratedReport,
  Goal,
  GoalsTree,
  ImportRequest,
  ImportResult,
  Engagement,
  LinkedGoal,
  ReportSettings,
  ReportTemplate,
  SavedQuery,
  Tag,
  Target,
  UpdateActivityInput,
  UpdateEvidenceInput,
  UpdateFindingEvidenceInput,
  UpdateGoalInput,
  UpdateReportSettingsInput,
  UpdateReportTemplateInput,
  UpdateTargetInput,
  User,
} from '@reporter/shared';
import { api } from './client.js';

export interface TimelineResult {
  items: Evidence[];
  total: number;
  page: number;
  pageSize: number;
}

const engKey = (slug: string) => ['engagement', slug];

// --- Engagements ---
export const useEngagements = () =>
  useQuery({ queryKey: ['engagements'], queryFn: () => api.get<Engagement[]>('/web/engagements') });

export const useEngagement = (slug: string) =>
  useQuery({
    queryKey: engKey(slug),
    queryFn: () => api.get<Engagement>(`/web/engagements/${slug}`),
  });

/** Query key for an engagement's report-generation history. */
export const reportHistoryKey = (slug: string) => ['report-history', slug];

/** An engagement's report history (newest first) — gates the attestation letter. */
export const useReportHistory = (slug: string) =>
  useQuery({
    queryKey: reportHistoryKey(slug),
    queryFn: () => api.get<GeneratedReport[]>(`/web/engagements/${slug}/reports/history`),
    enabled: Boolean(slug),
  });

export function useCreateEngagement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEngagementInput) => api.post<Engagement>('/web/engagements', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['engagements'] });
      qc.invalidateQueries({ queryKey: ['admin-engagements'] });
    },
  });
}

export function useUpdateEngagement(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      patch: Partial<
        Pick<
          Engagement,
          | 'name'
          | 'status'
          | 'startedAt'
          | 'projectedEndAt'
          | 'actualEndAt'
          | 'clientName'
          | 'assessmentType'
          | 'location'
          | 'scope'
          | 'executiveSummary'
          | 'methodology'
          // Report v2 structured content
          | 'scopeTargets'
          | 'scopeExclusions'
          | 'strategicRecommendations'
          | 'threatModelNarrative'
          | 'threatModelDiagrams'
          | 'executionNarrative'
          | 'providerContacts'
          | 'clientContacts'
          | 'softwareTested'
          | 'thirdPartySoftware'
          | 'watermarkEnabled'
          | 'watermarkText'
          | 'watermarkColor'
          | 'watermarkOpacity'
          | 'watermarkLayer'
          // Goals + Reports v2
          | 'reportConfig'
          | 'testApproach'
          | 'objectivesNarrative'
        >
      >,
    ) => api.put<Engagement>(`/web/engagements/${slug}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['engagements'] });
      qc.invalidateQueries({ queryKey: ['admin-engagements'] });
      qc.invalidateQueries({ queryKey: engKey(slug) });
    },
  });
}

export function useToggleFavorite(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (favorite: boolean) => api.post(`/web/engagements/${slug}/favorite`, { favorite }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engagements'] }),
  });
}

export function useDeleteEngagement(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del(`/web/engagements/${slug}`),
    onSuccess: () => {
      // The engagement (and its cached detail/children) is gone — drop it from
      // the lists and forget any per-engagement queries still in the cache.
      qc.removeQueries({ queryKey: engKey(slug) });
      qc.invalidateQueries({ queryKey: ['engagements'] });
      qc.invalidateQueries({ queryKey: ['admin-engagements'] });
    },
  });
}

// --- Evidence ---
export const useTimeline = (slug: string, q: string, page: number) =>
  useQuery({
    queryKey: ['timeline', slug, q, page],
    queryFn: () =>
      api.get<TimelineResult>(
        `/web/engagements/${slug}/evidence?q=${encodeURIComponent(q)}&page=${page}`,
      ),
  });

export const useEvidence = (slug: string, uuid: string) =>
  useQuery({
    queryKey: ['evidence', slug, uuid],
    queryFn: () => api.get<Evidence>(`/web/engagements/${slug}/evidence/${uuid}`),
    // Don't fire for a blank uuid (e.g. an unfilled execution-narrative evidence
    // slot) — that would hit /evidence/ with an empty id segment.
    enabled: Boolean(slug && uuid),
  });

/** Linked evidence (child evidence) attached to a piece of evidence, oldest first. */
export const useLinkedEvidence = (slug: string, uuid: string) =>
  useQuery({
    queryKey: ['linked-evidence', slug, uuid],
    queryFn: () => api.get<Evidence[]>(`/web/engagements/${slug}/evidence/${uuid}/linked-evidence`),
  });

/** Plain-text comments (discussion thread) on a piece of evidence, oldest first. */
export const useEvidenceComments = (slug: string, uuid: string) =>
  useQuery({
    queryKey: ['evidence-comments', slug, uuid],
    queryFn: () => api.get<EvidenceComment[]>(`/web/engagements/${slug}/evidence/${uuid}/comments`),
  });

export function useAddEvidenceComment(slug: string, uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      api.post<EvidenceComment>(`/web/engagements/${slug}/evidence/${uuid}/comments`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['evidence-comments', slug, uuid] }),
  });
}

export function useUpdateEvidenceComment(slug: string, uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { commentUuid: string; body: string }) =>
      api.put<EvidenceComment>(`/web/engagements/${slug}/evidence/comments/${args.commentUuid}`, {
        body: args.body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['evidence-comments', slug, uuid] }),
  });
}

export function useDeleteEvidenceComment(slug: string, uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentUuid: string) =>
      api.del(`/web/engagements/${slug}/evidence/comments/${commentUuid}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['evidence-comments', slug, uuid] }),
  });
}

/**
 * An operator as it appears on evidence (for the timeline operator filter).
 * `Evidence['operator']` is nullable because evidence outlives a deleted user,
 * but the `/evidence/operators` endpoint only lists users who still exist — so
 * the filter's own type is the non-null half.
 */
export type EvidenceOperator = NonNullable<Evidence['operator']>;

/** Distinct operators who have evidence in the engagement (read-level). */
export const useEvidenceOperators = (slug: string) =>
  useQuery({
    queryKey: ['evidence-operators', slug],
    queryFn: () => api.get<EvidenceOperator[]>(`/web/engagements/${slug}/evidence/operators`),
    staleTime: 5 * 60_000,
  });

export function useCreateEvidence(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { metadata: CreateEvidenceInput; file?: File }) => {
      const form = new FormData();
      form.append('notes', JSON.stringify(args.metadata));
      if (args.file) form.append('file', args.file);
      return api.postForm<Evidence>(`/web/engagements/${slug}/evidence`, form);
    },
    onSuccess: (_d, v) => {
      invalidateTimeline(qc, slug);
      // Adding linked evidence changes the parent's linked-evidence list + count.
      const parent = v.metadata.parentEvidenceUuid;
      if (parent) {
        qc.invalidateQueries({ queryKey: ['linked-evidence', slug, parent] });
        qc.invalidateQueries({ queryKey: ['evidence', slug, parent] });
      }
    },
  });
}

/** Star / unstar a piece of evidence for the current user (per-user, like engagement favorites). */
export function useToggleEvidenceStar(slug: string, uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (starred: boolean) =>
      api.post(`/web/engagements/${slug}/evidence/${uuid}/star`, { starred }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timeline', slug] });
      qc.invalidateQueries({ queryKey: ['evidence', slug, uuid] });
      // Starred rows also appear in comment threads.
      qc.invalidateQueries({ queryKey: ['linked-evidence', slug] });
    },
  });
}

/**
 * Patch one piece of evidence. Every field is optional, so this also serves the
 * single-field saves (e.g. the report-exclusion toggle, which saves immediately).
 */
export function useUpdateEvidence(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { uuid: string; patch: UpdateEvidenceInput }) =>
      api.put<Evidence>(`/web/engagements/${slug}/evidence/${args.uuid}`, args.patch),
    onSuccess: (_d, v) => {
      invalidateTimeline(qc, slug);
      qc.invalidateQueries({ queryKey: ['evidence', slug, v.uuid] });
      // The same evidence is also rendered inside its parent's linked-evidence
      // list and on every finding it is attached to; those copies carry the title,
      // tags and the excluded-from-report flag, so refresh them too.
      qc.invalidateQueries({ queryKey: ['linked-evidence', slug] });
      qc.invalidateQueries({ queryKey: ['finding', slug] });
    },
  });
}

export function useDeleteEvidence(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    // `comments` chooses what happens to linked evidence: 'cascade' deletes them,
    // 'orphan' (default) promotes them to top-level evidence.
    mutationFn: (args: { uuid: string; comments?: 'cascade' | 'orphan' }) =>
      api.del(
        `/web/engagements/${slug}/evidence/${args.uuid}` +
          (args.comments ? `?comments=${args.comments}` : ''),
      ),
    onSuccess: () => {
      invalidateTimeline(qc, slug);
      // Orphaned comments become top-level — refresh any cached evidence detail.
      qc.invalidateQueries({ queryKey: ['evidence', slug] });
      // Deleting a comment must drop it from its parent's thread; we don't know the
      // parent here, so refresh every cached comment thread in this engagement.
      qc.invalidateQueries({ queryKey: ['linked-evidence', slug] });
    },
  });
}

function invalidateTimeline(qc: ReturnType<typeof useQueryClient>, slug: string) {
  qc.invalidateQueries({ queryKey: ['timeline', slug] });
  qc.invalidateQueries({ queryKey: ['engagements'] });
}

// --- Tags ---
export const useTags = (slug: string) =>
  useQuery({
    queryKey: ['tags', slug],
    queryFn: () => api.get<Tag[]>(`/web/engagements/${slug}/tags`),
  });

export function useCreateTag(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTagInput) => api.post<Tag>(`/web/engagements/${slug}/tags`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tags', slug] }),
  });
}

export function useUpdateTag(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: number; patch: Partial<Tag> }) =>
      api.put<Tag>(`/web/engagements/${slug}/tags/${args.id}`, args.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tags', slug] }),
  });
}

export function useDeleteTag(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/web/engagements/${slug}/tags/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tags', slug] }),
  });
}

// --- Findings ---
export const useFindings = (slug: string) =>
  useQuery({
    queryKey: ['findings', slug],
    queryFn: () => api.get<Finding[]>(`/web/engagements/${slug}/findings`),
  });

export const useFinding = (slug: string, uuid: string) =>
  useQuery({
    queryKey: ['finding', slug, uuid],
    queryFn: () => api.get<FindingDetail>(`/web/engagements/${slug}/findings/${uuid}`),
  });

export function useCreateFinding(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFindingInput) =>
      api.post<Finding>(`/web/engagements/${slug}/findings`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['findings', slug] }),
  });
}

export function useUpdateFinding(slug: string, uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.put<Finding>(`/web/engagements/${slug}/findings/${uuid}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['findings', slug] });
      qc.invalidateQueries({ queryKey: ['finding', slug, uuid] });
    },
  });
}

export function useDeleteFinding(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (uuid: string) => api.del(`/web/engagements/${slug}/findings/${uuid}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['findings', slug] }),
  });
}

/** Import a findings export (parsed JSON) into the engagement. */
export function useImportFindings(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: unknown) =>
      api.post<FindingsImportResult>(`/web/engagements/${slug}/findings/import`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['findings', slug] }),
  });
}

// --- Finding categories (engagement-scoped list; categories are shared globally) ---
export const useFindingCategories = (slug: string) =>
  useQuery({
    queryKey: ['finding-categories', slug],
    queryFn: () => api.get<FindingCategory[]>(`/web/engagements/${slug}/finding-categories`),
  });

export function useCreateFindingCategory(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { category: string }) =>
      api.post<FindingCategory>(`/web/engagements/${slug}/finding-categories`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['finding-categories', slug] }),
  });
}

export function useDeleteFindingCategory(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/web/engagements/${slug}/finding-categories/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['finding-categories', slug] }),
  });
}

export function useAttachEvidence(slug: string, uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { evidenceUuids: string[]; inPath: boolean }) =>
      api.post(`/web/engagements/${slug}/findings/${uuid}/evidence`, {
        evidenceUuids: args.evidenceUuids,
        inPath: args.inPath,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['finding', slug, uuid] }),
  });
}

/**
 * Update a single evidence↔finding link (its Attack-Path `caption`, or move it
 * between buckets via `inPath`). Caption edits patch the cached finding
 * optimistically so the textarea doesn't flicker on every keystroke-debounced
 * save; bucket moves fall back to a plain invalidate.
 */
export function useUpdateFindingEvidence(slug: string, uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { evidenceUuid: string; patch: UpdateFindingEvidenceInput }) =>
      api.patch<FindingEvidence>(
        `/web/engagements/${slug}/findings/${uuid}/evidence/${args.evidenceUuid}`,
        args.patch,
      ),
    onMutate: async (args) => {
      // Only caption edits are applied optimistically; a bucket move reorders
      // the array server-side, so we let the invalidate re-fetch it.
      if (args.patch.caption === undefined) return { prev: undefined };
      await qc.cancelQueries({ queryKey: ['finding', slug, uuid] });
      const prev = qc.getQueryData<FindingWithEvidence>(['finding', slug, uuid]);
      if (prev) {
        const evidence = prev.evidence.map((e) =>
          e.uuid === args.evidenceUuid ? { ...e, caption: args.patch.caption ?? e.caption } : e,
        );
        qc.setQueryData(['finding', slug, uuid], { ...prev, evidence });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['finding', slug, uuid], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['finding', slug, uuid] }),
  });
}

export function useDetachEvidence(slug: string, uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (evidenceUuid: string) =>
      api.del(`/web/engagements/${slug}/findings/${uuid}/evidence/${evidenceUuid}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['finding', slug, uuid] }),
  });
}

/** Reorder findings by their full ordered UUID list (optimistic). */
export function useReorderFindings(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderedUuids: string[]) =>
      api.patch(`/web/engagements/${slug}/findings/reorder`, { orderedUuids }),
    onMutate: async (orderedUuids) => {
      await qc.cancelQueries({ queryKey: ['findings', slug] });
      const prev = qc.getQueryData<Finding[]>(['findings', slug]);
      if (prev) {
        const byUuid = new Map(prev.map((f) => [f.uuid, f]));
        const next = orderedUuids.map((u) => byUuid.get(u)).filter((f): f is Finding => Boolean(f));
        qc.setQueryData(['findings', slug], next);
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['findings', slug], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['findings', slug] }),
  });
}

type FindingWithEvidence = Finding & { evidence: FindingEvidence[] };

/**
 * Reorder ONE bucket of a finding's evidence (Attack Path or Attached), optimistic.
 * `orderedUuids` is only that bucket's links in their new order — the server
 * reorders a single bucket per request. The optimistic update therefore reorders
 * just the links whose uuid is in the submitted set and leaves the OTHER bucket's
 * links untouched. (A previous version rebuilt the whole array from the submitted
 * uuids, which silently dropped the other bucket from the cache.)
 */
export function useReorderEvidence(slug: string, uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderedUuids: string[]) =>
      api.patch(`/web/engagements/${slug}/findings/${uuid}/evidence/reorder`, { orderedUuids }),
    onMutate: async (orderedUuids) => {
      await qc.cancelQueries({ queryKey: ['finding', slug, uuid] });
      const prev = qc.getQueryData<FindingWithEvidence>(['finding', slug, uuid]);
      if (prev) {
        const submitted = new Set(orderedUuids);
        const byUuid = new Map(prev.evidence.map((e) => [e.uuid, e]));
        // The submitted bucket's links, in the requested new order.
        const reordered = orderedUuids
          .map((u) => byUuid.get(u))
          .filter((e): e is FindingEvidence => Boolean(e));
        // Walk the previous (globally path-first) array; wherever a submitted link
        // sat, drop in the next reordered one — preserving the other bucket's items
        // in place and keeping the overall bucket ordering stable.
        let i = 0;
        const evidence = prev.evidence.map((e) =>
          submitted.has(e.uuid) ? (reordered[i++] ?? e) : e,
        );
        qc.setQueryData(['finding', slug, uuid], { ...prev, evidence });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['finding', slug, uuid], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['finding', slug, uuid] }),
  });
}

// --- Goals: Target → Activity → Goal ---

const goalsKey = (slug: string) => ['goals', slug];

/**
 * After any target/activity/goal mutation the tree changes; status/link changes
 * additionally move the rolled-up progress that the engagement list + detail
 * render, so refresh those too.
 */
function invalidateGoals(qc: ReturnType<typeof useQueryClient>, slug: string) {
  qc.invalidateQueries({ queryKey: goalsKey(slug) });
  qc.invalidateQueries({ queryKey: engKey(slug) });
  qc.invalidateQueries({ queryKey: ['engagements'] });
}

export const useGoals = (slug: string) =>
  useQuery({
    queryKey: goalsKey(slug),
    queryFn: () => api.get<GoalsTree>(`/web/engagements/${slug}/goals`),
  });

// Targets
export function useCreateTarget(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTargetInput) =>
      api.post<Target>(`/web/engagements/${slug}/targets`, input),
    onSuccess: () => invalidateGoals(qc, slug),
  });
}

export function useUpdateTarget(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: number; patch: UpdateTargetInput }) =>
      api.put<Target>(`/web/engagements/${slug}/targets/${args.id}`, args.patch),
    onSuccess: () => invalidateGoals(qc, slug),
  });
}

export function useDeleteTarget(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/web/engagements/${slug}/targets/${id}`),
    onSuccess: () => invalidateGoals(qc, slug),
  });
}

export function useReorderTargets(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderedIds: number[]) =>
      api.patch(`/web/engagements/${slug}/targets/reorder`, { orderedIds }),
    onSuccess: () => invalidateGoals(qc, slug),
  });
}

// Activities
export function useCreateActivity(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { targetId: number; input: CreateActivityInput }) =>
      api.post<Activity>(
        `/web/engagements/${slug}/targets/${args.targetId}/activities`,
        args.input,
      ),
    // A new activity auto-creates a correlation tag — refresh the tag list too.
    onSuccess: () => {
      invalidateGoals(qc, slug);
      qc.invalidateQueries({ queryKey: ['tags', slug] });
    },
  });
}

export function useUpdateActivity(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: number; patch: UpdateActivityInput }) =>
      api.put<Activity>(`/web/engagements/${slug}/activities/${args.id}`, args.patch),
    onSuccess: () => invalidateGoals(qc, slug),
  });
}

export function useDeleteActivity(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/web/engagements/${slug}/activities/${id}`),
    onSuccess: () => {
      invalidateGoals(qc, slug);
      qc.invalidateQueries({ queryKey: ['tags', slug] });
    },
  });
}

export function useReorderActivities(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { targetId: number; orderedIds: number[] }) =>
      api.patch(`/web/engagements/${slug}/targets/${args.targetId}/activities/reorder`, {
        orderedIds: args.orderedIds,
      }),
    onSuccess: () => invalidateGoals(qc, slug),
  });
}

// Goals
export function useCreateGoal(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { activityId: number; input: CreateGoalInput }) =>
      api.post<Goal>(`/web/engagements/${slug}/activities/${args.activityId}/goals`, args.input),
    onSuccess: () => invalidateGoals(qc, slug),
  });
}

export function useUpdateGoal(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: number; patch: UpdateGoalInput }) =>
      api.put<Goal>(`/web/engagements/${slug}/goals/${args.id}`, args.patch),
    onSuccess: () => invalidateGoals(qc, slug),
  });
}

export function useDeleteGoal(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/web/engagements/${slug}/goals/${id}`),
    onSuccess: () => invalidateGoals(qc, slug),
  });
}

export function useReorderGoals(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { activityId: number; orderedIds: number[] }) =>
      api.patch(`/web/engagements/${slug}/activities/${args.activityId}/goals/reorder`, {
        orderedIds: args.orderedIds,
      }),
    onSuccess: () => invalidateGoals(qc, slug),
  });
}

// Goal ↔ Evidence / Finding links
export function useLinkGoalEvidence(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { goalId: number; evidenceUuids: string[] }) =>
      api.post(`/web/engagements/${slug}/goals/${args.goalId}/evidence`, {
        evidenceUuids: args.evidenceUuids,
      }),
    onSuccess: (_d, v) => {
      invalidateGoals(qc, slug);
      // Any open evidence detail's "Linked goals" list may change.
      for (const uuid of v.evidenceUuids) {
        qc.invalidateQueries({ queryKey: ['goals-for-evidence', slug, uuid] });
      }
    },
  });
}

export function useUnlinkGoalEvidence(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { goalId: number; evidenceUuid: string }) =>
      api.del(`/web/engagements/${slug}/goals/${args.goalId}/evidence/${args.evidenceUuid}`),
    onSuccess: (_d, v) => {
      invalidateGoals(qc, slug);
      qc.invalidateQueries({ queryKey: ['goals-for-evidence', slug, v.evidenceUuid] });
    },
  });
}

export function useLinkGoalFinding(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { goalId: number; findingUuids: string[] }) =>
      api.post(`/web/engagements/${slug}/goals/${args.goalId}/findings`, {
        findingUuids: args.findingUuids,
      }),
    onSuccess: (_d, v) => {
      invalidateGoals(qc, slug);
      for (const uuid of v.findingUuids) {
        qc.invalidateQueries({ queryKey: ['goals-for-finding', slug, uuid] });
      }
    },
  });
}

export function useUnlinkGoalFinding(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { goalId: number; findingUuid: string }) =>
      api.del(`/web/engagements/${slug}/goals/${args.goalId}/findings/${args.findingUuid}`),
    onSuccess: (_d, v) => {
      invalidateGoals(qc, slug);
      qc.invalidateQueries({ queryKey: ['goals-for-finding', slug, v.findingUuid] });
    },
  });
}

/** Goals currently linked to a piece of evidence (for the detail-page section). */
export const useGoalsForEvidence = (slug: string, uuid: string) =>
  useQuery({
    queryKey: ['goals-for-evidence', slug, uuid],
    queryFn: () => api.get<LinkedGoal[]>(`/web/engagements/${slug}/goals/for-evidence/${uuid}`),
    enabled: Boolean(slug && uuid),
  });

/** Goals currently linked to a finding (for the detail-page section). */
export const useGoalsForFinding = (slug: string, uuid: string) =>
  useQuery({
    queryKey: ['goals-for-finding', slug, uuid],
    queryFn: () => api.get<LinkedGoal[]>(`/web/engagements/${slug}/goals/for-finding/${uuid}`),
    enabled: Boolean(slug && uuid),
  });

/** Import a proposal draft (with metadata + mode) into the engagement. */
export function useImportProposal(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportRequest) =>
      api.post<ImportResult>(`/web/engagements/${slug}/proposal/import`, body),
    onSuccess: () => invalidateGoals(qc, slug),
  });
}

// --- Saved queries ---
export const useSavedQueries = (slug: string) =>
  useQuery({
    queryKey: ['queries', slug],
    queryFn: () => api.get<SavedQuery[]>(`/web/engagements/${slug}/queries`),
  });

export function useCreateSavedQuery(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; query: string; type: 'evidence' | 'findings' }) =>
      api.post<SavedQuery>(`/web/engagements/${slug}/queries`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queries', slug] }),
  });
}

export function useUpdateSavedQuery(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; name?: string; query?: string }) =>
      api.put<SavedQuery>(`/web/engagements/${slug}/queries/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queries', slug] }),
  });
}

export function useDeleteSavedQuery(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/web/engagements/${slug}/queries/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queries', slug] }),
  });
}

// --- Account ---
export interface AccountApiKey {
  accessKey: string;
  lastAuth: string | null;
  createdAt: string;
}
export const useApiKeys = () =>
  useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.get<AccountApiKey[]>('/web/account/api-keys'),
  });

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ApiKey>('/web/account/api-keys'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accessKey: string) =>
      api.del(`/web/account/api-keys/${encodeURIComponent(accessKey)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });
}

// --- Admin ---
export const useUsers = () =>
  useQuery({ queryKey: ['admin-users'], queryFn: () => api.get<AdminUser[]>('/web/admin/users') });

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post<User>('/web/admin/users', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { slug: string; patch: Record<string, unknown> }) =>
      api.put<User>(`/web/admin/users/${args.slug}`, args.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
}

/**
 * Delete a user for good. The row is really removed and the evidence/comments
 * they authored are anonymized rather than deleted (the evidence is the client
 * deliverable), which changes how the operator and comment author render
 * everywhere — hence the un-scoped evidence key prefixes: the user may have
 * worked across any number of engagements.
 */
export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.del(`/web/admin/users/${slug}`),
    onSuccess: (_d, slug) => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      // Memberships go with the user, so member counts and member lists move.
      qc.invalidateQueries({ queryKey: ['engagements'] });
      qc.invalidateQueries({ queryKey: ['admin-engagements'] });
      qc.invalidateQueries({ queryKey: ['eng-users'] });
      // Anything that renders an operator or a comment author.
      qc.invalidateQueries({ queryKey: ['timeline'] });
      qc.invalidateQueries({ queryKey: ['evidence'] });
      qc.invalidateQueries({ queryKey: ['linked-evidence'] });
      qc.invalidateQueries({ queryKey: ['evidence-comments'] });
      qc.invalidateQueries({ queryKey: ['evidence-operators'] });
      qc.invalidateQueries({ queryKey: ['finding'] });
      // Their API keys were revoked with them; drop the cached list outright.
      qc.removeQueries({ queryKey: ['admin-user-api-keys', slug] });
    },
  });
}

/** Every engagement site-wide, with counts and the admin's own membership flag. */
export const useAdminEngagements = () =>
  useQuery({
    queryKey: ['admin-engagements'],
    queryFn: () => api.get<AdminEngagement[]>('/web/admin/engagements'),
  });

/** Issue a one-time recovery login link for a user (24h expiry, single use). */
export function useGenerateRecoveryLink() {
  return useMutation({
    mutationFn: (slug: string) =>
      api.post<{ recoveryUrl: string }>(`/web/admin/users/${slug}/recovery`),
  });
}

/** Clear a user's TOTP secret so they re-enroll on next login. */
export function useResetTotp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      api.post<{ ok: true; hadTotp: boolean }>(`/web/admin/users/${slug}/totp-reset`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
}

/** A user's API keys as seen by an admin (never includes the secret). */
export const useUserApiKeys = (slug: string | null) =>
  useQuery({
    queryKey: ['admin-user-api-keys', slug],
    queryFn: () => api.get<ApiKey[]>(`/web/admin/users/${slug}/api-keys`),
    enabled: Boolean(slug),
  });

export function useRevokeUserApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { slug: string; accessKey: string }) =>
      api.del(`/web/admin/users/${args.slug}/api-keys/${encodeURIComponent(args.accessKey)}`),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['admin-user-api-keys', v.slug] }),
  });
}

// --- Report branding (site-admin only) ---
export const useReportSettings = () =>
  useQuery({
    queryKey: ['report-settings'],
    queryFn: () => api.get<ReportSettings>('/web/admin/report-settings'),
  });

export function useUpdateReportSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateReportSettingsInput) =>
      api.put<ReportSettings>('/web/admin/report-settings', patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['report-settings'] }),
  });
}

// --- Report templates (site-wide library of named report configurations) ---
//
// A report template is a saved report configuration (everything in an
// engagement's `reportConfig` except `readinessNa`) that any engagement can
// apply or generate with. Templates are GLOBAL, so none of these hooks closes
// over an engagement slug and the cache key carries none either — the Reports
// tab of every engagement reads the same list.
//
// Applying a template is not one of these mutations: it writes the engagement's
// live `reportConfig`, which is `useUpdateEngagement(slug)`. Generating one
// report from a template is a plain download (`report.{pdf,zip,json}?templateUuid=`),
// built where the Generate tab builds its other URLs; neither touches the library.

/**
 * Query key for the report-template library — one flat, slug-free key, the same
 * shape the other global resources use (`['report-settings']`, `['admin-users']`).
 * Exported so a page that needs to refresh the library by hand reuses it instead
 * of re-spelling the string; the three mutations below invalidate it themselves.
 */
export const reportTemplatesKey = ['report-templates'];

/** The template library, name-ascending. Any signed-in user may read it. */
export const useReportTemplates = () =>
  useQuery({
    queryKey: reportTemplatesKey,
    queryFn: () => api.get<ReportTemplate[]>('/web/report-templates'),
  });

/**
 * Save a report configuration under a name. The caller passes the configuration
 * to snapshot (normally the engagement's live config, which structurally
 * satisfies `ReportTemplateConfig` — the omitted `readinessNa` is simply not
 * read). Managing the library needs write or admin on some engagement, or site
 * admin: a 403 from the server means the user may use templates but not change
 * them. A name already in the library is a 409 — surface `ApiError.message`,
 * which carries the server's wording.
 */
export function useCreateReportTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateReportTemplateInput) =>
      api.post<ReportTemplate>('/web/report-templates', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: reportTemplatesKey }),
  });
}

/**
 * Rename a template, reword its description, or overwrite its configuration with
 * the one currently configured. Every field of the patch is optional and an
 * absent field is left as it was, so one hook serves all three edits. The uuid
 * travels with the call (not the hook) so a list of templates needs one instance.
 */
export function useUpdateReportTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { uuid: string; patch: UpdateReportTemplateInput }) =>
      api.put<ReportTemplate>(`/web/report-templates/${args.uuid}`, args.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: reportTemplatesKey }),
  });
}

/**
 * Delete a template. Nothing holds a reference to it afterwards: applying a
 * template copies its configuration into the engagement, and a report generated
 * from one recorded the template's name in its history label at generation time —
 * so this removes it from the library only, and no other query goes stale.
 */
export function useDeleteReportTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (uuid: string) => api.del(`/web/report-templates/${uuid}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: reportTemplatesKey }),
  });
}
