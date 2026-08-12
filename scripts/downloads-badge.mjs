// Computes all-time npm download totals across every published package in
// this monorepo and writes shields.io "endpoint badge" JSON, consumed by
// .github/workflows/downloads-badge.yml.
//
// npm's downloads API caps any single date range at ~18 months, so each
// package's total is built by chunking from when npm's download-stats data
// begins (2015-01-10) up to today.

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

function fmt(date) {
  return date.toISOString().slice(0, 10);
}

async function totalDownloads(pkg) {
  const end = new Date();
  let cursor = new Date(STATS_START);
  let total = 0;

  while (cursor < end) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + CHUNK_DAYS * DAY_MS, end.getTime()));
    const url = `https://api.npmjs.org/downloads/point/${fmt(cursor)}:${fmt(chunkEnd)}/${encodeURIComponent(pkg)}`;
    const res = await fetch(url);
    const data = await res.json();
    total += data.downloads ?? 0;
    cursor = new Date(chunkEnd.getTime() + DAY_MS);
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
