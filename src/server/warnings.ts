export type WarningTarget = Pick<NodeJS.Process, "removeAllListeners" | "on">;

export function installWarningFilter(
  target: WarningTarget = process,
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  }
): void {
  target.removeAllListeners("warning");
  target.on("warning", (warning: Error) => {
    if (warning.name === "ExperimentalWarning" && /sqlite/iu.test(warning.message)) {
      return;
    }
    write(`${warning.name}: ${warning.message}\n`);
  });
}
