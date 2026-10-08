// Minimal helpers for the GitHub Actions runner protocol, so that we
// don't need to bundle @actions/core.
//
// See https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands

import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export function getInput(name) {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}

export function setOutput(name, value) {
  appendKeyValue(process.env.GITHUB_OUTPUT, name, value);
}

export function saveState(name, value) {
  appendKeyValue(process.env.GITHUB_STATE, name, value);
}

export function getState(name) {
  return process.env[`STATE_${name}`] ?? "";
}

export function setSecret(value) {
  console.log(`::add-mask::${escapeData(value)}`);
}

export function info(message) {
  console.log(message);
}

export function warning(message) {
  console.log(`::warning::${escapeData(message)}`);
}

export function setFailed(message) {
  console.log(`::error::${escapeData(message)}`);
  process.exitCode = 1;
}

export function startGroup(title) {
  console.log(`::group::${escapeData(title)}`);
}

export function endGroup() {
  console.log("::endgroup::");
}

function appendKeyValue(file, name, value) {
  if (!file) {
    // Not running on a runner, such as when testing locally.
    console.log(`${name}=${value}`);
    return;
  }

  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function escapeData(value) {
  return String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}
