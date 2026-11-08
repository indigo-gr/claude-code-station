/** Start and stop test/tty/fake_registry.mjs. See there for the modes. */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./fake_registry.mjs", import.meta.url));

export interface LoggedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

export interface FakeRegistry {
  url: string;
  requests: () => Promise<LoggedRequest[]>;
  stop: () => void;
}

/** A port nothing listens on, for "the network is down". */
export const DEAD_REGISTRY = "http://127.0.0.1:9";

export async function startRegistry(mode: string, log: string): Promise<FakeRegistry> {
  const child = spawn(process.execPath, [SERVER, mode, log], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((resolve, reject) => {
    child.stdout.once("data", (d: Buffer) => resolve(d.toString().trim()));
    child.once("exit", (code) => reject(new Error(`fake registry exited: ${code}`)));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    requests: async () => {
      const text = await readFile(log, "utf-8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LoggedRequest);
    },
    stop: () => {
      child.removeAllListeners("exit");
      child.kill();
    },
  };
}

export async function waitFor<T>(what: string, get: () => Promise<T | undefined | false>, ms = 8_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await get();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
