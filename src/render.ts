// CLI output renderer — color, tables, icons, spinner, output-mode resolution.
//
// Two output modes coexist across every command:
//
//   human  — pretty default, ANSI color when stdout is a TTY and NO_COLOR/
//            FLAIR_NO_COLOR aren't set
//   json   — agent-default, also auto-selected when stdout is piped
//
// Precedence: --json flag > FLAIR_OUTPUT=json env > non-TTY stdout > TTY (human).
// Setting FLAIR_OUTPUT=human forces human mode even when piped.
//
// No third-party deps — minimal ANSI by hand keeps the dependency tree flat
// (the rest of the flair runtime already runs ANSI-free; we don't need
// chalk/picocolors' edge-case coverage for SGR codes we don't use).

const stdoutIsTTY = !!process.stdout.isTTY;
const stderrIsTTY = !!process.stderr.isTTY;
const noColorEnv = process.env.NO_COLOR != null || process.env.FLAIR_NO_COLOR != null;

const enableColor = stdoutIsTTY && !noColorEnv;
const C = (code: string) => (enableColor ? `\x1b[${code}m` : "");

export const c = {
  reset: C("0"),
  bold: C("1"),
  dim: C("2"),
  italic: C("3"),
  underline: C("4"),
  red: C("31"),
  green: C("32"),
  yellow: C("33"),
  blue: C("34"),
  magenta: C("35"),
  cyan: C("36"),
  white: C("37"),
  gray: C("90"),
};

export function wrap(color: string, text: string): string {
  if (!color) return text;
  return `${color}${text}${c.reset}`;
}

export type OutputMode = "human" | "json";

export function resolveOutputMode(opts: { json?: boolean }): OutputMode {
  if (opts.json) return "json";
  const envOut = process.env.FLAIR_OUTPUT;
  if (envOut === "json") return "json";
  if (envOut === "human") return "human";
  // No explicit selection — pipe-friendly default: non-TTY stdout → json.
  return stdoutIsTTY ? "human" : "json";
}

export const icons = {
  ok: wrap(c.green, "✓"),
  warn: wrap(c.yellow, "⚠"),
  error: wrap(c.red, "✗"),
  info: wrap(c.cyan, "ℹ"),
  bullet: wrap(c.gray, "·"),
  pending: wrap(c.gray, "○"),
  arrow: wrap(c.gray, "→"),
};

// Status header: bullet + bold label. Use for top-level command titles.
export function header(label: string): string {
  return wrap(c.bold, label);
}

// Section divider — used between groups inside one command's output.
// Subtle line + bold label, no big ═══ banners (those compete with content).
export function section(label: string): string {
  return `\n${wrap(c.bold, label)}\n${wrap(c.gray, "─".repeat(Math.min(60, label.length + 8)))}`;
}

// Key/value pair with aligned label. Default label width 14 cols.
export function kv(label: string, value: string, labelWidth = 14): string {
  return `  ${wrap(c.dim, label.padEnd(labelWidth))} ${value}`;
}

// Table renderer. Columns can specify label, key, alignment, and a per-value
// format function. Header row is dim; data rows plain.
export interface TableColumn {
  label: string;
  key: string;
  align?: "left" | "right";
  format?: (value: unknown, row: Record<string, unknown>) => string;
}

export function table(
  columns: TableColumn[],
  rows: Array<Record<string, unknown>>,
): string {
  if (rows.length === 0) return wrap(c.dim, "  (no rows)");
  const widths = columns.map((col) => col.label.length);
  const cells: string[][] = rows.map((row) =>
    columns.map((col, i) => {
      const raw = row[col.key];
      const formatted = col.format ? col.format(raw, row) : raw == null ? "—" : String(raw);
      // Visible-width calculation — strip our own ANSI escapes before counting
      const visibleLen = formatted.replace(/\x1b\[[0-9;]*m/g, "").length;
      if (visibleLen > widths[i]) widths[i] = visibleLen;
      return formatted;
    }),
  );

  const align = (str: string, width: number, side?: "left" | "right") => {
    const visibleLen = str.replace(/\x1b\[[0-9;]*m/g, "").length;
    const pad = " ".repeat(Math.max(0, width - visibleLen));
    return side === "right" ? pad + str : str + pad;
  };

  const headerRow =
    "  " +
    columns.map((col, i) => wrap(c.dim, align(col.label, widths[i], col.align))).join("  ");
  const bodyRows = cells
    .map((row) => "  " + row.map((cell, i) => align(cell, widths[i], columns[i].align)).join("  "))
    .join("\n");
  return `${headerRow}\n${bodyRows}`;
}

// Spinner for long-running operations. Writes to stderr so stdout stays clean
// for human or JSON output. No-op when stderr isn't a TTY (CI, piped error
// stream): just emits a one-line note at start.
export interface Spinner {
  stop(final?: string): void;
  update(label: string): void;
}

export function spinner(label: string): Spinner {
  if (!stderrIsTTY || noColorEnv) {
    process.stderr.write(`${label}...\n`);
    return {
      stop: (final?: string) => {
        if (final) process.stderr.write(`${final}\n`);
      },
      update: (next: string) => {
        process.stderr.write(`${next}...\n`);
      },
    };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let current = label;
  let i = 0;
  const handle = setInterval(() => {
    process.stderr.write(`\r${wrap(c.cyan, frames[i])} ${current}`);
    i = (i + 1) % frames.length;
  }, 80);
  return {
    stop: (final?: string) => {
      clearInterval(handle);
      process.stderr.write("\r\x1b[K");
      if (final) process.stderr.write(`${final}\n`);
    },
    update: (next: string) => {
      current = next;
    },
  };
}

// Canonical JSON output: 2-space indent, trailing newline omitted by caller.
export function asJSON(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// Bytes → human readable. Mirror of humanBytes in cli.ts; centralizing here
// so render-aware code shares the same format.
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ISO timestamp → "12m ago" / "2h ago" / "5d ago" / "—" (null) / fallback.
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ago = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ago) || ago < 0) return "—";
  const mins = Math.floor(ago / 60000);
  const hrs = Math.floor(ago / 3600000);
  const days = Math.floor(ago / 86400000);
  return days > 0 ? `${days}d ago` : hrs > 0 ? `${hrs}h ago` : mins > 0 ? `${mins}m ago` : "just now";
}

// Convenience: print the right shape for the resolved output mode.
// Caller passes both representations and the resolveOutputMode result.
export function print(mode: OutputMode, jsonValue: unknown, humanText: string): void {
  if (mode === "json") {
    console.log(asJSON(jsonValue));
  } else {
    console.log(humanText);
  }
}
