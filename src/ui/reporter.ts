import { pathToFileURL } from "node:url";
import { createColors } from "picocolors";

type Colors = ReturnType<typeof createColors>;

export interface ReporterOptions {
  /** Force color on/off. Defaults to auto (stdout is a TTY and NO_COLOR unset). */
  color?: boolean;
  /**
   * Force how {@link Reporter.fileLink} renders links. Defaults to auto-detection
   * from color + `TERM_PROGRAM` (see {@link resolveLinkStyle}). Mainly for tests.
   */
  linkStyle?: LinkStyle;
  /** Suppress everything except errors. */
  quiet?: boolean;
  /** Sink for normal output (one call per line). Defaults to stdout. */
  out?: (line: string) => void;
  /** Sink for errors. Defaults to stderr. */
  err?: (line: string) => void;
}

/**
 * How a file link should be rendered so the user can open it:
 *  - `"osc8"` — an OSC 8 hyperlink wrapping a short label. Clickable in iTerm2,
 *    VS Code, WezTerm, kitty, Ghostty, and most modern emulators.
 *  - `"url"` — a bare `file://` URL as visible text. Terminals that ignore OSC 8
 *    but detect URLs (Apple Terminal, Warp) make it Cmd-clickable; the tradeoff
 *    is a longer, absolute path on screen.
 *  - `"path"` — plain text, no link. For piped / `NO_COLOR` / quiet output so
 *    logs and pipelines stay clean.
 */
export type LinkStyle = "osc8" | "url" | "path";

/** Terminals that ignore OSC 8 but do make a written-out `file://` URL clickable. */
const OSC8_UNSUPPORTED = new Set(["Apple_Terminal", "WarpTerminal"]);

/**
 * Whether the current terminal renders OSC 8 hyperlinks as clickable links.
 * Most modern emulators do, so we denylist the known exceptions (Apple Terminal
 * has no support; Warp ignores OSC 8) rather than allowlist.
 */
export function supportsOsc8Hyperlinks(env: NodeJS.ProcessEnv = process.env): boolean {
  const program = env["TERM_PROGRAM"];
  return program === undefined || !OSC8_UNSUPPORTED.has(program);
}

/**
 * Pick the link style for the current environment: none when output isn't a
 * colored TTY (piped/quiet), an OSC 8 link when the terminal supports it, else a
 * clickable `file://` URL for terminals (Apple Terminal, Warp) that only detect URLs.
 */
export function resolveLinkStyle(color: boolean, env: NodeJS.ProcessEnv = process.env): LinkStyle {
  if (!color) return "path";
  return supportsOsc8Hyperlinks(env) ? "osc8" : "url";
}

const SYM = {
  step: "›",
  ok: "✓",
  fail: "✗",
  warn: "⚠",
  skip: "⊘",
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

/** One row of a {@link Reporter.board}: a stable `key` and its display `label`. */
export interface BoardItem {
  key: string;
  label: string;
}

/**
 * A board row's lifecycle. `queued`/`running` animate; `ok`/`fail`/`skipped` are
 * terminal. `skipped` marks a row that never ran (disabled or backend
 * unavailable) — a neutral, non-alarming state distinct from a failed run.
 */
export type BoardStatus = "queued" | "running" | "ok" | "fail" | "skipped";

/**
 * A live multi-line status board (one row per item). On a TTY the rows animate
 * and update in place; off-TTY it degrades to printing each row once as it
 * reaches a terminal state.
 */
export interface Board {
  /** Update a row. `detail` is shown for terminal states (e.g. "3 findings"). */
  set(key: string, status: BoardStatus, detail?: string): void;
  /** Freeze the final rows and stop animating. */
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
  /** How {@link fileLink} renders links, matched to the current terminal. */
  private readonly linkStyle: LinkStyle;

  constructor(options: ReporterOptions = {}) {
    const color =
      options.color ?? (process.stdout.isTTY === true && !process.env["NO_COLOR"]);
    this.c = createColors(color);
    this.linkStyle = options.linkStyle ?? resolveLinkStyle(color);
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

  /**
   * A completed pipeline step, e.g. `› parsed PR URL      ✓`. `state` is `true`
   * (✓), `false` (✗), or `"skipped"` for a neutral, non-alarming ⊘.
   */
  step(label: string, state: boolean | "skipped" = true): void {
    const mark =
      state === "skipped"
        ? this.c.dim(SYM.skip)
        : state
          ? this.c.green(SYM.ok)
          : this.c.red(SYM.fail);
    this.print(`  ${this.c.dim(SYM.step)} ${label.padEnd(24)} ${mark}`);
  }

  info(message: string): void {
    this.print(`  ${message}`);
  }

  note(message: string): void {
    this.print(`  ${this.c.dim(message)}`);
  }

  /**
   * Render `text` as a link that opens the local file at `absolutePath` (a
   * Cmd-click in most terminals). The form is chosen per terminal (see
   * {@link LinkStyle}): an OSC 8 link where supported, a bare `file://` URL for
   * Apple Terminal / Warp, or plain `text` for piped / non-color output.
   *
   * Returns a string — compose it into `success`/`warn`/`note` messages; it is
   * not printed on its own.
   */
  fileLink(text: string, absolutePath: string): string {
    if (this.linkStyle === "path") return text;
    const url = pathToFileURL(absolutePath).href;
    // A written-out file:// URL is Cmd-clickable in terminals that detect URLs.
    if (this.linkStyle === "url") return url;
    // OSC 8 ; params ; URI  BEL  <text>  OSC 8 ; ;  BEL  (BEL terminator is the most widely supported).
    return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
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

  /**
   * A live multi-line status board — one animated row per item, updated in
   * place (queued → running → ✓/✗). Used by the multi-agent fan-out so the user
   * sees every reviewer and which are still running. Off a TTY (piped / quiet /
   * injected sink) it can't animate, so each row prints once when it resolves —
   * the same clean, line-per-event output the rest of the CLI uses.
   */
  board(items: readonly BoardItem[]): Board {
    interface RowState {
      status: BoardStatus;
      detail: string;
      startedAt: number | null;
    }
    const labels = new Map(items.map((it) => [it.key, it.label]));
    const state = new Map<string, RowState>(
      items.map((it) => [it.key, { status: "queued", detail: "", startedAt: null }]),
    );

    if (!this.canAnimate) {
      // No cursor control: print each row once when it reaches a terminal state,
      // in the `name — detail ✓/✗` shape the streaming steps already use.
      const isTerminal = (s: BoardStatus): boolean =>
        s === "ok" || s === "fail" || s === "skipped";
      return {
        set: (key, status, detail = "") => {
          const row = state.get(key);
          if (!row || !isTerminal(status)) return;
          if (isTerminal(row.status)) return; // resolve once
          row.status = status;
          const state3 = status === "ok" ? true : status === "skipped" ? "skipped" : false;
          this.step(`${labels.get(key) ?? key} — ${detail}`, state3);
        },
        stop: () => {},
      };
    }

    const width = items.reduce((max, it) => Math.max(max, it.label.length), 0);
    // Keep rows inside the terminal so a wrapped line can't break our cursor math.
    const cols = process.stdout.columns ?? 80;
    const labelWidth = Math.min(width, Math.max(8, cols - 20));
    const fitLabel = (label: string): string =>
      label.length > labelWidth ? `${label.slice(0, labelWidth - 1)}…` : label.padEnd(labelWidth);

    const elapsed = (ms: number): string => {
      const s = Math.floor(ms / 1000);
      return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
    };

    let frame = 0;
    const rowText = (it: BoardItem, now: number): string => {
      const row = state.get(it.key)!;
      const mark =
        row.status === "ok"
          ? this.c.green(SYM.ok)
          : row.status === "fail"
            ? this.c.red(SYM.fail)
            : row.status === "skipped"
              ? this.c.dim(SYM.skip)
              : row.status === "running"
                ? this.c.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!)
                : this.c.dim("·");
      const suffix =
        row.status === "running"
          ? this.c.dim(`running ${elapsed(now - (row.startedAt ?? now))}…`)
          : row.status === "queued"
            ? this.c.dim("queued")
            : row.status === "skipped"
              ? this.c.dim(row.detail)
              : row.detail;
      return `    ${mark} ${fitLabel(it.label)}  ${suffix}`;
    };

    // Initial paint: one line per row; the cursor ends on the line below the block.
    for (const it of items) process.stdout.write(`${rowText(it, Date.now())}\n`);

    const redraw = (): void => {
      const now = Date.now();
      process.stdout.write(`\x1b[${items.length}A`); // up to the first row
      for (const it of items) process.stdout.write(`\x1b[2K${rowText(it, now)}\n`); // clear + redraw
      frame++;
    };
    const timer = setInterval(redraw, SPINNER_INTERVAL_MS);
    timer.unref?.();

    let done = false;
    return {
      set: (key, status, detail = "") => {
        const row = state.get(key);
        if (!row || done) return;
        if (status === "running" && row.startedAt === null) row.startedAt = Date.now();
        row.status = status;
        row.detail = detail;
        redraw(); // reflect the change now, don't wait for the next tick
      },
      stop: () => {
        if (done) return;
        done = true;
        clearInterval(timer);
        redraw(); // final frozen state
      },
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
