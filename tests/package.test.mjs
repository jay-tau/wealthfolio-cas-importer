import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

function archive(main, file, method) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of [["manifest.json", JSON.stringify({ main })], [file, "void 0;"]]) {
    const filename = Buffer.from(name), contents = Buffer.from(text);
    const compressed = method === 8 ? deflateRawSync(contents) : contents;
    const header = Buffer.alloc(30), entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc32(contents), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(contents.length, 22);
    header.writeUInt16LE(filename.length, 26);
    entry.writeUInt32LE(0x02014b50);
    header.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(offset, 42);
    local.push(header, filename, compressed);
    central.push(entry, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const temporary = await mkdtemp(join(tmpdir(), "cas-package-"));
after(() => rm(temporary, { recursive: true, force: true }));
for (const method of [0, 8]) {
  test(`checks the archived manifest with compression ${method}`, async () => {
    const path = join(temporary, `main-${method}.zip`);
    await writeFile(path, archive("other.js", "other.js", method));
    const valid = spawnSync(process.execPath, ["scripts/check-package.mjs", path], { encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr);

    await writeFile(path, archive("missing.js", "dist/addon.js", method));
    const invalid = spawnSync(process.execPath, ["scripts/check-package.mjs", path], { encoding: "utf8" });
    assert.equal(invalid.status, 1, invalid.stdout);
    assert.match(invalid.stderr, /main, missing\.js, is missing/);
  });
}

// A made-up add-on with every file pnpm package zips, and a source map it leaves out.
const ADDON = {
  "package.json": JSON.stringify({ name: "addon", version: "1.0.0" }),
  "manifest.json": JSON.stringify({ main: "dist/addon.js" }),
  "dist/addon.js": "void 0;",
  "dist/addon.js.map": "{}",
  "assets/runtime/b.whl": "b".repeat(1000),
  "assets/runtime/a.json": "{}",
  "assets/runtime/C.txt": "C",
  "README.md": "readme",
  LICENSE: "license",
  "THIRD_PARTY_NOTICES.md": "notices",
  "licenses/z.txt": "z",
  "licenses/a.txt": "a",
};
// 2026-10-27 13:54:18 UTC, in seconds and as a zip's time and date.
const COMMIT_TIME = 1793109258;
const ZIP_TIME = (13 << 11) | (54 << 5) | (18 >> 1);
const ZIP_DATE = ((2026 - 1980) << 9) | (10 << 5) | 27;

function unpack(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const list = [];
  for (let i = 0, offset = zip.readUInt32LE(end + 16); i < zip.readUInt16LE(end + 10); i++) {
    const nameLength = zip.readUInt16LE(offset + 28), header = zip.readUInt32LE(offset + 42);
    const start = header + 30 + zip.readUInt16LE(header + 26) + zip.readUInt16LE(header + 28);
    const data = zip.subarray(start, start + zip.readUInt32LE(offset + 20));
    list.push({
      name: zip.toString("utf8", offset + 46, offset + 46 + nameLength),
      version: zip.readUInt16LE(offset + 6), method: zip.readUInt16LE(offset + 10),
      time: zip.readUInt16LE(offset + 12), date: zip.readUInt16LE(offset + 14),
      mode: zip.readUInt32LE(offset + 38) >>> 16, extra: zip.readUInt16LE(offset + 30) + zip.readUInt16LE(header + 28),
      contents: (zip.readUInt16LE(offset + 10) === 8 ? inflateRawSync(data) : data).toString(),
    });
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  return list;
}

test("packages the same bytes whatever the files' times, permissions and directory order", async () => {
  // Leave out SOURCE_DATE_EPOCH, and git's variables in case a git hook runs the tests.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "SOURCE_DATE_EPOCH" && !key.startsWith("GIT_")),
  );
  const zips = [];
  for (const [copy, seconds, mode] of [["first", 1e9, 0o644], ["second", 2e9, 0o600]]) {
    const root = join(temporary, copy);
    const names = copy === "first" ? Object.keys(ADDON) : Object.keys(ADDON).reverse();
    for (const name of names) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), ADDON[name]);
      await chmod(join(root, name), mode);
    }
    for (const name of [...names, "dist", "assets/runtime", "assets", "licenses"]) {
      await utimes(join(root, name), seconds, seconds);
    }
    // The first copy is dated by its commit, the second by SOURCE_DATE_EPOCH.
    if (copy === "first") {
      const git = (...args) => spawnSync("git", ["-c", `core.hooksPath=${join(temporary, "no-hooks")}`, ...args], {
        cwd: root, env: { ...env, GIT_COMMITTER_DATE: `${COMMIT_TIME} +0530` },
      });
      assert.equal(git("init", "-q").status, 0);
      const commit = git("-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false",
        "commit", "-q", "--allow-empty", "--no-verify", "-m", "test");
      assert.equal(commit.status, 0, commit.stderr.toString());
    }
    const packaged = spawnSync(process.execPath, [resolve("scripts/package.mjs")], {
      cwd: root, encoding: "utf8", env: copy === "first" ? env : { ...env, SOURCE_DATE_EPOCH: String(COMMIT_TIME) },
    });
    assert.equal(packaged.status, 0, packaged.stderr);
    const checked = spawnSync(process.execPath, [resolve("scripts/check-package.mjs")], { cwd: root, encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
    zips.push(await readFile(join(root, "dist/addon-1.0.0.zip")));
  }
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256(zips[1]), sha256(zips[0]));

  // Keep the root order, sort each directory's children, and leave source maps out.
  const entries = unpack(zips[0]);
  assert.deepEqual(entries.map(({ name }) => name), [
    "manifest.json", "dist/", "dist/addon.js", "assets/", "assets/runtime/", "assets/runtime/C.txt",
    "assets/runtime/a.json", "assets/runtime/b.whl", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md",
    "licenses/", "licenses/a.txt", "licenses/z.txt",
  ]);
  for (const { name, version, method, time, date, mode, extra, contents } of entries) {
    assert.deepEqual({ name, time, date, extra }, { name, time: ZIP_TIME, date: ZIP_DATE, extra: 0 });
    assert.equal(mode, name.endsWith("/") ? 0o40755 : 0o100644, name);
    assert.equal(version, name.endsWith("/") || method === 8 ? 20 : 10, name);
    assert.equal(contents, name.endsWith("/") ? "" : ADDON[name], name);
  }

  for (const [seconds, time] of [["0", 0], ["315532801", 0], ["315532803", 1]]) {
    const packaged = spawnSync(process.execPath, [resolve("scripts/package.mjs")], {
      cwd: join(temporary, "second"), encoding: "utf8", env: { ...env, SOURCE_DATE_EPOCH: seconds },
    });
    assert.equal(packaged.status, 0, packaged.stderr);
    const entries = unpack(await readFile(join(temporary, "second/dist/addon-1.0.0.zip")));
    assert.equal(entries.length, 14);
    for (const entry of entries) assert.deepEqual({ time: entry.time, date: entry.date }, { time, date: 33 });
  }
  for (const seconds of ["invalid", "4354819200", "999999999999999999999"]) {
    const packaged = spawnSync(process.execPath, [resolve("scripts/package.mjs")], {
      cwd: join(temporary, "second"), encoding: "utf8", env: { ...env, SOURCE_DATE_EPOCH: seconds },
    });
    assert.equal(packaged.status, 1, seconds);
    assert.match(packaged.stderr, /not a time in seconds|outside the zip date range/);
  }
});
