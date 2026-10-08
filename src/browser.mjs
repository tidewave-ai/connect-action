// The long-running browser process, started detached by main.mjs.
//
// It receives the start options (including the token) over IPC, opens
// Tidewave Connect and reports back once Connect is ready. Afterwards
// it keeps the browser running until it is stopped by the post step
// or the job ends. Logs go to stdout, which is the log file, and are
// also forwarded to the parent while it is connected.

import { chromium } from "playwright-core";

let browser = null;

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

  // Tidewave Connect picks up the token instead of signing in. It keeps
  // it in memory only, so we set it on every page load. We also enable
  // vision mode upfront, as there is no user to do so, which relies on
  // auto-accepting the tab capture prompt.
  //
  // Init scripts also run in child frames and after navigations, so we
  // only set them on the Connect page itself. This way the app frame,
  // third-party iframes and pages the top frame navigates to never see
  // the token. Init scripts run before any page script, so the page
  // cannot tamper with the check.
  const { origin, pathname } = new URL(connectUrl);

  await page.addInitScript(
    ({ token, origin, pathname }) => {
      if (
        window === window.top &&
        location.origin === origin &&
        location.pathname === pathname
      ) {
        window.TIDEWAVE_AUTH_TOKEN = token;
        window.TIDEWAVE_ENABLE_VISION_MODE = true;
      }
    },
    { token, origin, pathname },
  );

  page.on("console", (message) => {
    log(`[console.${message.type()}] ${message.text()}`);
  });

  page.on("pageerror", (error) => {
    log(`[pageerror] ${error.stack ?? error.message}`);
  });

  page.on("crash", () => {
    log("The Tidewave Connect page crashed.");
  });

  log(`Opening ${connectUrl}.`);
  await page.goto(connectUrl);

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
        `Tidewave Connect did not load at ${page.url()}. Make sure the app uses a recent Tidewave version.`,
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
  const timestamped = `[${new Date().toISOString()}] ${line}`;
  console.log(timestamped);
  send({ type: "log", line: timestamped });
}

async function fail(message) {
  log(`Error: ${message}`);
  send({ type: "error", message });
  await browser?.close().catch(() => {});
  process.exit(1);
}

function send(message) {
  if (process.connected) process.send(message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
