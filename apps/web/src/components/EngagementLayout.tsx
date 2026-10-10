import { NavLink, Outlet, useParams } from 'react-router-dom';
import { Badge, Spinner } from '@reporter/ui';
import { useEngagement } from '../api/hooks.js';
import { formatDate } from '../lib/format.js';
import { useEngagementPermissions } from '../lib/permissions.js';
import { ProgressBar } from './goals/ProgressBar.js';

const STATUS_TONE = { active: 'success', complete: 'info', archived: 'neutral' } as const;

export function EngagementLayout() {
  const { slug = '' } = useParams();
  const { data: eng, isLoading, isError } = useEngagement(slug);
  // Same query key as the line above, so TanStack dedupes: no second request.
  const { canWrite } = useEngagementPermissions(slug);

  // Tab order is array order. The Audit log is the first tab hidden by role
  // rather than rendered disabled (DESIGN.md's rule is for controls, not
  // navigation): a read-only member has nothing to do there, and the log
  // records membership and settings changes they see nowhere else. It hides
  // only once the role is KNOWN to be read-only — `canWrite` reports false
  // while the engagement is still loading (lib/permissions.ts), and this strip
  // sits outside the `isLoading` guard below, so hiding on an unknown role
  // would flicker the tab in on every load and yank it from under a user
  // sitting on it during a refetch. A failed load keeps it too: the page
  // behind it gates itself.
  const roleKnown = eng !== undefined;
  const showAuditLog = canWrite || !roleKnown;

  const tabs = [
    { to: 'evidence', label: 'Evidence' },
    { to: 'goals', label: 'Goals' },
    { to: 'findings', label: 'Findings' },
    { to: 'reports', label: 'Reports' },
    { to: 'queries', label: 'Saved queries' },
    ...(showAuditLog ? [{ to: 'audit-log', label: 'Audit log' }] : []),
    { to: 'settings', label: 'Settings' },
  ];

  const hasProgress = Boolean(eng?.progress && eng.progress.total > 0);

  return (
    <div>
      <div className="mb-4">
        {isLoading ? (
          <Spinner />
        ) : isError || !eng ? (
          <p className="text-danger">Couldn't load this engagement.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold text-text">{eng.name}</h1>
            <Badge tone={STATUS_TONE[eng.status]}>{eng.status}</Badge>
            <span className="text-sm text-muted">Evidence ({eng.numEvidence ?? 0})</span>
            {(eng.numFindings ?? 0) > 0 && (
              <span className="text-sm text-muted">Findings ({eng.numFindings})</span>
            )}
            <span className="text-sm text-muted">Started {formatDate(eng.startedAt)}</span>
            {eng.actualEndAt ? (
              <span className="text-sm text-muted">Ended {formatDate(eng.actualEndAt)}</span>
            ) : eng.projectedEndAt ? (
              <span className="text-sm text-muted">Due {formatDate(eng.projectedEndAt)}</span>
            ) : null}
            {hasProgress && eng.progress && (
              <div className="flex min-w-40 items-center gap-2">
                <ProgressBar progress={eng.progress} className="w-32" />
                <span className="text-sm text-muted">{eng.progress.percent}% goals</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mb-6 flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) =>
              `-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'border-accent text-text'
                  : 'border-transparent text-muted hover:text-text'
              }`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </div>

      <Outlet />
    </div>
  );
}
