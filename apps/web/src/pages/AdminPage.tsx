import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  Select,
  SortableTh,
  Spinner,
  Table,
  Tabs,
  TagChip,
  Tbody,
  Td,
  Textarea,
  Th,
  Thead,
  Tr,
  useConfirm,
  useToast,
  type SortDirection,
} from '@reporter/ui';
import {
  CANNOT_DELETE_SELF,
  DELETED_USER_LABEL,
  ENGAGEMENT_STATUSES,
  LAST_ADMIN_REASON,
  defaultTagColorFor,
  type AdminEngagement,
  type AdminUser,
  type EngagementStatus,
  type ReportTemplate,
  type ReportTemplateConfig,
  type UpdateReportSettingsInput,
  type UpdateReportTemplateInput,
} from '@reporter/shared';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import {
  useAdminEngagements,
  useCreateUser,
  useDeleteEngagement,
  useDeleteReportTemplate,
  useDeleteUser,
  useGenerateRecoveryLink,
  useReportSettings,
  useReportTemplates,
  useResetTotp,
  useRevokeUserApiKey,
  useUpdateReportSettings,
  useUpdateReportTemplate,
  useUpdateUser,
  useUserApiKeys,
  useUsers,
} from '../api/hooks.js';
import { formatDate, formatDateTime } from '../lib/format.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { sectionLabel } from '../lib/report-sections.js';
import { userDisplayName } from '../lib/user-display.js';
import { TemplateSanitizeBadge } from '../components/engagement/TemplateSanitizeBadge.js';
import { AuditLogTab } from '../components/admin/AuditLogTab.js';

/**
 * The admin tabs. The active key lives in `?tab=` (absent = Users) so the
 * Audit log tab's filters — which are URL params of their own — can be
 * deep-linked, and the other five tabs gain a reload-stable URL for free.
 * Validated against this list, so a stale or hand-edited `?tab=` falls back to
 * Users instead of rendering nothing.
 */
export const ADMIN_TABS = [
  { key: 'users', label: 'Users' },
  { key: 'default-tags', label: 'Default tags' },
  { key: 'engagements', label: 'Engagements' },
  { key: 'branding', label: 'Report branding' },
  { key: 'report-templates', label: 'Report templates' },
  { key: 'audit-log', label: 'Audit log' },
] as const;
export type AdminTabKey = (typeof ADMIN_TABS)[number]['key'];

const isAdminTabKey = (raw: string | null): raw is AdminTabKey =>
  ADMIN_TABS.some((t) => t.key === raw);

export function AdminPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: AdminTabKey = isAdminTabKey(raw) ? raw : 'users';

  // A tab switch is navigation, so it PUSHES — unlike the audit filters below
  // it, which replace — and it writes only the new key: every other param
  // belongs to the tab being left (an audit filter means nothing on Users).
  // Re-clicking the active tab with nothing else in the URL is not a switch;
  // pushing an identical entry would only make the next Back a no-op.
  const selectTab = (key: string) => {
    const next = new URLSearchParams(key === 'users' ? {} : { tab: key });
    if (next.toString() === params.toString()) return;
    setParams(next);
  };

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold text-text">Admin</h1>
      <Tabs className="mb-6" active={tab} onChange={selectTab} tabs={[...ADMIN_TABS]} />
      {tab === 'users' && <UsersTab />}
      {tab === 'default-tags' && <DefaultTagsTab />}
      {tab === 'engagements' && <EngagementsTab />}
      {tab === 'branding' && <ReportBrandingTab />}
      {tab === 'report-templates' && <ReportTemplatesTab />}
      {tab === 'audit-log' && <AuditLogTab />}
    </div>
  );
}

/**
 * What `GET /web/admin/users/:slug/impact` reports about deleting one user.
 * `evidence` and `comments` are the rows that are *kept* and anonymized — evidence
 * is the client deliverable, so it outlives its author — while the memberships and
 * API keys are destroyed with the account. `blockedReason` is the message the DELETE
 * would fail with, or null.
 */
interface UserDeletionImpact {
  evidence: number;
  comments: number;
  engagements: number;
  apiKeys: number;
  canDelete: boolean;
  blockedReason: string | null;
}

function UsersTab() {
  const { data: users, isLoading, isError, refetch } = useUsers();
  const { user: me } = useAuth();
  const updateUser = useUpdateUser();
  const toast = useToast();
  const confirm = useConfirm();
  const recovery = useGenerateRecoveryLink();
  const resetTotp = useResetTotp();
  const removeUser = useDeleteUser();
  const [creating, setCreating] = useState(false);
  const [recoveryFor, setRecoveryFor] = useState<{ user: AdminUser; url: string } | null>(null);
  const [apiKeysFor, setApiKeysFor] = useState<AdminUser | null>(null);
  // Held for the whole delete flow — the impact read, the dialog, and the request —
  // so the row reads as busy throughout and a second click can't start a second one.
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);

  async function generateRecovery(u: AdminUser) {
    try {
      const { recoveryUrl } = await recovery.mutateAsync(u.slug);
      setRecoveryFor({ user: u, url: recoveryUrl });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not generate a recovery link');
    }
  }

  /**
   * Both toggles in the table are fire-and-forget patches whose only visible effect
   * is the refetched row, so a refusal — demoting or disabling the last admin who can
   * sign in — would otherwise look like a dead control.
   */
  async function patchUser(u: AdminUser, patch: { admin?: boolean; disabled?: boolean }) {
    try {
      await updateUser.mutateAsync({ slug: u.slug, patch });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the user');
    }
  }

  async function confirmResetTotp(u: AdminUser) {
    const ok = await confirm({
      title: 'Reset TOTP',
      message: `Reset TOTP for ${u.firstName} ${u.lastName}? This clears their authenticator secret. (TOTP login enforcement is not yet enabled.)`,
      confirmLabel: 'Reset TOTP',
      danger: true,
    });
    if (!ok) return;
    try {
      await resetTotp.mutateAsync(u.slug);
      toast.success('TOTP reset');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reset TOTP');
    }
  }

  // The admins who could actually reach this panel, mirroring `canAdministerSite` on
  // the server: a disabled admin is turned away by the auth guards and a headless one
  // has no password at all, so neither counts as the admin who has to stay behind.
  const signInAdmins = (users ?? []).filter((u) => u.admin && !u.disabled && !u.headless);

  /**
   * Why this user cannot be deleted, or null when they can be. Both cases are decided
   * from the list already on screen so the button can explain itself instead of firing
   * a doomed request; the server enforces the same two rules, and `confirmDelete`
   * re-checks them against fresh counts in case another admin has changed something
   * since this list was fetched.
   */
  function deleteBlockedReason(u: AdminUser): string | null {
    if (u.slug === me?.slug) return CANNOT_DELETE_SELF;
    if (signInAdmins.length === 1 && signInAdmins[0]?.slug === u.slug) return LAST_ADMIN_REASON;
    return null;
  }

  async function confirmDelete(u: AdminUser) {
    const name = `${u.firstName} ${u.lastName}`;
    setDeletingSlug(u.slug);
    try {
      // The impact read comes first: the warning below has to name real numbers to be
      // honest about what survives, and a count it couldn't fetch is not one it may
      // invent. It also carries the server's own refusal, which beats this list if the
      // list has gone stale.
      const impact = await api.get<UserDeletionImpact>(`/web/admin/users/${u.slug}/impact`);
      if (!impact.canDelete) {
        toast.error(impact.blockedReason ?? `${name} cannot be deleted`);
        return;
      }
      const ok = await confirm({
        title: 'Delete user',
        // Four separate facts, one of them counterintuitive (the evidence stays), so
        // this dialog sets them out as lines rather than one long sentence.
        message: (
          <span className="block space-y-2">
            <span className="block">
              Delete <span className="font-semibold">{name}</span> ({u.email})?
            </span>
            <span className="block">
              Permanently removed: the account itself, every session and sign-in credential,{' '}
              {impact.apiKeys} API key{impact.apiKeys === 1 ? '' : 's'}, and {impact.engagements}{' '}
              engagement membership
              {impact.engagements === 1 ? '' : 's'}. Their email address becomes available for a new
              account.
            </span>
            <span className="block">
              Kept: {impact.evidence} piece{impact.evidence === 1 ? '' : 's'} of evidence and{' '}
              {impact.comments} evidence note{impact.comments === 1 ? '' : 's'} of theirs. Evidence
              is the client deliverable, so it outlives its author — it stays in the timeline, on
              its findings and in reports, attributed to “{DELETED_USER_LABEL}”. Their audit log
              entries are kept too, and keep showing the name and email the log recorded at the
              time.
            </span>
            <span className="block text-warning">This cannot be undone.</span>
          </span>
        ),
        confirmLabel: 'Delete user',
        danger: true,
      });
      if (!ok) return;
      await removeUser.mutateAsync(u.slug);
      toast.success(
        impact.evidence > 0
          ? `${name} deleted — ${impact.evidence} evidence item${
              impact.evidence === 1 ? '' : 's'
            } kept, now attributed to “${DELETED_USER_LABEL}”`
          : `${name} deleted`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete the user');
    } finally {
      setDeletingSlug(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-muted">
          Disabling a user is reversible — the account stays and can be switched back on. Deleting
          one is permanent, but their evidence and comments are kept and reattributed to “
          {DELETED_USER_LABEL}”.
        </p>
        <Button className="flex-none" onClick={() => setCreating(true)}>
          New user
        </Button>
      </div>
      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <ErrorState description="Couldn’t load users." onRetry={() => refetch()} />
      ) : !users || users.length === 0 ? (
        <EmptyState title="No users yet" description="Create your first user to get started." />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Admin</Th>
              <Th>Status</Th>
              <Th />
            </Tr>
          </Thead>
          <Tbody>
            {(users ?? []).map((u) => {
              const blockedReason = deleteBlockedReason(u);
              return (
                <Tr key={u.slug}>
                  <Td>
                    {u.firstName} {u.lastName} {u.headless && <Badge>headless</Badge>}
                  </Td>
                  <Td className="text-muted">{u.email}</Td>
                  <Td>
                    <Checkbox
                      id={`admin-${u.slug}`}
                      label=""
                      aria-label={`Toggle admin for ${u.firstName} ${u.lastName}`}
                      checked={u.admin}
                      onChange={(e) => patchUser(u, { admin: e.target.checked })}
                    />
                  </Td>
                  <Td>
                    <button
                      onClick={() => patchUser(u, { disabled: !u.disabled })}
                      className="text-sm"
                      aria-label={`${u.disabled ? 'Enable' : 'Disable'} ${u.firstName} ${
                        u.lastName
                      }`}
                      title={
                        u.disabled
                          ? 'Enable this account — reversible'
                          : 'Disable this account — reversible, keeps the user and their evidence'
                      }
                    >
                      {u.disabled ? (
                        <Badge tone="danger">disabled</Badge>
                      ) : (
                        <Badge tone="success">active</Badge>
                      )}
                    </button>
                  </Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={recovery.isPending && recovery.variables === u.slug}
                        onClick={() => generateRecovery(u)}
                      >
                        Recovery link
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setApiKeysFor(u)}>
                        API keys
                      </Button>
                      {u.hasTotp && (
                        <Button variant="ghost" size="sm" onClick={() => confirmResetTotp(u)}>
                          Reset TOTP
                        </Button>
                      )}
                      {/* The permanent counterpart to the status toggle, so it carries the
                          destructive tone — and stays hoverable while disabled so the
                          `title` can say why. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger"
                        disabled={blockedReason !== null}
                        title={blockedReason ?? undefined}
                        loading={deletingSlug === u.slug}
                        onClick={() => confirmDelete(u)}
                      >
                        Delete
                      </Button>
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </Tbody>
        </Table>
      )}
      <CreateUserModal open={creating} onClose={() => setCreating(false)} />
      <RecoveryLinkModal recovery={recoveryFor} onClose={() => setRecoveryFor(null)} />
      <UserApiKeysModal user={apiKeysFor} onClose={() => setApiKeysFor(null)} />
    </div>
  );
}

function RecoveryLinkModal({
  recovery,
  onClose,
}: {
  recovery: { user: AdminUser; url: string } | null;
  onClose: () => void;
}) {
  const toast = useToast();
  return (
    <Modal
      open={Boolean(recovery)}
      onClose={onClose}
      title="One-time recovery link"
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="space-y-3">
        <p className="text-sm text-text">
          Share this link with{' '}
          <span className="font-semibold">
            {recovery?.user.firstName} {recovery?.user.lastName}
          </span>{' '}
          over a trusted channel. It signs them in once, without a password.
        </p>
        <div className="rounded-input border border-border bg-surface-2 p-2">
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all font-mono text-xs">{recovery?.url}</code>
            <Button
              variant="secondary"
              size="sm"
              className="flex-none"
              onClick={async () => {
                const ok = await copyToClipboard(recovery?.url ?? '');
                if (ok) toast.success('Recovery link copied');
                else toast.error('Copy failed — select the link and copy manually');
              }}
            >
              Copy
            </Button>
          </div>
        </div>
        <p className="text-sm text-warning">
          The link expires in 24 hours, works exactly once, and won’t be shown again.
        </p>
      </div>
    </Modal>
  );
}

function UserApiKeysModal({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const { data: keys, isLoading, isError, refetch } = useUserApiKeys(user?.slug ?? null);
  const revoke = useRevokeUserApiKey();
  const toast = useToast();
  const confirm = useConfirm();

  async function confirmRevoke(accessKey: string) {
    if (!user) return;
    const ok = await confirm({
      title: 'Revoke API key',
      message: `Revoke this API key belonging to ${user.firstName} ${user.lastName}? Any desktop app or reporter-term using it will stop working immediately.`,
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    try {
      await revoke.mutateAsync({ slug: user.slug, accessKey });
      toast.success('API key revoked');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not revoke the API key');
    }
  }

  return (
    <Modal
      open={Boolean(user)}
      onClose={onClose}
      title={user ? `API keys — ${user.firstName} ${user.lastName}` : 'API keys'}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <ErrorState description="Couldn’t load their API keys." onRetry={() => refetch()} />
      ) : !keys || keys.length === 0 ? (
        <p className="text-sm text-muted">
          This user has no API keys. They can create one under Account → API keys.
        </p>
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Access key</Th>
              <Th>Last used</Th>
              <Th>Created</Th>
              <Th />
            </Tr>
          </Thead>
          <Tbody>
            {keys.map((k) => (
              <Tr key={k.accessKey}>
                <Td className="font-mono text-xs">{k.accessKey}</Td>
                <Td>{k.lastAuth ? formatDateTime(k.lastAuth) : <Badge>never</Badge>}</Td>
                <Td>{formatDateTime(k.createdAt)}</Td>
                <Td className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => confirmRevoke(k.accessKey)}>
                    Revoke
                  </Button>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Modal>
  );
}

function CreateUserModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateUser();
  const toast = useToast();
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    admin: false,
    headless: false,
  });
  const set = (k: keyof typeof form) => (v: any) => setForm((f) => ({ ...f, [k]: v }));

  async function submit() {
    try {
      await create.mutateAsync({
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        password: form.headless ? undefined : form.password,
        admin: form.admin,
        headless: form.headless,
      });
      toast.success('User created');
      setForm({
        firstName: '',
        lastName: '',
        email: '',
        password: '',
        admin: false,
        headless: false,
      });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create user');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New user"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={create.isPending} disabled={!form.email}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" htmlFor="u-fn">
            <Input
              id="u-fn"
              value={form.firstName}
              onChange={(e) => set('firstName')(e.target.value)}
            />
          </Field>
          <Field label="Last name" htmlFor="u-ln">
            <Input
              id="u-ln"
              value={form.lastName}
              onChange={(e) => set('lastName')(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Email" htmlFor="u-email">
          <Input
            id="u-email"
            type="email"
            value={form.email}
            onChange={(e) => set('email')(e.target.value)}
          />
        </Field>
        {!form.headless && (
          <Field
            label="Temporary password"
            htmlFor="u-pw"
            hint="The user resets it on first login."
          >
            <Input
              id="u-pw"
              value={form.password}
              onChange={(e) => set('password')(e.target.value)}
            />
          </Field>
        )}
        <div className="flex gap-6">
          <Checkbox
            label="Administrator"
            checked={form.admin}
            onChange={(e) => set('admin')(e.target.checked)}
          />
          <Checkbox
            label="Headless (API only)"
            checked={form.headless}
            onChange={(e) => set('headless')(e.target.checked)}
          />
        </div>
      </div>
    </Modal>
  );
}

interface DefaultTag {
  id: number;
  name: string;
  colorName: string;
}

function DefaultTagsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['default-tags'],
    queryFn: () => api.get<DefaultTag[]>('/web/admin/default-tags'),
  });
  const [name, setName] = useState('');
  const add = useMutation({
    mutationFn: () =>
      api.post('/web/admin/default-tags', { name, colorName: defaultTagColorFor(name) }),
    onSuccess: () => {
      setName('');
      qc.invalidateQueries({ queryKey: ['default-tags'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.del(`/web/admin/default-tags/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['default-tags'] }),
  });

  async function removeTag(id: number, tagName: string) {
    const ok = await confirm({
      title: 'Delete default tag',
      message: `Delete the default tag “${tagName}”? Existing engagements keep their copies.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) del.mutate(id);
  }

  return (
    <Card className="max-w-xl space-y-4 p-4">
      <p className="text-sm text-muted">These tags are copied into every new engagement.</p>
      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <ErrorState description="Couldn’t load default tags." onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <p className="text-sm text-muted">No default tags yet.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {data.map((t) => (
            <TagChip
              key={t.id}
              name={t.name}
              colorName={t.colorName}
              onRemove={() => removeTag(t.id, t.name)}
            />
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <Field label="New default tag" htmlFor="dt" className="flex-1">
          <Input id="dt" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button onClick={() => add.mutate()} disabled={!name} loading={add.isPending}>
          Add
        </Button>
      </div>
    </Card>
  );
}

const STATUS_TONE = { active: 'success', complete: 'info', archived: 'neutral' } as const;

type EngSortColumn = 'name' | 'status' | 'members' | 'evidence' | 'findings' | 'created';

// Numeric columns start descending (most first); text columns start ascending;
// created starts with the newest.
const ENG_FIRST_CLICK: Record<EngSortColumn, SortDirection> = {
  name: 'asc',
  status: 'asc',
  members: 'desc',
  evidence: 'desc',
  findings: 'desc',
  created: 'desc',
};

// Lifecycle order, not alphabetical.
const STATUS_ORDER: Record<EngagementStatus, number> = { active: 0, complete: 1, archived: 2 };

function compareAdminEngagements(column: EngSortColumn, direction: SortDirection) {
  const dir = direction === 'asc' ? 1 : -1;
  return (a: AdminEngagement, b: AdminEngagement): number => {
    switch (column) {
      case 'name':
        return dir * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      case 'status':
        return dir * (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
      case 'members':
        return dir * ((a.numUsers ?? 0) - (b.numUsers ?? 0));
      case 'evidence':
        return dir * ((a.numEvidence ?? 0) - (b.numEvidence ?? 0));
      case 'findings':
        return dir * ((a.numFindings ?? 0) - (b.numFindings ?? 0));
      case 'created':
        // ISO timestamps compare correctly as strings.
        return dir * a.createdAt.localeCompare(b.createdAt);
    }
  };
}

function EngagementsTab() {
  const { data: engagements, isLoading, isError, refetch } = useAdminEngagements();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<EngagementStatus | 'all'>('all');
  const [sort, setSort] = useState<{ column: EngSortColumn; direction: SortDirection } | null>(
    null,
  );

  const filtersActive = search.trim() !== '' || status !== 'all';
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (engagements ?? []).filter(
      (e) =>
        (status === 'all' || e.status === status) &&
        (!q || e.name.toLowerCase().includes(q) || e.slug.toLowerCase().includes(q)),
    );
  }, [engagements, search, status]);

  // Server order (createdAt desc) is kept until a column is clicked — sort() is stable.
  const ordered = useMemo(() => {
    if (!sort) return filtered;
    return [...filtered].sort(compareAdminEngagements(sort.column, sort.direction));
  }, [filtered, sort]);

  const toggleSort = (column: EngSortColumn) =>
    setSort(
      sort?.column === column
        ? { column, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: ENG_FIRST_CLICK[column] },
    );
  const directionOf = (column: EngSortColumn) =>
    sort?.column === column ? sort.direction : undefined;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Every engagement on this server, including ones you’re not a member of.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter engagements…"
          aria-label="Filter engagements by name or slug"
          className="max-w-xs"
        />
        <div className="w-40">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as EngagementStatus | 'all')}
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            {ENGAGEMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner size={26} />
        </div>
      ) : isError ? (
        <ErrorState description="Couldn’t load engagements." onRetry={() => refetch()} />
      ) : !engagements || engagements.length === 0 ? (
        <EmptyState
          title="No engagements yet"
          description="Engagements created by anyone on this server will appear here."
        />
      ) : filtered.length === 0 && filtersActive ? (
        <EmptyState
          title="No engagements match your filters"
          description="Try a different search or status."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setSearch('');
                setStatus('all');
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <SortableTh direction={directionOf('name')} onSort={() => toggleSort('name')}>
                Name
              </SortableTh>
              <SortableTh direction={directionOf('status')} onSort={() => toggleSort('status')}>
                Status
              </SortableTh>
              <SortableTh
                align="right"
                direction={directionOf('members')}
                onSort={() => toggleSort('members')}
              >
                Members
              </SortableTh>
              <SortableTh
                align="right"
                direction={directionOf('evidence')}
                onSort={() => toggleSort('evidence')}
              >
                Evidence
              </SortableTh>
              <SortableTh
                align="right"
                direction={directionOf('findings')}
                onSort={() => toggleSort('findings')}
              >
                Findings
              </SortableTh>
              <SortableTh direction={directionOf('created')} onSort={() => toggleSort('created')}>
                Created
              </SortableTh>
              <Th />
            </Tr>
          </Thead>
          <Tbody>
            {ordered.map((eng) => (
              <AdminEngagementRow key={eng.slug} eng={eng} />
            ))}
          </Tbody>
        </Table>
      )}
    </div>
  );
}

function AdminEngagementRow({ eng }: { eng: AdminEngagement }) {
  const toast = useToast();
  const confirm = useConfirm();
  const remove = useDeleteEngagement(eng.slug);

  async function confirmDelete() {
    const ok = await confirm({
      title: 'Delete engagement',
      message: `Delete “${eng.name}”? This permanently removes the engagement and all of its evidence, findings, tags, saved queries, and members. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync();
      toast.success('Engagement deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete engagement');
    }
  }

  return (
    <Tr>
      <Td>
        <div className="flex items-center gap-2">
          <Link
            to={`/engagements/${eng.slug}/evidence`}
            className="font-medium text-text hover:text-accent"
          >
            {eng.name}
          </Link>
          {!eng.amMember && <span className="text-xs text-muted">not a member</span>}
        </div>
      </Td>
      <Td>
        <Badge tone={STATUS_TONE[eng.status]}>{eng.status}</Badge>
      </Td>
      <Td className="text-right tabular-nums">{eng.numUsers ?? 0}</Td>
      <Td className="text-right tabular-nums">{eng.numEvidence ?? 0}</Td>
      <Td className="text-right tabular-nums">{eng.numFindings ?? 0}</Td>
      <Td className="text-muted">{formatDate(eng.createdAt)}</Td>
      <Td className="text-right">
        <div className="flex justify-end gap-1">
          {/* Ghost-button look, but a real link (no nested interactive elements). */}
          <Link
            to={`/engagements/${eng.slug}/settings`}
            className="inline-flex h-8 items-center rounded-input px-3 text-sm font-medium text-text transition-colors hover:bg-surface-2"
          >
            Settings
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="text-danger"
            onClick={confirmDelete}
            loading={remove.isPending}
          >
            Delete
          </Button>
        </div>
      </Td>
    </Tr>
  );
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
// Cap the logo well under the server's ~1.5 MB base64 limit, measured on the raw
// file (base64 inflates ~33%, so ~1 MB of file ≈ ~1.35 MB encoded).
const MAX_LOGO_BYTES = 1_000_000;
const LOGO_ACCEPT = 'image/png,image/jpeg,image/svg+xml,image/webp';

function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

function ReportBrandingTab() {
  const { data: settings, isLoading, isError, refetch } = useReportSettings();
  const update = useUpdateReportSettings();
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [organizationName, setOrganizationName] = useState('');
  const [accentColor, setAccentColor] = useState('#2563eb');
  const [logoDataUri, setLogoDataUri] = useState<string | null>(null);
  const [footerNote, setFooterNote] = useState('');

  // Seed the form once the settings load (and again if they change on refetch).
  useEffect(() => {
    if (settings) {
      setOrganizationName(settings.organizationName);
      setAccentColor(settings.accentColor);
      setLogoDataUri(settings.logoDataUri);
      setFooterNote(settings.footerNote ?? '');
    }
  }, [settings]);

  const accentValid = HEX_RE.test(accentColor);

  async function onPickLogo(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      toast.error('Logo is too large — pick an image under 1 MB.');
      return;
    }
    try {
      setLogoDataUri(await readFileAsDataUri(file));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read the image');
    } finally {
      // Allow re-selecting the same file after a clear.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function clearLogo() {
    setLogoDataUri(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function save() {
    if (!organizationName.trim()) {
      toast.error('Organization name is required.');
      return;
    }
    if (!accentValid) {
      toast.error('Accent color must be a #rrggbb hex value.');
      return;
    }
    const patch: UpdateReportSettingsInput = {
      organizationName: organizationName.trim(),
      accentColor,
      logoDataUri,
      footerNote: footerNote.trim() === '' ? null : footerNote.trim(),
    };
    try {
      await update.mutateAsync(patch);
      toast.success('Report branding saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save report branding');
    }
  }

  if (isLoading) return <Spinner />;
  if (isError)
    return <ErrorState description="Couldn’t load report branding." onRetry={() => refetch()} />;

  return (
    <Card className="max-w-2xl space-y-5 p-4">
      <p className="text-sm text-muted">
        Branding applied to the cover and footer of every exported report PDF, server-wide.
      </p>

      <Field label="Organization name" htmlFor="rb-org">
        <Input
          id="rb-org"
          value={organizationName}
          onChange={(e) => setOrganizationName(e.target.value)}
          placeholder="Acme Security"
        />
      </Field>

      <Field
        label="Accent color"
        htmlFor="rb-accent-hex"
        hint="Used for headings and rules on the report."
        error={accentValid ? undefined : 'Enter a #rrggbb hex color.'}
      >
        <div className="flex items-center gap-2">
          <input
            aria-label="Accent color picker"
            type="color"
            value={accentValid ? accentColor : '#2563eb'}
            onChange={(e) => setAccentColor(e.target.value)}
            className="h-9 w-12 cursor-pointer rounded-input border border-border bg-surface p-1"
          />
          <Input
            id="rb-accent-hex"
            value={accentColor}
            onChange={(e) => setAccentColor(e.target.value)}
            placeholder="#2563eb"
            className="max-w-[10rem] font-mono"
          />
        </div>
      </Field>

      <Field
        label="Cover logo"
        hint="PNG, JPEG, SVG, or WebP under 1 MB. Cleared logos fall back to a text wordmark."
      >
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-16 w-40 items-center justify-center overflow-hidden rounded-input border border-border bg-surface-2">
            {logoDataUri ? (
              <img src={logoDataUri} alt="Report logo preview" className="max-h-14 max-w-36" />
            ) : (
              <span className="px-2 text-sm font-semibold text-muted">
                {organizationName.trim() || 'Wordmark'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={LOGO_ACCEPT}
              aria-label="Upload cover logo"
              onChange={(e) => onPickLogo(e.target.files?.[0])}
              className="text-sm text-muted file:mr-3 file:rounded-input file:border file:border-border file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-text hover:file:bg-surface"
            />
            {logoDataUri && (
              <Button variant="ghost" size="sm" onClick={clearLogo}>
                Remove
              </Button>
            )}
          </div>
        </div>
      </Field>

      <Field
        label="Footer note"
        htmlFor="rb-footer"
        hint="e.g. “Confidential”. Shown on every page."
      >
        <Input
          id="rb-footer"
          value={footerNote}
          onChange={(e) => setFooterNote(e.target.value)}
          placeholder="Confidential"
        />
      </Field>

      <Button
        onClick={save}
        loading={update.isPending}
        disabled={!organizationName.trim() || !accentValid}
      >
        Save branding
      </Button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Report templates — the site-wide library of saved report configurations
// ---------------------------------------------------------------------------

/**
 * How much of the report a template turns on — "5 of 9", with the enabled section
 * names on hover, so two templates can be told apart without opening either.
 * Counted from the stored configuration rather than from a saved tally, so a
 * template written before a section existed still counts honestly.
 */
function TemplateSectionsCell({ config }: { config: ReportTemplateConfig }) {
  const enabled = config.sections.filter((s) => s.enabled);
  const customCount = config.customSections.length;
  return (
    <div
      title={
        enabled.length === 0
          ? 'No sections enabled — a report from this template would carry only its cover pages.'
          : `Enabled: ${enabled.map((s) => sectionLabel(s.key, config.customSections)).join(', ')}`
      }
    >
      <span className="tabular-nums">
        {enabled.length} of {config.sections.length}
      </span>
      {/* Custom sections travel inside the template, so they're worth counting
          separately: they're the part of a template that isn't reproducible from
          this build's section list. */}
      {customCount > 0 && (
        <span className="block text-xs text-muted">
          {customCount} custom section{customCount === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}

/**
 * The report-template library. A template is global — any engagement can apply one
 * or generate a single report from one — so it is curated here, alongside the other
 * site-wide lists (default tags, report branding) rather than inside one engagement.
 *
 * Nothing here is gated client-side. The server's rule for changing the library is
 * write (or admin) on at least one engagement, or site admin — deliberately not
 * site admin alone — and this page has no cheap way to learn whether someone holds
 * a write role somewhere, so the controls stay live and a refusal is surfaced in
 * the server's own words. In practice every visitor already passes that rule, since
 * App.tsx routes `/admin` for site admins only; the operators who actually write
 * reports save and apply templates from an engagement's Reports tab instead.
 */
function ReportTemplatesTab() {
  const { data: templates, isLoading, isError, refetch } = useReportTemplates();
  const removeTemplate = useDeleteReportTemplate();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<ReportTemplate | null>(null);

  /**
   * A plain confirm, not a type-the-name one: deleting a template destroys no
   * report and no configuration — only the library entry — and the same settings
   * can be saved again from any engagement that still has them.
   */
  async function confirmDelete(t: ReportTemplate) {
    const ok = await confirm({
      title: 'Delete report template',
      message: (
        <span className="block space-y-2">
          <span className="block">
            Delete the report template <span className="font-semibold">{t.name}</span>?
          </span>
          <span className="block">
            Applying a template copies its settings into the engagement rather than linking to it,
            so every engagement that already applied this one keeps its report configuration, and
            reports already generated from it keep their history entry. Only the library entry goes.
          </span>
          <span className="block">
            Any engagement still configured this way can save it again from Reports → Configure.
          </span>
        </span>
      ),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await removeTemplate.mutateAsync(t.uuid);
      toast.success('Report template deleted');
    } catch (err) {
      // A 403 here is the server's write-to-manage rule talking, and it words the
      // requirement precisely — pass it through rather than guess at the reason.
      toast.error(err instanceof Error ? err.message : 'Could not delete the report template');
    }
  }

  return (
    <div className="space-y-4">
      <div className="max-w-3xl space-y-1">
        <p className="text-sm text-muted">
          A report template is a saved report configuration: which sections are in, their order and
          per-section options, any custom sections, and how evidence and findings are grouped. Any
          engagement can apply one to its own configuration, or generate a single report from one
          without changing anything. The library is shared site-wide.
        </p>
        <p className="text-xs text-muted">
          Saving, renaming and deleting a template needs write access to at least one engagement, so
          the operators who write reports curate this list, not site admins alone; applying one, or
          generating with one, needs only an account. A template never carries an engagement’s
          report-readiness “not applicable” marks — those stay with the engagement that made them.
        </p>
      </div>
      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <ErrorState description="Couldn’t load report templates." onRetry={() => refetch()} />
      ) : !templates || templates.length === 0 ? (
        <EmptyState
          title="No report templates yet"
          description="Templates are saved from an engagement, not from here: open Reports → Configure, set the report up the way you want it, then choose “Save as template”. It appears in this library for every engagement to apply."
          action={
            <Link to="/engagements" className="text-sm font-medium text-accent hover:underline">
              Go to engagements
            </Link>
          }
        />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Template</Th>
              <Th>Sections</Th>
              <Th>Sanitize</Th>
              <Th>Created by</Th>
              <Th>Updated</Th>
              <Th />
            </Tr>
          </Thead>
          <Tbody>
            {templates.map((t) => (
              <Tr key={t.uuid}>
                <Td>
                  <div className="font-medium text-text">{t.name}</div>
                  {t.description && (
                    <div className="max-w-md text-xs text-muted">{t.description}</div>
                  )}
                </Td>
                <Td className="whitespace-nowrap">
                  <TemplateSectionsCell config={t.config} />
                </Td>
                <Td>
                  <TemplateSanitizeBadge config={t.config} />
                </Td>
                {/* The author survives their own deletion as the shared stand-in
                    byline — the template outlives the account that saved it. */}
                <Td className="text-muted">{userDisplayName(t.createdBy)}</Td>
                <Td
                  className="whitespace-nowrap text-muted"
                  title={`Saved ${formatDateTime(t.createdAt)}`}
                >
                  {formatDateTime(t.updatedAt)}
                </Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(t)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger"
                      loading={removeTemplate.isPending && removeTemplate.variables === t.uuid}
                      onClick={() => confirmDelete(t)}
                    >
                      Delete
                    </Button>
                  </div>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
      <EditReportTemplateModal template={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

/**
 * Rename a template or reword its description. The configuration itself isn't
 * editable here, deliberately: it is a snapshot of a real engagement's live report
 * configuration, so it is replaced by saving over the template from Reports →
 * Configure, where there is a configuration to snapshot and a preview to check it
 * against.
 */
function EditReportTemplateModal({
  template,
  onClose,
}: {
  template: ReportTemplate | null;
  onClose: () => void;
}) {
  const update = useUpdateReportTemplate();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // Seed the form from whichever row was opened, and re-seed when another row is
  // opened or the same one is reopened after an abandoned edit.
  useEffect(() => {
    if (template) {
      setName(template.name);
      setDescription(template.description);
    }
  }, [template]);

  /**
   * Only the fields that actually changed are sent. Every field of the patch is
   * optional, and an empty save would still bump `updatedAt` (the server stamps it
   * on every write), which would make the Updated column claim an edit that never
   * happened. Both values are compared trimmed because the server trims the name.
   */
  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const patch: UpdateReportTemplateInput = {
    ...(template && trimmedName !== template.name ? { name: trimmedName } : {}),
    ...(template && trimmedDescription !== template.description
      ? { description: trimmedDescription }
      : {}),
  };
  const dirty = Object.keys(patch).length > 0;

  async function save() {
    if (!template) return;
    try {
      await update.mutateAsync({ uuid: template.uuid, patch });
      toast.success('Report template updated');
      onClose();
    } catch (err) {
      // 409 (the name is already in the library) and 403 (not a template manager)
      // both arrive worded by the server; show that instead of a generic failure.
      toast.error(err instanceof Error ? err.message : 'Could not update the report template');
    }
  }

  return (
    <Modal
      open={Boolean(template)}
      onClose={onClose}
      title="Edit report template"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={update.isPending} disabled={!trimmedName || !dirty}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {/* The caps mirror `updateReportTemplateInput`, so the field fills up
            rather than the save failing validation. */}
        <Field label="Name" htmlFor="rt-name" hint="Unique across the library." required>
          <Input
            id="rt-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            autoFocus
          />
        </Field>
        <Field
          label="Description"
          htmlFor="rt-description"
          hint="What this template is for — what a teammate needs to know before applying it."
        >
          <Textarea
            id="rt-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            placeholder="Client-facing deliverable: findings and executive summary only, evidence sanitized."
          />
        </Field>
      </div>
    </Modal>
  );
}
