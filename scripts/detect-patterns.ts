// Pattern detection over stored candles (lib/pattern-store.ts). Resumable and idempotent.
//
//   npm run patterns -- --dry-run --limit 200000      preview: detect + report, write nothing
//   npm run patterns                                   historical backfill (resumes from checkpoint)
//   npm run patterns -- --incremental                  only candles newer than the checkpoint
//   npm run patterns -- --reset                        wipe this symbol+interval's detections and rescan
//   options: --symbol BTCUSDT  --interval 1h (default)  --page 50000

import { pool } from "../lib/db";
import { runDetection, type RunReport } from "../lib/pattern-store";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const iso = (ts: number | null) => (ts === null ? "-" : new Date(ts).toISOString().replace(".000Z", "Z"));

function line(r: RunReport) {
  return `${r.symbol} ${r.interval} through ${iso(r.lastTs)} | scanned ${r.scanned.toLocaleString()} | found ${r.found.toLocaleString()} | new ${r.inserted.toLocaleString()} | skipped ${r.skipped} | ${(r.ms / 1000).toFixed(1)}s`;
}

async function main() {
  const report = await runDetection({
    symbol: (opt("symbol") ?? "BTCUSDT").toUpperCase(),
    interval: opt("interval") ?? "1h",
    mode: flag("incremental") ? "incremental" : "backfill",
    dryRun: flag("dry-run"),
    reset: flag("reset"),
    limit: opt("limit") ? Number(opt("limit")) : undefined,
    pageSize: opt("page") ? Number(opt("page")) : undefined,
    onPage: (r) => process.stdout.write(`\r${line(r)}   `),
  });
  console.log(`\n${report.status.toUpperCase()}: ${line(report)}`);
  console.log("by pattern:", report.byPattern);
  if (report.invalid) console.log("invalid/duplicate rows dropped:", report.invalid);
  if (report.dryRun) console.log("sample:", report.sample.slice(0, 5).map((d) => `${iso(d.ts)} ${d.pattern} (${d.direction})`));
  if (report.errors.length) {
    console.error("errors:", report.errors);
    process.exitCode = 1;
  }
}

main().finally(() => pool.end());
