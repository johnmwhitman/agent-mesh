import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.env.MESH_KIMI_FAKE_MODE ?? "success";

function emit(content, extra = {}) {
  process.stdout.write(`${JSON.stringify({ role: "assistant", content, ...extra })}\n`);
}

function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
  });
}

if (mode === "tree-child") {
  process.on("SIGTERM", () => {});
  if (process.send) process.send({ state: "signal-handler-armed" });
  setInterval(() => {}, 1_000);
} else if (mode === "tree-ignore") {
  const child = spawn(process.execPath, [process.argv[1]], {
    env: { ...process.env, MESH_KIMI_FAKE_MODE: "tree-child" },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  if (process.env.MESH_KIMI_DESCENDANT_PID_FILE && child.pid) {
    writeFileSync(process.env.MESH_KIMI_DESCENDANT_PID_FILE, String(child.pid));
  }
  child.once("message", (message) => {
    if (
      process.env.MESH_KIMI_READY_FILE &&
      typeof message === "object" &&
      message !== null &&
      message.state === "signal-handler-armed"
    ) {
      writeFileSync(process.env.MESH_KIMI_READY_FILE, "ready");
    }
  });
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else {
  const stdin = await readStdin();
  const observation = JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdin,
    promptInEnvironment: Object.values(process.env).includes(stdin),
    environmentKeys: Object.keys(process.env).sort(),
  });

  if (mode === "empty") {
    // Intentionally emit no terminal frame.
  } else if (mode === "malformed") {
    process.stdout.write('{"role":"assistant","content":');
  } else if (mode === "wrong-role") {
    process.stdout.write(`${JSON.stringify({ role: "tool", content: "no" })}\n`);
  } else if (mode === "non-string") {
    process.stdout.write(`${JSON.stringify({ role: "assistant", content: [{ type: "text", text: "no" }] })}\n`);
  } else if (mode === "unknown-key") {
    emit("no", { session_id: "unexpected" });
  } else if (mode === "multiple") {
    emit("intermediate");
    emit(observation);
  } else if (mode === "too-many") {
    for (let index = 0; index < 65; index += 1) emit(String(index));
  } else if (mode === "oversize") {
    emit("x".repeat(8_192));
  } else if (mode === "failure") {
    emit("partial");
    process.stderr.write("provider failed");
    process.exitCode = 7;
  } else {
    emit(observation);
  }
}
