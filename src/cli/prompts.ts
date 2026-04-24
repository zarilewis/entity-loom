/**
 * Entity Loom — Interactive Prompts
 *
 * Stdin-based interactive prompts for the CLI. Uses Deno's built-in
 * readline capabilities with no external dependencies.
 */

const encoder = new TextEncoder();

/**
 * Write a prompt to stdout and read a line from stdin.
 */
function writePrompt(text: string): void {
  Deno.stdout.writeSync(encoder.encode(text));
}

/**
 * Read a single line from stdin.
 */
async function readLine(): Promise<string> {
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) throw new Error("EOF");
  return new TextDecoder().decode(buf.slice(0, n)).trim();
}

/**
 * Check if stdin is a TTY (interactive terminal).
 */
function isInteractive(): boolean {
  // Deno doesn't expose isatty directly on stdin in all runtimes,
  // so we check by attempting to set raw mode
  try {
    Deno.stdin.setRaw(false);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the user for a string input.
 * Returns the default value if non-interactive.
 */
export async function askString(
  prompt: string,
  defaultValue?: string,
): Promise<string> {
  if (!isInteractive()) {
    return defaultValue ?? "";
  }
  const suffix = defaultValue ? ` [${defaultValue}]: ` : ": ";
  writePrompt(`${prompt}${suffix}`);
  const answer = await readLine();
  return answer || defaultValue || "";
}

/**
 * Ask the user to choose from a list of options.
 * Returns the selected value.
 */
export async function askChoice(
  prompt: string,
  options: Array<{ label: string; value: string }>,
): Promise<string> {
  if (!isInteractive()) {
    return options[0].value;
  }
  console.log(`\n${prompt}`);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}. ${options[i].label}`);
  }
  writePrompt(`Choose [1-${options.length}]: `);

  const answer = await readLine();
  const index = parseInt(answer) - 1;
  if (index >= 0 && index < options.length) {
    return options[index].value;
  }
  return options[0].value;
}

/**
 * Ask a yes/no confirmation. Defaults to yes.
 */
export async function askConfirm(prompt: string, defaultValue = true): Promise<boolean> {
  if (!isInteractive()) {
    return defaultValue;
  }
  const suffix = defaultValue ? " [Y/n]: " : " [y/N]: ";
  writePrompt(`${prompt}${suffix}`);
  const answer = await readLine().catch(() => "");
  if (!answer) return defaultValue;
  const lower = answer.toLowerCase();
  if (lower === "y" || lower === "yes") return true;
  if (lower === "n" || lower === "no") return false;
  return defaultValue;
}

/**
 * Ask for multi-line input (terminated by a blank line or Ctrl+D).
 */
export async function askMultiline(
  prompt: string,
  defaultValue = "",
): Promise<string> {
  if (!isInteractive()) {
    return defaultValue;
  }
  console.log(`\n${prompt}`);
  if (defaultValue) {
    console.log(`  (press Enter on a blank line to finish, or Ctrl+D)`);
  } else {
    console.log(`  (enter text, press Enter on a blank line to finish, or Ctrl+D to skip)`);
  }

  const lines: string[] = [];
  while (true) {
    writePrompt("> ");
    const line = await readLine().catch(() => "");
    if (!line) break;
    lines.push(line);
  }

  return lines.join("\n") || defaultValue;
}
