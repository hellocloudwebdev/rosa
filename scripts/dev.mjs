/**
 * `npm run dev` — one command that starts the API and the Vite dev server.
 *
 * Vite proxies `/api` to the API origin (see vite.config.ts), so the browser
 * only ever talks to one origin. That keeps the session cookie first-party and
 * means no CORS configuration is needed in development.
 *
 * Both processes are children of this script, so Ctrl-C stops both.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const children = [];

function run(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  const prefix = `[${name}] `;
  const pipe = (stream, out) => {
    stream.setEncoding("utf8");
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) out.write(prefix + line + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on("exit", (code) => {
    // 143 is the expected exit code when this parent is killed.
    if (code !== 0 && code !== null) {
      console.error(`${name} exited with code ${code}`);
      shutdown(code ?? 1);
    }
  });

  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const apiPort = process.env.ROSA_API_PORT ?? "8787";

run("api", "node", ["server/entry.ts"], {
  ROSA_PORT: apiPort,
  // A fresh dev database each start would be annoying, but a shared one is the
  // default; set ROSA_DB_PATH to point somewhere else.
});

run("web", "npx", ["vite"], { VITE_API_PORT: apiPort });
