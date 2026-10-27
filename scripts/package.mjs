// Zips the add-on, giving the same bytes for the same commit: entries in a fixed order, each
// dated at the commit's time (or SOURCE_DATE_EPOCH, in seconds) with fixed permissions, and no
// per-file metadata such as extended timestamps or owners. fflate, pinned in pnpm-lock.yaml,
// compresses the files: Node's zlib gives different bytes in different Node builds.
// Usage: node scripts/package.mjs [dist/<name>-<version>.zip]
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { deflateSync } from "fflate";

const FILES = ["manifest.json", "dist", "assets", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "licenses"];
// Read by unzip as Unix -rw-r--r-- and drwxr-xr-x; 0x10 marks a directory for MS-DOS.
const FILE_ATTRIBUTES = 0o100644 * 0x10000;
const DIRECTORY_ATTRIBUTES = 0o40755 * 0x10000 + 0x10;

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const path = process.argv[2] ?? `dist/${pkg.name}-${pkg.version}.zip`;

function commitTime() {
  let seconds = process.env.SOURCE_DATE_EPOCH;
  if (!seconds) {
    try {
      seconds = execFileSync("git", ["log", "-1", "--no-show-signature", "--format=%ct"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new Error("can't read the commit's time from git; set SOURCE_DATE_EPOCH");
    }
  }
  if (!/^\d+$/.test(seconds.trim())) throw new Error(`not a time in seconds: ${seconds}`);
  // Zip dates start in 1980.
  const date = new Date(Math.max(Number(seconds), 315532800) * 1000);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() > 2107) throw new Error("time is outside the zip date range");
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

// Sort each directory's children: unlike on Unix, Node's readdir doesn't sort on Windows.
// Zip paths always use /.
async function list(name) {
  if (!(await stat(name)).isDirectory()) return name.endsWith(".map") || resolve(name) === resolve(path) ? [] : [name];
  const names = [`${name}/`];
  for (const child of (await readdir(name)).sort()) names.push(...(await list(posix.join(name, child))));
  return names;
}

const { time, date } = commitTime();
const local = [], central = [];
let offset = 0;
for (const name of (await Promise.all(FILES.map(list))).flat()) {
  const directory = name.endsWith("/");
  const contents = directory ? Buffer.alloc(0) : await readFile(name);
  const deflated = deflateSync(contents, { level: 9 });
  const method = deflated.length < contents.length ? 8 : 0;
  const data = method === 8 ? deflated : contents;
  const filename = Buffer.from(name);
  const header = Buffer.alloc(30), entry = Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50);
  header.writeUInt16LE(directory || method === 8 ? 20 : 10, 4);
  header.writeUInt16LE(0x800, 6); // the name is UTF-8
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt32LE(crc32(contents), 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(contents.length, 22);
  header.writeUInt16LE(filename.length, 26);
  entry.writeUInt32LE(0x02014b50);
  entry.writeUInt16LE((3 << 8) | 20, 4); // made on Unix, so unzip applies the permissions
  header.copy(entry, 6, 4, 30);
  entry.writeUInt32LE(directory ? DIRECTORY_ATTRIBUTES : FILE_ATTRIBUTES, 38);
  entry.writeUInt32LE(offset, 42);
  local.push(header, filename, data);
  central.push(entry, filename);
  offset += header.length + filename.length + data.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(central.length / 2, 8);
end.writeUInt16LE(central.length / 2, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
await writeFile(path, Buffer.concat([...local, directory, end]));
console.log(`${path}: ${central.length / 2} entries`);
