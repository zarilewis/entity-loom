/**
 * Entity Loom — Progress Reporting
 *
 * Terminal-based progress display with counters, bars, and ETA.
 */

const encoder = new TextEncoder();

export class ProgressReporter {
  private current = 0;
  private total: number | undefined;
  private startTime = Date.now();
  private lastUpdate = 0;
  private prefix: string;
  private quiet: boolean;

  constructor(prefix = "[entity-loom]", quiet = false) {
    this.prefix = prefix;
    this.quiet = quiet;
  }

  /** Set the total count for progress tracking */
  setTotal(total: number): void {
    this.total = total;
    this.current = 0;
    this.startTime = Date.now();
  }

  /** Increment the current count and update display */
  increment(): void {
    this.current++;
    this.update();
  }

  /** Set the current count directly */
  setCurrent(current: number): void {
    this.current = current;
    this.update();
  }

  /** Log a message (no progress bar) */
  log(message: string): void {
    if (this.quiet) return;
    this.clearLine();
    Deno.stdout.writeSync(encoder.encode(`${this.prefix} ${message}\n`));
  }

  /** Log an error message */
  error(message: string): void {
    this.clearLine();
    Deno.stderr.writeSync(encoder.encode(`${this.prefix} ERROR: ${message}\n`));
  }

  /** Log a warning message */
  warn(message: string): void {
    this.clearLine();
    Deno.stderr.writeSync(encoder.encode(`${this.prefix} WARN: ${message}\n`));
  }

  /** Update the progress bar display */
  private update(): void {
    if (this.quiet || this.total === undefined) return;

    // Throttle updates to ~10fps
    const now = Date.now();
    if (now - this.lastUpdate < 100) return;
    this.lastUpdate = now;

    const pct = Math.min(100, Math.round((this.current / this.total) * 100));
    const bar = this.renderBar(pct);
    const eta = this.renderETA();

    this.clearLine();
    Deno.stdout.writeSync(
      encoder.encode(
        `${this.prefix} ${bar} ${this.current}/${this.total} (${pct}%)${eta}`,
      ),
    );
  }

  /** Clear the current line */
  private clearLine(): void {
    Deno.stdout.writeSync(encoder.encode("\r\x1b[2K"));
  }

  /** Render a progress bar (40 chars wide) */
  private renderBar(pct: number): string {
    const width = 40;
    const filled = Math.round((width * pct) / 100);
    const empty = width - filled;
    return `[${"=".repeat(filled)}${" ".repeat(empty)}]`;
  }

  /** Render ETA based on current rate */
  private renderETA(): string {
    if (this.current === 0) return "";

    const elapsed = Date.now() - this.startTime;
    const rate = this.current / (elapsed / 1000);
    const remaining = this.total !== undefined ? (this.total - this.current) / rate : 0;

    if (remaining < 1) return "";

    if (remaining < 60) return ` | ETA: ~${Math.round(remaining)}s`;
    if (remaining < 3600) return ` | ETA: ~${Math.round(remaining / 60)}m`;
    return ` | ETA: ~${Math.round(remaining / 3600)}h${Math.round((remaining % 3600) / 60)}m`;
  }

  /** Finish progress (ensure newline) */
  finish(message?: string): void {
    this.clearLine();
    if (message) {
      Deno.stdout.writeSync(encoder.encode(`${this.prefix} ${message}\n`));
    } else if (this.total !== undefined) {
      Deno.stdout.writeSync(
        encoder.encode(`${this.prefix} ${this.current}/${this.total} complete\n`),
      );
    }
  }

  /** Render a summary of results */
  summary(results: Record<string, number | string>): void {
    this.clearLine();
    for (const [key, value] of Object.entries(results)) {
      console.log(`  ${key}: ${value}`);
    }
  }
}
