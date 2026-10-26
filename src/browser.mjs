// The long-running browser process, started detached by main.mjs.
//
// It receives the start options (including the token) over IPC, opens
// Tidewave Connect and reports back once Connect is ready. Afterwards
// it keeps the browser running until it is stopped by the post step
// or the job ends. Logs go to stdout, which is the log file, and are
// also forwarded to the parent while it is connected.

import { chromium } from "playwright-core";

let browser = null;
// The token, which we redact from the log, see `redact`.
let secret = null;

process.on("message", (message) => {
  if (message.type === "start") {
    start(message).catch((error) => fail(errorMessage(error)));
  }
});

// The parent disconnects once Connect is ready, at which point we only
// write to the log file.
process.on("disconnect", () => {
  log("Handed over, Tidewave Connect keeps running.");
});

process.on("SIGTERM", async () => {
  log("Stopping the browser.");
  await browser?.close().catch(() => {});
  process.exit(0);
});

async function start({ connectUrl, channel, token, deadline }) {
  secret = token;
  log(`Launching ${channel ?? "chromium"}.`);

  // We run a headed browser (on Xvfb when there is no display), since
  // Tidewave uses tab capture for screenshots and recordings.
  browser = await chromium.launch({
    headless: false,
    channel: channel ?? undefined,
    args: [
      // Auto-accept the tab capture prompt for getDisplayMedia with
      // preferCurrentTab, as there is no one to click it.
      "--auto-accept-this-tab-capture",
      "--window-position=0,0",
      "--window-size=1920,1080",
    ],
    // https://github.com/microsoft/playwright/issues/39158
    ignoreDefaultArgs: ["--disable-infobars"],
  });

  browser.on("disconnected", () => {
    log("The browser closed unexpectedly.");
    process.exit(1);
  });

  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  page.on("console", (message) => {
    log(`[console.${message.type()}] ${message.text()}`);
  });

  page.on("pageerror", (error) => {
    log(`[pageerror] ${error.stack ?? error.message}`);
  });

  page.on("crash", () => {
    log("The Tidewave Connect page crashed.");
  });

  // Tidewave Connect picks up the token from the URL fragment instead
  // of signing in. We also enable vision mode upfront, as there is no
  // user to do so, which relies on auto-accepting the tab capture
  // prompt. The fragment is not sent to the server and Connect removes
  // it from the URL on load, before it embeds the app.
  const params = new URLSearchParams({
    tidewave_auth_token: token,
    tidewave_enable_vision_mode: "true",
  });

  log(`Opening ${connectUrl}.`);
  await page.goto(`${connectUrl}#${params}`);

  try {
    await page.waitForSelector('html[data-tidewave-connect="ready"]', {
      state: "attached",
      timeout: Math.max(deadline - Date.now(), 1_000),
    });
  } catch {
    const status = await page
      .evaluate(() => document.documentElement.dataset.tidewaveConnect ?? null)
      .catch(() => null);

    if (status === null) {
      fail(
        `Tidewave Connect did not load at ${withoutFragment(page.url())}. Make sure the app uses a recent Tidewave version.`,
      );
    } else {
      fail(
        "Tidewave Connect did not become ready in time. It could not connect to the app or to Tidewave, see the browser log for details.",
      );
    }

    return;
  }

  send({ type: "ready" });
}

function log(line) {
  const timestamped = `[${new Date().toISOString()}] ${redact(line)}`;
  console.log(timestamped);
  send({ type: "log", line: timestamped });
}

async function fail(message) {
  log(`Error: ${message}`);
  send({ type: "error", message: redact(message) });
  await browser?.close().catch(() => {});
  process.exit(1);
}

function send(message) {
  if (process.connected) process.send(message);
}

// The URL we open has the token in its fragment, so it may show up in
// errors and page messages. GitHub masks it in the workflow log, but
// not in the browser log file, which may be uploaded as an artifact,
// so we redact it everywhere.
function redact(text) {
  return secret ? text.replaceAll(secret, "***") : text;
}

// The page did not consume the fragment, if it failed to load.
function withoutFragment(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
