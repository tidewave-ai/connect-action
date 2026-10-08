// Starts Tidewave Connect in a browser that outlives this step.
//
// The flow is:
//
//   1. Install playwright-core and, if needed, a browser and Xvfb.
//   2. Wait for the app to serve Tidewave Connect.
//   3. Exchange the API key for a short-lived token, so that the key
//      itself never reaches the browser. We exchange it with the
//      Tidewave server the Connect page loads its client from, as that
//      is the server the client talks to.
//   4. Start the browser process (see browser.mjs) detached, so the
//      runner keeps it alive for subsequent steps, and wait until
//      Tidewave Connect reports it is ready.
//
// The post step (see post.mjs) prints the browser log and stops the
// browser at the end of the job.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getInput,
  info,
  saveState,
  setFailed,
  setOutput,
  setSecret,
} from "./actions.mjs";

const actionRoot = dirname(dirname(fileURLToPath(import.meta.url)));

try {
  await run();
} catch (error) {
  setFailed(error instanceof Error ? error.message : String(error));
}

// The browser and Xvfb processes are detached, but we still need to
// exit explicitly, in case some handle keeps the event loop alive.
process.exit();

async function run() {
  const appUrl = parseUrl(getInput("app_url"));
  const apiKey = getInput("api_key");
  const maxWaitTime = Number(getInput("max_wait_time") || "300");

  if (!apiKey) {
    throw new Error("The api_key input is required.");
  }

  if (!Number.isFinite(maxWaitTime) || maxWaitTime <= 0) {
    throw new Error("The max_wait_time input must be a positive number.");
  }

  const deadline = Date.now() + maxWaitTime * 1000;
  const connectUrl = new URL("tidewave/connect", appUrl).toString();

  setSecret(apiKey);
  setOutput("mcp_url", new URL("tidewave/mcp", appUrl).toString());

  // We install while the app may still be booting.
  const browser = installBrowser();

  const connectPage = await waitForApp(connectUrl, deadline);
  const tidewaveUrl = tidewaveUrlFromPage(connectUrl, connectPage);
  const teamId = teamIdFromPage(connectPage);

  info(`Exchanging the API key with ${tidewaveUrl.origin}.`);
  const token = await exchangeApiKey(tidewaveUrl, apiKey, teamId);
  setSecret(token);

  const logFile = join(
    process.env.RUNNER_TEMP || tmpdir(),
    "tidewave-connect",
    "browser.log",
  );
  mkdirSync(dirname(logFile), { recursive: true });
  setOutput("log_file", logFile);
  saveState("log_file", logFile);

  const pids = [];

  try {
    let display = process.env.DISPLAY;

    if (browser.needsXvfb) {
      const xvfb = await startXvfb(join(dirname(logFile), "xvfb.log"));
      pids.push(xvfb.pid);
      display = `:${xvfb.display}`;
      info(`Started Xvfb on display ${display}.`);
    }

    const browserPid = await startBrowser({
      logFile,
      display,
      channel: browser.channel,
      connectUrl,
      token,
      deadline,
    });

    pids.push(browserPid);
  } finally {
    // Saved even on failure, so the post step cleans up.
    saveState("pids", JSON.stringify(pids));
  }

  info(`Tidewave Connect is ready at ${connectUrl}.`);
}

function parseUrl(value) {
  if (!value) {
    throw new Error("The app_url input is required.");
  }

  try {
    return withTrailingSlash(new URL(value));
  } catch {
    throw new Error(`The app_url input is not a valid URL: ${value}`);
  }
}

// So that relative paths resolve within the URL path.
function withTrailingSlash(url) {
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

// The Connect page loads the client from the Tidewave server, with a
// tag like <script type="module" src="https://tidewave.ai/tc/control.js">.
function tidewaveUrlFromPage(connectUrl, html) {
  const src = html.match(/<script[^>]*\ssrc="([^"]*)\/tc\/control\.js"/)?.[1];

  if (!src) {
    throw new Error(
      `The page at ${connectUrl} does not load Tidewave Connect. Make sure the app uses a recent Tidewave version.`,
    );
  }

  return withTrailingSlash(new URL(decodeHtml(src), connectUrl));
}

// Connect uses the team configured in the app, from the page config in
// <meta name="tidewave:config" content="...">. Team API keys only work
// with their team, so we exchange the key for the same team.
function teamIdFromPage(html) {
  const content = html.match(/<meta\s+name="tidewave:config"\s+content="([^"]*)"/)?.[1];
  if (!content) return null;

  try {
    const teamId = JSON.parse(decodeHtml(content)).tidewave?.team?.id;
    return typeof teamId === "string" ? teamId : null;
  } catch {
    return null;
  }
}

// Decodes the entities escaped by the Tidewave packages in attributes.
function decodeHtml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

async function exchangeApiKey(tidewaveUrl, apiKey, teamId) {
  let response;

  try {
    response = await fetch(new URL("api/api-key-exchange", tidewaveUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ team_id: teamId }),
    });
  } catch (error) {
    throw new Error(
      `Failed to reach Tidewave at ${tidewaveUrl.origin}: ${errorReason(error)}`,
    );
  }

  const body = await response.json().catch(() => null);

  if (response.ok && typeof body?.token === "string") {
    return body.token;
  }

  switch (body?.error?.type) {
    case "invalid_api_key":
      throw new Error(
        "The Tidewave API key is invalid. Make sure it has not been deleted in your Tidewave account or team settings.",
      );

    case "team_mismatch":
      throw new Error(body.error.message);

    case "subscription_required":
      throw new Error(
        "Tidewave API keys require an active subscription. The API key belongs to an account or team without one.",
      );

    default:
      throw new Error(
        `Failed to exchange the Tidewave API key (HTTP ${response.status}).`,
      );
  }
}

// Installs playwright-core and, unless already present, a browser and
// Xvfb. GitHub-hosted Ubuntu runners come with both Google Chrome and
// Xvfb, in which case we only install playwright-core.
function installBrowser() {
  if (!existsSync(join(actionRoot, "node_modules", "playwright-core"))) {
    info("Installing playwright-core.");
    runCommand("npm", [
      "ci",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ]);
  }

  const isLinux = process.platform === "linux";
  const needsXvfb = isLinux && !process.env.DISPLAY;
  const playwrightCli = join(actionRoot, "node_modules", "playwright-core", "cli.js");

  if (hasChrome()) {
    if (needsXvfb && !hasCommand("Xvfb")) {
      info("Installing Xvfb.");
      runCommand(process.execPath, [playwrightCli, "install-deps", "chromium"]);
    }

    return { channel: "chrome", needsXvfb };
  }

  info("Google Chrome not found, installing Chromium.");
  runCommand(process.execPath, [
    playwrightCli,
    "install",
    ...(isLinux ? ["--with-deps"] : []),
    "chromium",
  ]);

  return { channel: null, needsXvfb };
}

// The locations Playwright uses for the "chrome" channel.
function hasChrome() {
  switch (process.platform) {
    case "linux":
      return existsSync("/opt/google/chrome/chrome");

    case "darwin":
      return existsSync(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      );

    case "win32":
      return [process.env.PROGRAMFILES, process.env.LOCALAPPDATA].some(
        (dir) =>
          dir &&
          existsSync(join(dir, "Google", "Chrome", "Application", "chrome.exe")),
      );

    default:
      return false;
  }
}

function hasCommand(command) {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, command)));
}

function runCommand(command, args) {
  execFileSync(command, args, {
    cwd: actionRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

async function waitForApp(connectUrl, deadline) {
  info(`Waiting for the app to serve ${connectUrl}.`);

  let lastReason = null;
  let lastLoggedAt = Date.now();

  while (Date.now() < deadline) {
    try {
      const response = await fetch(connectUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) return await response.text();

      lastReason = `HTTP ${response.status}`;
    } catch (error) {
      lastReason = errorReason(error);
    }

    if (Date.now() - lastLoggedAt >= 15_000) {
      info(`Still waiting for the app (${lastReason}).`);
      lastLoggedAt = Date.now();
    }

    await sleep(1_000);
  }

  throw new Error(
    `The app did not serve ${connectUrl} in time (${lastReason}). ` +
      "Make sure the app is started before or alongside this action, " +
      "with Tidewave installed and enabled in its environment.",
  );
}

// Starts Xvfb on a free display. With -displayfd, Xvfb picks the
// display and writes its number to the given file descriptor.
function startXvfb(logFile) {
  return new Promise((resolve, reject) => {
    const log = openSync(logFile, "a");

    const xvfb = spawn(
      "Xvfb",
      ["-displayfd", "3", "-screen", "0", "1920x1080x24", "-nolisten", "tcp"],
      { detached: true, stdio: ["ignore", log, log, "pipe"] },
    );

    let output = "";

    xvfb.stdio[3].on("data", (data) => {
      output += data;

      if (output.includes("\n")) {
        xvfb.stdio[3].destroy();
        xvfb.removeAllListeners("exit");
        xvfb.unref();
        resolve({ pid: xvfb.pid, display: output.trim() });
      }
    });

    xvfb.on("error", (error) =>
      reject(new Error(`Failed to start Xvfb: ${error.message}`)),
    );

    xvfb.on("exit", (code) =>
      reject(new Error(`Xvfb exited with code ${code}, see ${logFile}.`)),
    );
  });
}

// Starts the browser process detached, sends it the token over IPC
// (rather than the environment or arguments, which other processes
// can read) and waits for it to report that Connect is ready.
function startBrowser({ logFile, display, channel, connectUrl, token, deadline }) {
  return new Promise((resolve, reject) => {
    const log = openSync(logFile, "a");

    const child = spawn(process.execPath, [join(actionRoot, "src", "browser.mjs")], {
      detached: true,
      stdio: ["ignore", log, log, "ipc"],
      env: browserEnv(display),
    });

    child.on("message", (message) => {
      switch (message.type) {
        case "log":
          info(message.line);
          break;

        case "ready":
          child.removeAllListeners();
          child.disconnect();
          child.unref();
          resolve(child.pid);
          break;

        case "error":
          reject(new Error(message.message));
          break;
      }
    });

    child.on("error", (error) =>
      reject(new Error(`Failed to start the browser: ${error.message}`)),
    );

    child.on("exit", (code) =>
      reject(new Error(`The browser exited with code ${code}, see ${logFile}.`)),
    );

    child.send({ type: "start", connectUrl, channel, token, deadline });
  });
}

// The browser runs for the rest of the job, so we don't pass the action
// inputs (in particular, the API key) and runner internals down to it.
function browserEnv(display) {
  const env = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("INPUT_") && !key.startsWith("ACTIONS_")) {
      env[key] = value;
    }
  }

  if (display) env.DISPLAY = display;

  return env;
}

function errorReason(error) {
  return error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
