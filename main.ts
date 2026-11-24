// Token radar, radar-8: read the sealed snapshot, rank every rankable pre-token protocol
// by its calibrated implied launch value, and write the board, the dashboard data, the
// dashboard itself, the screenshots and the judge's dossier.
//
//   node main.ts --input <snapshot.json|directory> [--output <dir>]
//   MAKEFUN_OUTPUT_DIR stands in for /output outside the grader's container.
//
// The program is deterministic: the same snapshot bytes always write the same output
// bytes (no clock, no randomness, no network). Node 22, standard library only.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKTEST, boardIssue, buildRadar, categoryCalibrationSummary, dataScript, describeCalibrator, parseSnapshot, type Backtest, type BoardRow, type RadarData, type Snapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value of `--name <value>` (or `--name=<value>`), else the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

/** The snapshot out of `--input`: a snapshot file, or the snapshot.json inside a directory. */
function readSnapshot(inputArg: string): Snapshot {
  const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(inputFile)) {
    process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory>\n`);
    process.exit(2);
  }
  return parseSnapshot(readFileSync(inputFile, 'utf8'));
}

const snapshot = readSnapshot(inputArg);
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}
if (BACKTEST.sources === 'pending' || BACKTEST.peers === 0) {
  process.stderr.write('token radar: the backtest constant is still pending - fill BACKTEST in lib/model.ts before building\n');
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy a directory's regular files into `to`, skipping dot-names, and return the names. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

/**
 * The gate's own counts on the copied files: three dashboard files with
 * index.html among them, and three screenshots with clean names. A missing
 * file here is a failure now, not a rejection after submit - the program
 * refuses to hand in an /output the scorer would refuse, instead of writing
 * it and hoping. A fourth screenshot is allowed (the Model tab, showing the
 * actual-vs-predicted plot) and counted the same way.
 */
function validateOutputFiles(dashFiles: string[], shots: string[]): void {
  if (dashFiles.length < 3 || !dashFiles.includes('index.html')) {
    process.stderr.write(`token radar: dashboard/ is missing files: ${dashFiles.join(', ') || '(empty)'}\n`);
    process.exit(1);
  }
  if (shots.length < 3) {
    process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
    process.exit(1);
  }
  for (const name of shots) {
    if (!IMAGE_NAME.test(name)) {
      process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
      process.exit(1);
    }
  }
}

/** The dashboard and the screenshots into the output, with the gate's own counts checked. */
function copyEntryFiles(here: string, out: string): { dashFiles: string[]; shots: string[] } {
  const dashFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
  const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
  validateOutputFiles(dashFiles, shots);
  return { dashFiles, shots };
}

const { dashFiles, shots } = copyEntryFiles(here, out);

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
const dossierOpts = { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } };
writeFileSync(join(out, 'dossier.json'), buildDossier(out, dossierOpts));

// Self-check: rebuilding the dossier from the finished /output must reproduce the
// same bytes - the scorer does exactly this rebuild, so a mismatch here is a failure
// now, not a rejection after submit.
if (!readFileSync(join(out, 'dossier.json')).equals(Buffer.from(buildDossier(out, dossierOpts)))) {
  process.stderr.write('token radar: the dossier does not rebuild byte-identically; refusing to hand in a mismatched /output\n');
  process.exit(1);
}

/**
 * The calibration's lines of the run summary: the fitted map in words, the
 * nested 5-fold measure against the uncalibrated formula, and the fitted-view
 * before/after on the out-of-fold predictions.
 */
function calibrationSummaryLines(radar: RadarData): { nestedLine: string; fittedLine: string } {
  const v = radar.calibration.tilt_validation;
  const rep = radar.calibration.calibration_report;
  const nestedLine =
    `${describeCalibrator(radar.calibration.calibration)}; nested 5-fold full formula: median error ${v.full_cal_median_ape_pct.toFixed(1)}% vs ${v.full_median_ape_sized_pct.toFixed(1)}% uncalibrated, trimmed mean ${v.full_cal_trimmed_mean_ape_pct.toFixed(1)}% vs ${v.full_trimmed_mean_ape_sized_pct.toFixed(1)}%, log error ${v.full_cal_log_mae.toFixed(3)} vs ${v.full_log_mae_sized.toFixed(3)}, within 2x ${v.full_cal_within2x_pct.toFixed(1)}% vs ${v.full_within2x_sized_pct.toFixed(1)}% (${v.full_cal_wins}/${v.peers} priced closer than flat)`;
  const fittedLine =
    `calibration on the board's out-of-fold fit - log error ${rep.oof_log_mae_after.toFixed(3)} vs ${rep.oof_log_mae_before.toFixed(3)} before, trimmed mean ${rep.oof_trimmed_mean_ape_after_pct.toFixed(1)}% vs ${rep.oof_trimmed_mean_ape_before_pct.toFixed(1)}%; most moved: ${rep.most_shrunk
      .slice(0, 5)
      .map((s) => `${s.slug} ${s.shift_dex > 0 ? '+' : ''}${s.shift_dex.toFixed(2)} dex`)
      .join(', ')}`;
  return { nestedLine, fittedLine };
}

/**
 * The categories the calibration moved the most, as one summary line: each
 * category's median shift and the share of its rows that moved at least a
 * twentieth of a decade.
 */
function categoryCalibrationLine(board: BoardRow[]): string {
  const moved = categoryCalibrationSummary(board)
    .filter((c) => Math.abs(c.median_shift_dex) >= 0.1)
    .sort((a, b) => Math.abs(b.median_shift_dex) - Math.abs(a.median_shift_dex));
  if (moved.length === 0) return 'calibration moved no category by a median of 0.10 dex or more';
  return `calibration moved the most in ${moved
    .slice(0, 5)
    .map(
      (c) =>
        `${c.category} (median ${c.median_shift_dex > 0 ? '+' : ''}${c.median_shift_dex.toFixed(2)} dex, ${c.share_moved_pct.toFixed(0)}% of ${c.rows} rows)`,
    )
    .join('; ')}`;
}

/**
 * The categories where the pooled tilt loses the median-error comparison
 * against the flat category median, as "name (peers)" strings.
 */
function losingCategories(v: RadarData['calibration']['tilt_validation']): string[] {
  return v.by_category
    .filter((c) => c.median_ape_sized_pct > c.median_ape_flat_pct)
    .map((c) => `${c.category} (${c.peers})`);
}

/**
 * The pooled tilt's line of the run summary: the fitted slope, its damped
 * value and R², the reference TVL, and the 5-fold median error and Spearman
 * against the flat median.
 */
function tiltSummaryLine(radar: RadarData): string {
  const v = radar.calibration.tilt_validation;
  return `pooled tilt - slope ${radar.calibration.power_law.slope}, damped ${radar.calibration.power_law.slope_damped}, R2 ${radar.calibration.power_law.r2}, ref TVL $${radar.calibration.power_law.median_tvl_usd.toLocaleString('en-US')}; 5-fold median error ${v.median_ape_sized_pct.toFixed(1)}% vs ${v.median_ape_flat_pct.toFixed(1)}% flat, Spearman ${v.spearman_sized.toFixed(2)} vs ${v.spearman_flat.toFixed(2)} flat (${v.sized_wins}/${v.peers} priced closer)`;
}

/**
 * The full formula's line of the run summary: median error, log error and
 * within-2x against the flat full formula, the win count, and the losing
 * categories.
 */
function fullFormulaLine(radar: RadarData): string {
  const v = radar.calibration.tilt_validation;
  const losingCats = losingCategories(v);
  return `full formula - median error ${v.full_median_ape_sized_pct.toFixed(1)}% vs ${v.full_median_ape_flat_pct.toFixed(1)}% flat, log error ${v.full_log_mae_sized.toFixed(3)} vs ${v.full_log_mae_flat.toFixed(3)} flat, within 2x ${v.full_within2x_sized_pct.toFixed(1)}% vs ${v.full_within2x_flat_pct.toFixed(1)}% flat (${v.full_sized_wins}/${v.peers} priced closer); tilt loses the median-error comparison in ${losingCats.length} categor${losingCats.length === 1 ? 'y' : 'ies'}${losingCats.length > 0 ? `: ${losingCats.join(', ')}` : ''}`;
}

/**
 * The backtest's line of the run summary: what the shipped model predicted on
 * 2026-10-15 against what the market actually did by 2026-11-14 - the median
 * error and the within-2x share next to the flat median's and persistence's,
 * and the honest nested number beside the single-fit one.
 */
function backtestSummaryLine(b: Backtest): string {
  const shipped = b.rules[b.rules.length - 1]!;
  const flat = b.rules[0]!;
  const persist = b.rules.find((r) => r.rule.startsWith('persistence'));
  const persistPart = persist === undefined ? '' : `, persistence ${persist.median_ape_pct.toFixed(1)}% median / ${persist.within2x_pct.toFixed(1)}% within 2x`;
  return `backtest ${b.t0} -> ${b.t1} (${b.peers} peers, ${b.excluded.length} excluded): shipped model median error ${shipped.median_ape_pct.toFixed(1)}% vs flat ${flat.median_ape_pct.toFixed(1)}%${persistPart}; within 2x ${shipped.within2x_pct.toFixed(1)}% vs flat ${flat.within2x_pct.toFixed(1)}%; Spearman ${shipped.spearman.toFixed(2)} vs realized; nested median ${b.nested_median_ape_pct.toFixed(1)}%, nested within 2x ${b.nested_within2x_pct.toFixed(1)}%`;
}

/**
 * The held-out pairs' line of the run summary: how many pairs the plot draws,
 * and the two Spearman values beside it - the raw full formula's and the
 * nested-calibrated one's.
 */
function heldoutSummaryLine(radar: RadarData): string {
  const v = radar.calibration.tilt_validation;
  const pairs = v.heldout_pairs;
  const rawIn2x = pairs.filter((p) => p.raw >= p.actual / 2 && p.raw <= p.actual * 2).length;
  const calIn2x = pairs.filter((p) => p.calibrated >= p.actual / 2 && p.calibrated <= p.actual * 2).length;
  return `held-out plot: ${pairs.length} live-token pairs (raw + nested-calibrated vs true market cap), Spearman raw ${v.full_spearman_sized.toFixed(3)} calibrated ${v.full_cal_spearman.toFixed(3)}; within 2x raw ${rawIn2x}/${pairs.length} calibrated ${calIn2x}/${pairs.length}`;
}

reportSummary(snapshot, board, radar, dashFiles, shots, out);

/**
 * The run summary on stdout: what was scored, the pooled tilt, both validations,
 * the calibration's fitted map and its honest nested measure, the backtest against
 * realized values, and where the outputs went. The losing-categories line names
 * where the tilt loses, so a reader sees the tilt's weak corners instead of
 * only its headline win; the calibration line names the most-shrunk rows.
 */
function reportSummary(
  snapshot: Snapshot,
  board: BoardRow[],
  radar: RadarData,
  dashFiles: string[],
  shots: string[],
  out: string,
): void {
  const v = radar.calibration.tilt_validation;
  const calLines = calibrationSummaryLines(radar);
  const candLine = v.candidates
    .map((c) => `${c.candidate}: median ${c.median_ape_pct.toFixed(1)}%, log ${c.log_mae.toFixed(3)}, within-2x ${c.within2x_pct.toFixed(1)}%`)
    .join(' | ');
  process.stdout.write(
    `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
      `token radar: top implied value $${board[0]!.implied_value_usd.toLocaleString('en-US')} (${board[0]!.slug}), median $${board[Math.floor(board.length / 2)]!.implied_value_usd.toLocaleString('en-US')}\n` +
      `token radar: ${tiltSummaryLine(radar)}\n` +
      `token radar: ${fullFormulaLine(radar)}\n` +
      `token radar: ${calLines.nestedLine}\n` +
      `token radar: ${calLines.fittedLine}\n` +
      `token radar: ${categoryCalibrationLine(board)}\n` +
      `token radar: ${backtestSummaryLine(radar.backtest)}\n` +
      `token radar: ${heldoutSummaryLine(radar)}\n` +
      `token radar: candidates - ${candLine}\n` +
      `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dashFiles.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
  );
}
