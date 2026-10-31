import { assertSupportedNode } from "./server/node-version.js";
import { installWarningFilter } from "./server/warnings.js";

async function main(): Promise<void> {
  assertSupportedNode(process.versions.node);
  installWarningFilter();
  const { startPluginServer } = await import("./server/startup.js");
  const handle = await startPluginServer();
  process.stdout.write(`${JSON.stringify({ ready: true, port: handle.port })}\n`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
