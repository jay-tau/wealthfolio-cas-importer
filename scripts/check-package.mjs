// Checks the packaged add-on against the limits Wealthfolio's installer enforces
// (extract_addon_zip_archive in crates/core/src/addons/service.rs, v3.11.0).
// Usage: node scripts/check-package.mjs [dist/<name>-<version>.zip]
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const MiB = 1024 * 1024;
const LIMITS = { compressed: 50 * MiB, entries: 256, file: 5 * MiB, total: 25 * MiB };

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const path = process.argv[2] ?? `dist/${pkg.name}-${pkg.version}.zip`;
const zip = await readFile(path);

// The zip's central directory lists every entry with its uncompressed size.
function entries(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error(`${path}: not a zip file`);
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error(`${path}: Zip64 archives aren't supported`);
  const list = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error(`${path}: damaged central directory`);
    const nameLength = zip.readUInt16LE(offset + 28);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
    list.push({
      name, size: zip.readUInt32LE(offset + 24), method: zip.readUInt16LE(offset + 10),
      compressedSize: zip.readUInt32LE(offset + 20), offset: zip.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  return list;
}

const all = entries(zip);
// Wealthfolio skips directories and source maps, and limits the rest.
const files = all.filter(({ name }) => !name.endsWith("/") && !name.endsWith(".map"));
const total = files.reduce((sum, { size }) => sum + size, 0);
const largest = files.reduce((a, b) => (b.size > a.size ? b : a));
const problems = [];
if (zip.length > LIMITS.compressed) problems.push(`the zip is ${zip.length} bytes, over ${LIMITS.compressed}`);
if (all.length > LIMITS.entries) problems.push(`${all.length} entries, over ${LIMITS.entries}`);
for (const { name, size } of files) {
  if (size > LIMITS.file) problems.push(`${name} is ${size} bytes, over ${LIMITS.file}`);
  if (name.includes("\\") || name.startsWith("/") || name.split("/").includes("..")) problems.push(`${name}: unsafe path`);
}
if (total > LIMITS.total) problems.push(`${total} bytes uncompressed, over ${LIMITS.total}`);
// Wealthfolio takes any entry named manifest.json for the add-on manifest.
const manifests = files.filter(({ name }) => name === "manifest.json" || name.endsWith("/manifest.json"));
if (manifests.length !== 1 || manifests[0].name !== "manifest.json") {
  problems.push(`expected only the root manifest.json, found ${manifests.map(({ name }) => name).join(", ") || "none"}`);
} else if (!problems.length) {
  const entry = manifests[0];
  if (zip.readUInt32LE(entry.offset) !== 0x04034b50) throw new Error(`${path}: damaged manifest header`);
  const start = entry.offset + 30 + zip.readUInt16LE(entry.offset + 26) + zip.readUInt16LE(entry.offset + 28);
  const compressed = zip.subarray(start, start + entry.compressedSize);
  if (compressed.length !== entry.compressedSize) throw new Error(`${path}: truncated manifest`);
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${path}: unsupported manifest compression ${entry.method}`);
  const contents = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: LIMITS.file });
  if (contents.length !== entry.size) throw new Error(`${path}: manifest size differs from its directory entry`);
  const manifest = JSON.parse(contents.toString("utf8"));
  if (!files.some(({ name }) => name === manifest.main)) problems.push(`manifest.json's main, ${manifest.main}, is missing`);
}

const mib = (bytes) => `${(bytes / MiB).toFixed(1)} MiB`;
console.log(
  `${path}: ${all.length}/${LIMITS.entries} entries, ${mib(total)}/${mib(LIMITS.total)} uncompressed, ` +
    `largest ${largest.name} ${mib(largest.size)}/${mib(LIMITS.file)}`,
);
for (const problem of problems) console.error(`  ${problem}`);
process.exit(problems.length ? 1 : 0);
