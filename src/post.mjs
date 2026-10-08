// Prints the browser log and stops the browser and Xvfb, at the end of
// the job.

import { existsSync, readFileSync } from "node:fs";
import {
  endGroup,
  getState,
  info,
  startGroup,
  warning,
} from "./actions.mjs";

const LOG_LINES = 1_000;

try {
  printLog(getState("log_file"));
  await stopProcesses(JSON.parse(getState("pids") || "[]"));
} catch (error) {
  // Cleanup is best effort, the runner kills leftover processes anyway.
  warning(`Failed to clean up Tidewave Connect: ${error.message}`);
}

function printLog(logFile) {
  if (!logFile || !existsSync(logFile)) return;

  const lines = readFileSync(logFile, "utf8").trimEnd().split("\n");

  startGroup("Tidewave Connect browser log");

  if (lines.length > LOG_LINES) {
    info(`(showing the last ${LOG_LINES} of ${lines.length} lines, see ${logFile})`);
  }

  info(lines.slice(-LOG_LINES).join("\n"));
  endGroup();
}

// The browser is stopped first, so it can close gracefully, then Xvfb.
async function stopProcesses(pids) {
  for (const pid of pids.toReversed()) {
    signal(pid, "SIGTERM");

    if (!(await waitForExit(pid, 5_000))) {
      signal(pid, "SIGKILL");
    }
  }
}

// The processes are started detached, as process group leaders, so on
// POSIX we signal the whole group, including the browser children.
function signal(pid, name) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, name);
  } catch {
    // Already exited.
  }
}

async function waitForExit(pid, timeout) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
}
