import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { installWarningFilter } from "../../src/server/warnings.js";

function makeWarning(name: string, message: string): Error {
  const warning = new Error(message);
  warning.name = name;
  return warning;
}

describe("installWarningFilter", () => {
  it("drops only the SQLite ExperimentalWarning and writes every other warning", () => {
    const target = new EventEmitter();
    const previous: string[] = [];
    target.on("warning", () => previous.push("default printer"));
    const lines: string[] = [];

    installWarningFilter(target as unknown as Pick<NodeJS.Process, "removeAllListeners" | "on">, (line) => lines.push(line));

    target.emit("warning", makeWarning("ExperimentalWarning", "SQLite is an experimental feature and might change at any time"));
    target.emit("warning", makeWarning("ExperimentalWarning", "Fetch is experimental"));
    target.emit("warning", makeWarning("DeprecationWarning", "Buffer() is deprecated"));

    expect(previous).toEqual([]);
    expect(lines).toEqual([
      "ExperimentalWarning: Fetch is experimental\n",
      "DeprecationWarning: Buffer() is deprecated\n"
    ]);
  });
});
