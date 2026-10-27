import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const script = resolve("scripts/release-notes.mjs");
const temporary = await mkdtemp(join(tmpdir(), "cas-release-"));
after(() => rm(temporary, { recursive: true, force: true }));

const released = `# Changelog

## [Unreleased]

### Added

### Fixed

## [1.2.0] - 2026-10-27

### Added
- Read statements
- Import them

### Changed

### Fixed
- Start the parser
`;

async function run(tag, { manifest = "1.2.0", pkg = "1.2.0", changelog = released } = {}) {
  await writeFile(join(temporary, "manifest.json"), JSON.stringify({ version: manifest }));
  await writeFile(join(temporary, "package.json"), JSON.stringify({ version: pkg }));
  await writeFile(join(temporary, "CHANGELOG.md"), changelog);
  return spawnSync(process.execPath, [script, tag], { cwd: temporary, encoding: "utf8" });
}

for (const tag of ["v1.2.0", "v1.2.0-rc.1", "v1.2.0-rc.12"]) {
  test(`prints the version's entries for ${tag}`, async () => {
    const result = await run(tag);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "### Added\n- Read statements\n- Import them\n\n### Fixed\n- Start the parser\n");
  });
}

test("accepts CRLF changelogs", async () => {
  const result = await run("v1.2.0", { changelog: released.replaceAll("\n", "\r\n") });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "### Added\n- Read statements\n- Import them\n\n### Fixed\n- Start the parser\n");
});

test("ends sections at every second-level heading", async () => {
  const changelog = released.replace("## [1.2.0]", "## Development\n\nUnrelated text\n\n## [1.2.0]")
    + "\n## Older releases\n\nOther text\n";
  const result = await run("v1.2.0", { changelog });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "### Added\n- Read statements\n- Import them\n\n### Fixed\n- Start the parser\n");
});

test("keeps link definitions outside category entries", async () => {
  const references = "[Unreleased]: https://example.com/compare/v1.2.0...HEAD\n"
    + "[1.2.0]: https://example.com/releases/v1.2.0\n[guide]: https://example.com/guide";
  const changelog = released.replace("- Read statements", "- [Read statements][guide]")
    + "\n### Security\n\n" + references + "\n";
  const result = await run("v1.2.0", { changelog });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "### Added\n- [Read statements][guide]\n- Import them\n\n### Fixed\n- Start the parser\n\n" + references + "\n");
});

test("link definitions alone do not count as entries", async () => {
  const changelog = released.replace(/- (Read|Import|Start).*\n/g, "")
    + "\n[Unreleased]: https://example.com/compare/v1.2.0...HEAD\n[1.2.0]: https://example.com/releases/v1.2.0\n";
  const result = await run("v1.2.0", { changelog });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /\[1\.2\.0\] section has no entries/);
});

test("accepts a changelog without an Unreleased section", async () => {
  const result = await run("v1.2.0", { changelog: released.slice(released.indexOf("## [1.2.0]")) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /- Read statements/);
});

for (const tag of ["", "1.2.0", "v1.2", "v1.2.0-rc", "v1.2.0-rc.1x", "v1.2.0-beta.1", "v1.2.0+build"]) {
  test(`rejects the tag "${tag}"`, async () => {
    const result = await run(tag);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /expected a tag like v1\.0\.0, or v1\.0\.0-rc\.1/);
  });
}

test("needs the tag's version in manifest.json and package.json", async () => {
  let result = await run("v1.2.1");
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /manifest\.json has version 1\.2\.0, not 1\.2\.1/);
  assert.match(result.stderr, /package\.json has version 1\.2\.0, not 1\.2\.1/);
  result = await run("v1.2.0", { pkg: "1.1.0" });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /package\.json has version 1\.1\.0, not 1\.2\.0/);
});

test("needs a dated section with entries", async () => {
  let result = await run("v1.2.0", { changelog: released.replace("1.2.0", "1.1.0") });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /no "## \[1\.2\.0\] - YYYY-MM-DD" section/);
  result = await run("v1.2.0", { changelog: released.replace("2026-10-27", "{{currentDate}}") });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /\[1\.2\.0\] heading needs a release date/);
  result = await run("v1.2.0", { changelog: released.replace(/- (Read|Import|Start).*\n/g, "") });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /\[1\.2\.0\] section has no entries/);
});

test("needs the unreleased entries moved into the version's section", async () => {
  const result = await run("v1.2.0-rc.1", { changelog: released.replace("### Fixed\n", "### Fixed\n- Not moved\n") });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /\[Unreleased\] section still has entries; move them into \[1\.2\.0\]/);
});
