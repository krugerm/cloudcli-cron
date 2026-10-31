export function assertSupportedNode(version: string): void {
  const [major = 0, minor = 0] = version
    .replace(/^v/u, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const supported = (major === 22 && minor >= 13) || (major === 23 && minor >= 4) || major >= 24;
  if (!supported) {
    throw new Error(`Scheduled Prompt needs Node 22.13+ (found ${version})`);
  }
}
