import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";

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
