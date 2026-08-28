import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

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

async function armFixtureReaper() {
  const journalPath = process.env.MESH_KIMI_REAP_JOURNAL;
  const owner = process.env.MESH_KIMI_REAP_OWNER;
  const token = process.env.MESH_KIMI_REAP_TOKEN;
  const runnerSocketPath = process.env.MESH_KIMI_REAP_RUNNER_SOCKET;
  const runnerToken = process.env.MESH_KIMI_REAP_RUNNER_TOKEN;
  if (
    journalPath === undefined && owner === undefined && token === undefined &&
    runnerSocketPath === undefined && runnerToken === undefined
  ) return;
  if (
    journalPath === undefined || owner === undefined || token === undefined ||
    runnerSocketPath === undefined || runnerToken === undefined ||
    !/^[a-f0-9]{16}$/.test(owner) || !/^[a-f0-9]{32}$/.test(token) ||
    !/^[a-f0-9]{32}$/.test(runnerToken) ||
    runnerSocketPath !== join(dirname(journalPath), "runner.sock")
  ) {
    throw new Error("invalid fixture reap configuration");
  }
  const socketPath = join(dirname(journalPath), "reap.sock");
  let reaping = false;
  const server = createServer((socket) => {
    let request = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      request += chunk;
      if (request.length > 33 || (request.length === 33 && request !== `${token}\n`)) {
        socket.destroy();
        return;
      }
      if (!reaping && request === `${token}\n`) {
        reaping = true;
        let killScheduled = false;
        const reap = () => {
          if (killScheduled) return;
          killScheduled = true;
          server.close();
          setImmediate(() => process.kill(-process.pid, "SIGKILL"));
        };
        socket.once("error", reap);
        socket.end("reaping\n", reap);
        setTimeout(reap, 100).unref();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      owner,
      pid: process.pid,
      runnerSocketPath,
      runnerToken,
      socketPath,
      token,
    }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    server.close();
    rmSync(socketPath, { force: true });
    throw error;
  }
}

if (mode === "tree-child") {
  process.on("SIGTERM", () => {});
  if (process.send) process.send({ state: "signal-handler-armed" });
  setInterval(() => {}, 1_000);
} else if (mode === "tree-ignore") {
  await armFixtureReaper();
  const child = spawn(process.execPath, [process.argv[1]], {
    env: { ...process.env, MESH_KIMI_FAKE_MODE: "tree-child" },
    // Do not let inherited output pipes keep the group leader's close event
    // open. Containment must remain correct even for pipe-detached tools.
    stdio: ["ignore", "ignore", "ignore", "ipc"],
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
