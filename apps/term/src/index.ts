import { join } from 'node:path';
import { Command, Option } from 'commander';
import * as p from '@clack/prompts';
import { uuidSchema } from '@reporter/shared';
import { CONFIG_PATH, loadConfig, type TermConfig } from './config.js';
import { runWizard } from './wizard.js';
import { recordSession } from './record.js';
import { handleRecording, promptAndUpload } from './postSession.js';
import { banner, c, sym } from './theme.js';

/** Load config, or launch first-run setup if none exists. */
async function ensureConfig(): Promise<TermConfig | null> {
  const cfg = await loadConfig();
  if (cfg) return cfg;
  console.log(`${sym.warn} No configuration found — let's set up reporter-term.\n`);
  return runWizard();
}

/** Validate the optional --link-to evidence UUID, exiting on a bad value. */
function resolveLinkTo(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    console.error(`${sym.err} --link-to must be a valid evidence UUID`);
    process.exit(1);
  }
  return parsed.data;
}

/**
 * Validate an optionally-supplied --title, exiting on an empty/whitespace value.
 * Returns the trimmed title, or `undefined` when the flag was omitted (so the
 * interactive prompt collects it instead).
 */
function resolveTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) {
    console.error(`${sym.err} --title must not be empty`);
    process.exit(1);
  }
  return trimmed;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

const program = new Command();
program
  .name('reporter-term')
  .description('Record terminal sessions and upload them to reporter as evidence')
  .version('0.12.0');

program
  .command('record', { isDefault: true })
  .description('Record a terminal session (default)')
  .option('--link-to <uuid>', 'File this recording as linked evidence on existing evidence (UUID)')
  // Deprecated alias of --link-to, hidden from help but still accepted.
  .addOption(new Option('--comment-on <uuid>').hideHelp())
  .action(async (opts: { linkTo?: string; commentOn?: string }) => {
    const config = await ensureConfig();
    if (!config) return;
    const parentEvidenceUuid = resolveLinkTo(opts.linkTo ?? opts.commentOn);
    console.log(`\n${banner()}`);
    console.log(c.muted('Recording — type "exit" or press Ctrl-D to stop.\n'));
    const outputPath = join(config.outputDir, `${timestamp()}.cast`);
    const { castPath } = await recordSession({ shell: config.shell, outputPath });
    console.log();
    await handleRecording(config, castPath, parentEvidenceUuid);
  });

program
  .command('setup')
  .description('Configure the server URL, API keys, and shell')
  .action(async () => {
    await runWizard(await loadConfig());
  });

program
  .command('config')
  .description('Show the config file path and current values')
  .action(async () => {
    const cfg = await loadConfig();
    console.log(`Config file: ${c.accent(CONFIG_PATH)}`);
    if (!cfg) {
      console.log(c.muted('(not configured — run `reporter-term setup`)'));
      return;
    }
    console.log(`  Server URL:  ${cfg.serverUrl}`);
    console.log(`  Access key:  ${cfg.accessKey}`);
    console.log(`  Secret key:  ${'*'.repeat(8)} ${c.muted('(hidden)')}`);
    console.log(`  Shell:       ${cfg.shell ?? '(default)'}`);
    console.log(`  Output dir:  ${cfg.outputDir}`);
  });

program
  .command('upload <file>')
  .description('Upload a saved .cast recording')
  .option('--title <title>', 'Title for the evidence (skips the Title prompt)')
  .option('--link-to <uuid>', 'File this recording as linked evidence on existing evidence (UUID)')
  // Deprecated alias of --link-to, hidden from help but still accepted.
  .addOption(new Option('--comment-on <uuid>').hideHelp())
  .action(async (file: string, opts: { title?: string; linkTo?: string; commentOn?: string }) => {
    const config = await ensureConfig();
    if (!config) return;
    const parentEvidenceUuid = resolveLinkTo(opts.linkTo ?? opts.commentOn);
    const title = resolveTitle(opts.title);
    p.intro(banner());
    await promptAndUpload(config, file, parentEvidenceUuid, { title });
    p.outro('Done.');
  });

program.parseAsync(process.argv).catch((err) => {
  // Print a clean, actionable message (e.g. the spawn-helper guidance from
  // record.ts) instead of dumping a raw stack trace.
  console.error(`\n${sym.err} ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
