import { createColors } from "picocolors";

type Colors = ReturnType<typeof createColors>;

export interface ReporterOptions {
  /** Force color on/off. Defaults to auto (stdout is a TTY and NO_COLOR unset). */
  color?: boolean;
  /** Suppress everything except errors. */
  quiet?: boolean;
  /** Sink for normal output (one call per line). Defaults to stdout. */
  out?: (line: string) => void;
  /** Sink for errors. Defaults to stderr. */
  err?: (line: string) => void;
}

const SYM = {
  step: "›",
  ok: "✓",
  fail: "✗",
  warn: "⚠",
} as const;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;

/**
 * A running-progress handle. Call `succeed`/`fail` (with the final step label) or
 * `stop` when the awaited work finishes. On a TTY it animates in place; when
 * output is piped/quiet/redirected it degrades to plain start + final lines.
 */
export interface Spinner {
  succeed(label?: string): void;
  fail(label?: string): void;
  stop(): void;
}

/**
 * The single output seam for the CLI. Every command writes through a Reporter
 * so styling, quiet mode, and (later) a machine-readable mode live in one place.
 * The rich progress visuals for the multi-agent fan-out (Phase 6) will extend
 * this same abstraction.
 */
export class Reporter {
  private readonly c: Colors;
  private readonly quiet: boolean;
  private readonly out: (line: string) => void;
  private readonly err: (line: string) => void;
  /** Only animate when we own a real TTY stdout and aren't quiet. */
  private readonly canAnimate: boolean;

  constructor(options: ReporterOptions = {}) {
    const color =
      options.color ?? (process.stdout.isTTY === true && !process.env["NO_COLOR"]);
    this.c = createColors(color);
    this.quiet = options.quiet ?? false;
    this.out = options.out ?? ((line) => process.stdout.write(`${line}\n`));
    this.err = options.err ?? ((line) => process.stderr.write(`${line}\n`));
    this.canAnimate =
      options.out === undefined && process.stdout.isTTY === true && !this.quiet;
  }

  private print(line = ""): void {
    if (!this.quiet) this.out(line);
  }

  /** Title banner, optionally with a dim subtitle (e.g. the version). */
  banner(title: string, subtitle?: string): void {
    const heading = this.c.bold(this.c.cyan(title));
    this.print();
    this.print(subtitle ? `${heading}  ${this.c.dim(subtitle)}` : heading);
    this.print();
  }

  /** Multi-line ASCII wordmark, colored, with an optional dim subtitle below. */
  logo(art: string, subtitle?: string): void {
    this.print();
    for (const line of art.split("\n")) {
      this.print(this.c.cyan(line));
    }
    if (subtitle) this.print(`  ${this.c.dim(subtitle)}`);
    this.print();
  }

  /** Aligned key/value block. */
  keyValues(pairs: ReadonlyArray<readonly [string, string]>, indent = "  "): void {
    const width = pairs.reduce((max, [key]) => Math.max(max, key.length), 0);
    for (const [key, value] of pairs) {
      this.print(`${indent}${this.c.dim(key.padEnd(width))}  ${value}`);
    }
  }

  blank(): void {
    this.print();
  }

  /** A completed pipeline step, e.g. `› parsed PR URL      ✓`. */
  step(label: string, ok = true): void {
    const mark = ok ? this.c.green(SYM.ok) : this.c.red(SYM.fail);
    this.print(`  ${this.c.dim(SYM.step)} ${label.padEnd(24)} ${mark}`);
  }

  info(message: string): void {
    this.print(`  ${message}`);
  }

  note(message: string): void {
    this.print(`  ${this.c.dim(message)}`);
  }

  success(message: string): void {
    this.print(`  ${this.c.green(SYM.ok)} ${message}`);
  }

  warn(message: string): void {
    this.print(`  ${this.c.yellow(SYM.warn)} ${message}`);
  }

  /**
   * Start a spinner for a long-running step. On a TTY it animates a single line
   * in place; otherwise it prints a plain start line. Resolve it with
   * `succeed(label)` / `fail(label)` (prints the final ✓/✗ step) or `stop()`.
   */
  spinner(label: string): Spinner {
    if (!this.canAnimate) {
      // Non-TTY / quiet / injected sink: emit a start line, resolve via step().
      this.print(`  ${this.c.dim(SYM.step)} ${this.c.dim(label)}`);
      let done = false;
      const finish = (final: string | undefined, ok: boolean): void => {
        if (done) return;
        done = true;
        if (final !== undefined) this.step(final, ok);
      };
      return {
        succeed: (l) => finish(l, true),
        fail: (l) => finish(l, false),
        stop: () => finish(undefined, true),
      };
    }

    let i = 0;
    const render = (): void => {
      const frame = this.c.cyan(SPINNER_FRAMES[i % SPINNER_FRAMES.length]!);
      // `\r` returns to line start; `\x1b[K` clears any leftover from a longer frame.
      process.stdout.write(`\r  ${frame} ${label}\x1b[K`);
      i++;
    };
    render();
    const timer = setInterval(render, SPINNER_INTERVAL_MS);
    timer.unref?.(); // never keep the process alive on the spinner alone

    let done = false;
    const finish = (final: string | undefined, ok: boolean): void => {
      if (done) return;
      done = true;
      clearInterval(timer);
      process.stdout.write("\r\x1b[K"); // wipe the spinner line
      if (final !== undefined) this.step(final, ok);
    };
    return {
      succeed: (l) => finish(l, true),
      fail: (l) => finish(l, false),
      stop: () => finish(undefined, true),
    };
  }

  /** Errors always print (even in quiet mode) and go to the error sink. */
  error(message: string): void {
    this.err(`${this.c.red(SYM.fail)} ${message}`);
  }
}

/** A reporter that discards all output — handy for tests. */
export function silentReporter(): Reporter {
  return new Reporter({ color: false, out: () => {}, err: () => {} });
}
