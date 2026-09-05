/**
 * Final command output, delivered in full before the process exits.
 *
 * `process.stdout.write` followed by `process.exit` truncates a pipe at
 * 128 KiB under Bun: exit discards whatever the pipe has not yet accepted, and
 * the write callback fires before that drain, so it cannot be waited on.
 * `Bun.write` resolves only once every byte has been handed to the
 * descriptor, which is what `main.ts`'s `process.exit(await run(...))` needs.
 *
 * A reader that has already gone away (EPIPE) is not a failure the command can
 * act on: the output simply has nowhere to go, and the exit status still
 * reports what the command itself did.
 */
export async function writeStdout(text: string): Promise<void> {
  try {
    await Bun.write(Bun.stdout, text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") return;
    throw error;
  }
}
