import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [mode = "success", prompt = ""] = process.argv.slice(2);

/**
 * Announce that this child is fully armed — its signal handlers are installed
 * and it is now genuinely SIGTERM-resistant. A caller that wants to prove
 * escalation must wait for THIS, not for a fixed delay: until Node has finished
 * booting and the handler is registered, a SIGTERM kills the child under the
 * default disposition, which looks exactly like an escalation that never
 * happened. Signalled through a file rather than stdout so the byte-exact
 * stdout assertions in runtime-adapter.test.ts stay unchanged.
 */
function announceReady() {
  const path = process.env.MESH_READY_FILE;
  if (path) writeFileSync(path, "ready");
}

if (mode === "timeout") {
  setInterval(() => {}, 1_000);
} else if (mode === "term-exit") {
  process.stdout.write("before-term");
  process.on("SIGTERM", () => {
    process.stdout.write("term-exit");
    process.exit(0);
  });
  setInterval(() => {}, 1_000);
} else if (mode === "term-ignore") {
  process.stdout.write("before-term");
  process.on("SIGTERM", () => {
    process.stdout.write("ignored-term");
  });
  setInterval(() => {}, 1_000);
  announceReady();
} else if (mode === "term-ignore-ready") {
  process.on("SIGTERM", () => {});
  announceReady();
  setInterval(() => {}, 1_000);
} else if (mode === "term-ignore-ipc") {
  process.on("SIGTERM", () => {});
  if (process.send) process.send({ state: "signal-handler-armed" });
  setInterval(() => {}, 1_000);
} else if (mode === "tree-leader-exits-child-detached") {
  const descendant = spawn(process.execPath, [process.argv[1], "term-ignore-ipc"], {
    env: process.env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const descendantFile = process.env.MESH_DESCENDANT_PID_FILE;
  if (descendantFile && descendant.pid) writeFileSync(descendantFile, String(descendant.pid));
  descendant.once("message", (message) => {
    if (
      typeof message === "object" &&
      message !== null &&
      message.state === "signal-handler-armed"
    ) {
      announceReady();
    }
  });
  // Intentionally install no SIGTERM handler. Group TERM kills this leader
  // while the pipe-detached descendant survives until group SIGKILL.
  setInterval(() => {}, 1_000);
} else if (mode === "tree-term-ignore") {
  const descendant = spawn(process.execPath, [process.argv[1], "term-ignore"], {
    env: process.env,
    stdio: "inherit",
  });
  const descendantFile = process.env.MESH_DESCENDANT_PID_FILE;
  if (descendantFile && descendant.pid) writeFileSync(descendantFile, String(descendant.pid));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (mode === "tree-output-ignore") {
  const descendant = spawn(process.execPath, [process.argv[1], "term-ignore-ready"], {
    env: process.env,
    stdio: "inherit",
  });
  const descendantFile = process.env.MESH_DESCENDANT_PID_FILE;
  if (descendantFile && descendant.pid) writeFileSync(descendantFile, String(descendant.pid));
  process.on("SIGTERM", () => {});
  const ready = process.env.MESH_READY_FILE;
  const arm = setInterval(() => {
    if (!ready || !existsSync(ready)) return;
    clearInterval(arm);
    process.stdout.write("overflow-output");
  }, 5);
  setInterval(() => {}, 1_000);
} else if (mode === "signal") {
  process.kill(process.pid, "SIGTERM");
} else if (mode === "failure") {
  process.stdout.write(`partial:${prompt}`);
  process.stderr.write("fixture failure");
  process.exitCode = 7;
} else if (mode === "empty") {
  process.exitCode = 0;
} else if (mode === "opencode") {
  process.stdout.write(`answer:${prompt}`);
  process.stderr.write("> oracle · anthropic/claude-sonnet-4\n");
} else {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { stdin += chunk; });
  process.stdin.on("end", () => process.stdout.write(JSON.stringify({
    argv: process.argv.slice(2),
    prompt,
    stdin,
    cwd: process.cwd(),
    allowed: process.env.MESH_ALLOWED ?? null,
    inheritedSecret: process.env.MESH_SECRET ?? null,
    ambient: process.env.MESH_AMBIENT_FOR_TEST ?? null,
  })));
}
