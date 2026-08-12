// Computes all-time npm download totals across every published package in
// this monorepo and writes shields.io "endpoint badge" JSON, consumed by
// .github/workflows/downloads-badge.yml.
//
// npm's downloads API caps any single date range at ~18 months, so each
// package's total is built by chunking from the package's actual first-
// publish date (looked up from the registry, falling back to 2015-01-10,
// when npm's download-stats data begins) up to today. Starting from the
// real publish date rather than always from 2015 keeps the request count
// low for young packages — fewer requests means less chance of tripping
// the API's rate limiting, which is also why every request retries with
// backoff and validates the response is actually JSON before parsing.

import { mkdirSync, writeFileSync } from "node:fs";

const PACKAGES = [
  "@a2a-wrapper/core",
  "a2a-claude",
  "a2a-codex",
  "a2a-copilot",
  "a2a-opencode",
  "a2a-antigravity",
];

const BADGES_DIR = process.env.BADGES_DIR ?? ".github/badges";
const CHUNK_DAYS = 540;
const DAY_MS = 86400000;
const STATS_START = new Date("2015-01-10");
const REQUEST_DELAY_MS = 200;
const MAX_RETRIES = 4;

function fmt(date) {
  return date.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      const contentType = res.headers.get("content-type") ?? "";
      if (res.ok && contentType.includes("json")) {
        return await res.json();
      }
      lastError = new Error(`non-JSON response (status ${res.status}, content-type "${contentType}")`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < MAX_RETRIES) {
      const delay = REQUEST_DELAY_MS * 2 ** attempt;
      console.warn(`Retrying ${url} in ${delay}ms (attempt ${attempt}/${MAX_RETRIES}): ${lastError.message}`);
      await sleep(delay);
    }
  }
  throw new Error(`Giving up on ${url} after ${MAX_RETRIES} attempts: ${lastError.message}`);
}

async function packageCreatedDate(pkg) {
  try {
    const data = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`);
    const created = data?.time?.created;
    return created ? new Date(created) : STATS_START;
  } catch (err) {
    console.warn(`Could not look up creation date for ${pkg}, falling back to ${fmt(STATS_START)}: ${err.message}`);
    return STATS_START;
  }
}

async function totalDownloads(pkg) {
  const end = new Date();
  let cursor = await packageCreatedDate(pkg);
  if (cursor < STATS_START) cursor = new Date(STATS_START);
  let total = 0;

  while (cursor < end) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + CHUNK_DAYS * DAY_MS, end.getTime()));
    const url = `https://api.npmjs.org/downloads/point/${fmt(cursor)}:${fmt(chunkEnd)}/${encodeURIComponent(pkg)}`;
    const data = await fetchJson(url);
    total += data.downloads ?? 0;
    cursor = new Date(chunkEnd.getTime() + DAY_MS);
    await sleep(REQUEST_DELAY_MS);
  }

  return total;
}

const perPackage = {};
let grand = 0;

for (const pkg of PACKAGES) {
  const total = await totalDownloads(pkg);
  perPackage[pkg] = total;
  grand += total;
  console.log(`${pkg}: ${total}`);
}

console.log(`TOTAL: ${grand}`);

mkdirSync(BADGES_DIR, { recursive: true });

writeFileSync(
  `${BADGES_DIR}/downloads.json`,
  JSON.stringify({ schemaVersion: 1, label: "downloads", message: `${grand.toLocaleString()} total`, color: "blue" }, null, 2) + "\n",
);

writeFileSync(
  `${BADGES_DIR}/downloads-detail.json`,
  JSON.stringify({ perPackage, grand, updatedAt: new Date().toISOString() }, null, 2) + "\n",
);
