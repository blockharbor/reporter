import { Badge } from '@reporter/ui';
import type { ReportTemplateConfig } from '@reporter/shared';

/**
 * How a report template treats the two sanitize opt-ins, which decide whether
 * evidence capture times and operator identities reach a client deliverable. Both
 * default to off, so a template that turns either on is the one setting in the
 * library worth noticing before someone applies it or generates with it: it reads as
 * a warning naming exactly what it would reveal, never as a neutral fact.
 *
 * Shared by the engagement Reports tab (save/apply card and the Generate chooser)
 * and the Admin library's table, so one template reads the same wherever it is seen.
 * Unlike `templateSanitizeWarning` (lib/report-templates.ts), this is unconditional —
 * it states what the template does rather than what it would change — so a template
 * whose options the current engagement already has on is still labelled here.
 */
export function TemplateSanitizeBadge({ config }: { config: ReportTemplateConfig }) {
  const shown: string[] = [];
  if (config.showEvidenceTimestamps) shown.push('timestamps');
  if (config.showEvidenceOperators) shown.push('operator names');
  if (shown.length === 0) {
    return (
      <span title="Evidence capture times and operator names stay out of reports made with this template.">
        <Badge tone="neutral">Sanitized</Badge>
      </span>
    );
  }
  return (
    <span title={`Reports made with this template show evidence ${shown.join(' and ')}.`}>
      <Badge tone="warning">Shows {shown.join(' + ')}</Badge>
    </span>
  );
}
