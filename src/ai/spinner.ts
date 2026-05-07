/**
 * Minimal spinner with an elapsed-time counter. Writes to stderr so it
 * doesn't pollute pipeline outputs that callers might capture from stdout.
 *
 * Disables itself when stderr isn't a TTY (CI, logs piped to files), so
 * background runs stay clean.
 */
export async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const isTty = Boolean((process.stderr as { isTTY?: boolean }).isTTY);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const start = Date.now();
  let interval: NodeJS.Timeout | undefined;

  if (isTty) {
    process.stderr.write("\x1b[?25l"); // hide cursor
    interval = setInterval(() => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const frame = frames[i++ % frames.length];
      process.stderr.write(`\r${frame} ${label} (${elapsed}s) `);
    }, 80);
  } else {
    process.stderr.write(`${label}…\n`);
  }

  try {
    const result = await fn();
    if (interval) {
      clearInterval(interval);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      process.stderr.write(`\r✓ ${label} (${elapsed}s)        \n`);
      process.stderr.write("\x1b[?25h");
    }
    return result;
  } catch (err) {
    if (interval) {
      clearInterval(interval);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      process.stderr.write(`\r✗ ${label} (${elapsed}s)        \n`);
      process.stderr.write("\x1b[?25h");
    }
    throw err;
  }
}
