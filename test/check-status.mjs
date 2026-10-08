// Checks that the browser started by the action is still running, by
// looking at the heartbeats of the mock Connect page, and that tab
// capture works. Also checks that the token is not set in the frames
// embedded by the Connect page.

import assert from "node:assert/strict";

assert.equal(process.env.MCP_URL, "http://localhost:4100/tidewave/mcp");

// Give the page time to send heartbeats after the action step.
await new Promise((resolve) => setTimeout(resolve, 3_000));

const response = await fetch("http://localhost:4100/status");
const status = await response.json();

assert.ok(
  Date.now() - status.lastHeartbeatAt < 2_000,
  `Expected a recent heartbeat, got ${JSON.stringify(status)}`,
);

assert.deepEqual(status.capture, { ok: true });

assert.deepEqual(status.frames, { app: false, "third-party": false });

console.log(
  "The browser is running, tab capture works and frames do not see the token.",
);
