// Checks a release tag against the add-on's version and CHANGELOG.md, then prints that version's
// CHANGELOG section for the release notes.
// Usage: node scripts/release-notes.mjs v1.0.0 (or v1.0.0-rc.1 for a pre-release)
import { readFile } from "node:fs/promises";

const tag = process.argv[2] ?? "";
const version = /^v(\d+\.\d+\.\d+)(?:-rc\.\d+)?$/.exec(tag)?.[1];
if (!version) {
  console.error(`${tag || "(no tag)"}: expected a tag like v1.0.0, or v1.0.0-rc.1 for a pre-release`);
  process.exit(1);
}

const problems = [];
for (const file of ["manifest.json", "package.json"]) {
  const found = JSON.parse(await readFile(file, "utf8")).version;
  if (found !== version) problems.push(`${file} has version ${found}, not ${version}`);
}

// Keep a Changelog: "## [1.0.0] - 2026-10-27", then "### Added" and the like with their entries.
const sections = new Map();
const references = [];
let current;
for (const line of (await readFile("CHANGELOG.md", "utf8")).split(/\r?\n/)) {
  const heading = /^## \[([^\]]+)\](.*)$/.exec(line);
  if (/^ {0,3}\[[^\]]+\]:/.test(line)) references.push(line);
  else if (heading) sections.set(heading[1], (current = { rest: heading[2], lines: [] }));
  else if (/^ {0,3}##(?:\s|$)/.test(line)) current = undefined;
  else current?.lines.push(line);
}

// A section's text without its empty "### Changed"-style headings.
function entries(lines) {
  const groups = [{ heading: null, body: [] }];
  for (const line of lines) {
    if (line.startsWith("### ")) groups.push({ heading: line, body: [] });
    else groups.at(-1).body.push(line);
  }
  return groups
    .map(({ heading, body }) => ({ heading, body: body.join("\n").trim() }))
    .filter(({ body }) => body)
    .map(({ heading, body }) => (heading ? `${heading}\n${body}` : body))
    .join("\n\n");
}

const section = sections.get(version);
const notes = section ? entries(section.lines) : "";
if (!section) problems.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section`);
else if (!/^ - \d{4}-\d{2}-\d{2}$/.test(section.rest)) {
  problems.push(`CHANGELOG.md's [${version}] heading needs a release date: "## [${version}] - YYYY-MM-DD"`);
} else if (!notes) problems.push(`CHANGELOG.md's [${version}] section has no entries`);
if (entries(sections.get("Unreleased")?.lines ?? [])) {
  problems.push(`CHANGELOG.md's [Unreleased] section still has entries; move them into [${version}]`);
}

for (const problem of problems) console.error(`${tag}: ${problem}`);
if (problems.length) process.exit(1);
console.log(notes + (references.length ? "\n\n" + references.join("\n") : ""));
