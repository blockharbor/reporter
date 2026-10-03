import { Link } from 'react-router-dom';
import { Badge, Card } from '@reporter/ui';
import type { FindingWarningsResult } from '../../lib/report-readiness.js';

/**
 * Advisory panel beside the readiness checklist: the findings already marked
 * "Ready to report" that the report will nonetheless render incomplete — missing
 * evidence, an unrated severity, no remediation. Deliberately not part of readiness
 * (see `computeFindingWarnings` in `lib/report-readiness.ts` for why): nothing here
 * blocks generation, each row is a judgement call the author may want to ship anyway.
 *
 * Renders nothing when there is nothing to warn about, so a clean engagement sees
 * no empty panel.
 */
export function FindingsNeedingAttention({
  slug,
  result,
}: {
  slug: string;
  result: FindingWarningsResult;
}) {
  if (result.groups.length === 0) return null;
  return (
    <Card className="space-y-3 p-4 lg:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text">Findings needing attention</h3>
          <p className="mt-0.5 text-xs text-muted">
            These findings are marked “Ready to report” but will render incomplete. You can still
            generate the report.
          </p>
        </div>
        <Badge tone="warning">
          {result.findingCount} finding{result.findingCount === 1 ? '' : 's'}
        </Badge>
      </div>

      <div className="space-y-2">
        {result.groups.map((group) => (
          <div
            key={group.kind}
            className="space-y-2 rounded-input border border-border bg-surface-2 p-3"
          >
            <p className="text-xs font-medium text-text">
              {group.label} — {group.findings.length} finding
              {group.findings.length === 1 ? '' : 's'}
            </p>
            <p className="text-xs text-muted">{group.consequence}</p>
            <ul className="space-y-1">
              {group.findings.map((f) => (
                <li key={f.uuid} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm text-muted">
                    {f.title || '(untitled finding)'}
                  </span>
                  {/* Straight to the finding itself — the one page where every one
                      of these warnings can actually be resolved. */}
                  <Link
                    to={`/engagements/${slug}/findings/${f.uuid}`}
                    className="shrink-0 rounded px-1 text-[11px] text-accent hover:underline"
                  >
                    Open
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}
