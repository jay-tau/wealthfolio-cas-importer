# Third-party notices

CAS Importer is released under the MIT licence (see `LICENSE`). To read CAS statements inside Wealthfolio it runs Python in the browser, so its package also carries, unmodified, the Pyodide 314.0.7 runtime (`pyodide.mjs`, `pyodide.asm.mjs`, `pyodide.asm.wasm` (shipped in parts of at most 4 MiB, joined again when it loads), `python_stdlib.zip`, `pyodide-lock.json`) and the Python wheels listed below. Pyodide and hiwire are under the Mozilla Public License 2.0, and their source code is available at https://github.com/pyodide/pyodide/tree/314.0.7 and https://github.com/pyodide/hiwire/tree/6a1e67280a15d929ebeceee54a6358c9c8d5f697. Each component's licence is listed below. Full texts are either in `licenses/` or inside the wheel that ships the component. `casparser_isin.py` is the add-on's own code (MIT) and contains no third-party code.

"Ships in": **wasm** = compiled into `pyodide.asm.wasm`; **asm.mjs** / **mjs** = included in `pyodide.asm.mjs` / `pyodide.mjs`; **stdlib** = Python source files in `python_stdlib.zip`; **wheel** = inside the named `.whl` file.

## Pyodide runtime

| Component | Version | Licence (SPDX) | Full text | Upstream source | Ships in |
|---|---|---|---|---|---|
| Pyodide (JS loader, JS runtime, C core, `pyodide`/`_pyodide` Python packages) | 314.0.7 | MPL-2.0 | `licenses/Pyodide-314.0.7-MPL-2.0.txt` | https://github.com/pyodide/pyodide/tree/314.0.7 | mjs, asm.mjs, **wasm**, stdlib |
| stackframe + error-stack-parser (Pyodide's TypeScript port) | copy in Pyodide 314.0.7 | MIT | `licenses/Pyodide-vendored-stackframe-error-stack-parser-MIT.txt` | https://github.com/pyodide/pyodide/tree/314.0.7/src/js/vendor/stackframe | mjs, asm.mjs |
| hiwire | git 6a1e672 | MPL-2.0 | `licenses/Pyodide-314.0.7-MPL-2.0.txt` (same text) | https://github.com/pyodide/hiwire/tree/6a1e67280a15d929ebeceee54a6358c9c8d5f697 | **wasm** |
| CPython interpreter and standard library | 3.14.2 | Python-2.0 | `licenses/CPython-3.14.2-LICENSE.txt` | https://github.com/python/cpython/tree/v3.14.2 | **wasm**, stdlib |
| Code in CPython from other authors: Mersenne Twister, cfuhash, `_zstd` bindings from pyzstd (BSD-3-Clause); `qsbr.c` GUS (BSD-2-Clause); SipHash, asyncio parts from uvloop (MIT); `dtoa.c` (dtoa); `http.cookies`, `trace`, `uu_codec`, `xmlrpc.client` (HPND-style notices) | 3.14.2 | as listed | `licenses/CPython-3.14.2-incorporated-software.txt` | https://github.com/python/cpython/blob/v3.14.2/Doc/license.rst | **wasm**, stdlib |
| libmpdec (copy in CPython) | 2.5.1 | BSD-2-Clause | `licenses/CPython-3.14.2-incorporated-software.txt` (libmpdec) | https://github.com/python/cpython/tree/v3.14.2/Modules/_decimal/libmpdec | **wasm** |
| mimalloc (copy in CPython) | copy in CPython 3.14.2 | MIT | `licenses/CPython-3.14.2-incorporated-software.txt` (mimalloc) | https://github.com/python/cpython/tree/v3.14.2/Objects/mimalloc | **wasm** |
| Expat (copy in CPython) | 2.7.3 | MIT | `licenses/expat-2.7.3-MIT.txt` | https://github.com/python/cpython/tree/v3.14.2/Modules/expat | **wasm** |
| HACL* (copy in CPython) | hacl-star 8ba599b2 | MIT | `licenses/HACL-star-MIT.txt` | https://github.com/python/cpython/tree/v3.14.2/Modules/_hacl | **wasm** |
| libffi | 3.4.4 + git f08493d2 | MIT | `licenses/libffi-3.4.4-git-f08493d2-MIT.txt` | https://github.com/libffi/libffi/tree/f08493d249d2067c8b3207ba46693dd858f95db3 | **wasm** |
| XZ Utils (liblzma) | 5.2.2 | LicenseRef-Public-Domain | `licenses/xz-5.2.2-liblzma-public-domain.txt` | https://github.com/xz-mirror/xz/releases/tag/v5.2.2 | **wasm** |
| Zstandard | 1.5.7 | BSD-3-Clause (chosen from BSD-3-Clause OR GPL-2.0-only) | `licenses/zstd-1.5.7-BSD-3-Clause.txt` | https://github.com/python/cpython-source-deps/tree/zstd-1.5.7 | **wasm** |
| SQLite | 3.39.0 | blessing | `licenses/SQLite-3.39.0-public-domain.txt` | https://www.sqlite.org/2022/sqlite-autoconf-3390000.tar.gz | **wasm** |
| zlib (Emscripten port) | 1.3.1 | Zlib | `licenses/zlib-1.3.1-Zlib.txt` | https://github.com/madler/zlib/tree/v1.3.1 | **wasm** |
| bzip2 (Emscripten port) | 1.0.6 | bzip2-1.0.6 | `licenses/bzip2-1.0.6-bzip2.txt` | https://github.com/emscripten-ports/bzip2/tree/1.0.6 | **wasm** |
| Emscripten JS runtime and C system libraries | 5.0.3 | MIT OR NCSA | `licenses/Emscripten-5.0.3-MIT-OR-NCSA.txt` | https://github.com/emscripten-core/emscripten/tree/5.0.3 | asm.mjs, **wasm** |
| MiniLZ4 (Emscripten `third_party/mini-lz4.js`) | copy in Emscripten 5.0.3 | MIT | `licenses/Emscripten-mini-lz4-MIT.txt` | https://github.com/emscripten-core/emscripten/blob/5.0.3/third_party/mini-lz4.js | asm.mjs |
| musl libc (Emscripten's copy) | 1.2.5 | MIT | `licenses/musl-libc-MIT.txt` | https://github.com/emscripten-core/emscripten/tree/5.0.3/system/lib/libc/musl | **wasm** |
| dlmalloc | 2.8.6 | CC0-1.0 | `licenses/dlmalloc-2.8.6-CC0-1.0.txt` | https://github.com/emscripten-core/emscripten/blob/5.0.3/system/lib/dlmalloc.c | **wasm** |
| LLVM libc++ (uses llvm-libc headers) | 21.1.8 | Apache-2.0 WITH LLVM-exception | `licenses/LLVM-libcxx-Apache-2.0-WITH-LLVM-exception.txt`, `licenses/LLVM-libc-Apache-2.0-WITH-LLVM-exception.txt` | https://github.com/emscripten-core/emscripten/tree/5.0.3/system/lib/libcxx | **wasm** |
| LLVM libc++abi | 21.1.8 | Apache-2.0 WITH LLVM-exception | `licenses/LLVM-libcxxabi-Apache-2.0-WITH-LLVM-exception.txt` | https://github.com/emscripten-core/emscripten/tree/5.0.3/system/lib/libcxxabi | **wasm** |
| LLVM libunwind | 21.1.8 | Apache-2.0 WITH LLVM-exception | `licenses/LLVM-libunwind-Apache-2.0-WITH-LLVM-exception.txt` | https://github.com/emscripten-core/emscripten/tree/5.0.3/system/lib/libunwind | **wasm** |
| LLVM compiler-rt (builtins) | 21.1.8 | Apache-2.0 WITH LLVM-exception | `licenses/LLVM-compiler-rt-Apache-2.0-WITH-LLVM-exception.txt` | https://github.com/emscripten-core/emscripten/tree/5.0.3/system/lib/compiler-rt | **wasm** |

## Python wheels

| Component | Version | Licence (SPDX) | Full text | Upstream source | Ships in |
|---|---|---|---|---|---|
| casparser | 1.4.1 | MIT | `casparser-1.4.1.dist-info/licenses/LICENSE` | https://github.com/codereverser/casparser/tree/v1.4.1 | wheel `casparser-1.4.1-py3-none-any.whl` |
| pypdfium2 | 5.14.0 | Apache-2.0 OR BSD-3-Clause | `pypdfium2-5.14.0.dist-info/licenses/LICENSES/` | https://github.com/pypdfium2-team/pypdfium2/tree/5.14.0 | wheel `pypdfium2-5.14.0-py3-none-pyemscripten_2026_0_wasm32.whl` |
| PDFium and the libraries built into it (FreeType, OpenJPEG, ICU, Abseil and the others listed in `BUILD_LICENSES/`) | PDFium 156.0.8076.0 | BSD-3-Clause and others, one file each | `pypdfium2-5.14.0.dist-info/licenses/BUILD_LICENSES/` | https://pdfium.googlesource.com/pdfium | same wheel (`pypdfium2_raw/libpdfium.so`) |
| pydantic | 2.12.5 | MIT | `pydantic-2.12.5.dist-info/licenses/LICENSE` | https://github.com/pydantic/pydantic/tree/v2.12.5 | wheel `pydantic-2.12.5-py3-none-any.whl` |
| pydantic-core | 2.41.5 | MIT | `pydantic_core-2.41.5.dist-info/licenses/LICENSE` | https://github.com/pydantic/pydantic-core/tree/v2.41.5 | wheel `pydantic_core-2.41.5-cp314-cp314-pyemscripten_2026_0_wasm32.whl` |
| Rust crates compiled into pydantic-core (63 crates, Rust standard library 1.97.1, hashbrown 0.17.1) | per crate | MIT, Unicode-3.0, BSL-1.0 (the option used for each crate is named in the file) | `licenses/pydantic_core-2.41.5-Rust-crates.txt` (the wheel does not carry these) | https://crates.io (crate list and checksums: pydantic-core 2.41.5 `Cargo.lock`) | same wheel (`_pydantic_core…wasm32-emscripten.so`) |
| typing_extensions | 4.15.0 | PSF-2.0 | `typing_extensions-4.15.0.dist-info/licenses/LICENSE` | https://github.com/python/typing_extensions/tree/4.15.0 | wheel `typing_extensions-4.15.0-py3-none-any.whl` |
| annotated-types | 0.7.0 | MIT | `annotated_types-0.7.0.dist-info/licenses/LICENSE` | https://github.com/annotated-types/annotated-types/tree/v0.7.0 | wheel `annotated_types-0.7.0-py3-none-any.whl` |
| typing-inspection | 0.4.2 | MIT | `typing_inspection-0.4.2.dist-info/licenses/LICENSE` | https://github.com/pydantic/typing-inspection/tree/v0.4.2 | wheel `typing_inspection-0.4.2-py3-none-any.whl` |
| python-dateutil | 2.9.0.post0 | Apache-2.0 AND BSD-3-Clause | `python_dateutil-2.9.0.post0.dist-info/LICENSE` | https://github.com/dateutil/dateutil/tree/2.9.0.post0 | wheel `python_dateutil-2.9.0.post0-py2.py3-none-any.whl` |
| six | 1.17.0 | MIT | `six-1.17.0.dist-info/LICENSE` | https://github.com/benjaminp/six/tree/1.17.0 | wheel `six-1.17.0-py2.py3-none-any.whl` |

The full text of the Apache License 2.0, which python-dateutil and two standard-library modules (`profile`, `pstats`) refer to, is reproduced in `licenses/LLVM-libcxx-Apache-2.0-WITH-LLVM-exception.txt` and in pypdfium2's `LICENSES/Apache-2.0.txt`.
