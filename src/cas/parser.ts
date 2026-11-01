import type { AddonAssets } from "@wealthfolio/addon-sdk";
import casParse from "./cas_parse.py?raw";
import casparserIsin from "./casparser_isin.py?raw";
import type { Statement } from "./types";
import workerSource from "./worker.js?raw";

const RUNTIME = "assets/runtime/";

export type CasErrorKind = "password" | "unsupported" | "parse" | "runtime";

export class CasError extends Error {
  constructor(
    readonly kind: CasErrorKind,
    message: string,
  ) {
    super(message);
  }
}

interface RuntimeFiles {
  files: string[];
  wasmParts: string[];
  wheels: string[];
}

type ParseReply = { id: number; json: string } | { id: number; errorType: string };

const STOPPED = "The parser stopped. Try reading the statement again.";

/**
 * casparser running under Pyodide in a Worker. Starting it loads about 18 MB of packaged
 * runtime files, so keep one parser per page and dispose of it when the page goes away.
 * It stops for good if Python fails or doesn't answer in time; start a new one then.
 */
export class CasParser {
  /**
   * How long Python may take to start, and then to read each PDF, before the parser stops. Reading
   * the made-up 78-row statement takes about 3 seconds in Firefox, the slowest browser.
   */
  static startTimeoutMs = 120_000;
  static parseTimeoutMs = 300_000;

  private readonly workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private rejectReady!: (error: Error) => void;
  private readonly startTimer: ReturnType<typeof setTimeout>;
  private error?: CasError;
  private readonly pending = new Map<number, { resolve: (reply: ParseReply) => void; reject: (error: Error) => void }>();
  private nextId = 0;

  constructor(assets: AddonAssets) {
    try {
      this.worker = new Worker(this.workerUrl);
    } catch (error) {
      URL.revokeObjectURL(this.workerUrl);
      throw error;
    }
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      this.worker.onmessage = ({ data }) => {
        if (data.fatal) {
          this.stop(new CasError("runtime", STOPPED));
        } else if ("id" in data) {
          this.pending.get(data.id)?.resolve(data);
          this.pending.delete(data.id);
        } else if (data.type === "ready") {
          clearTimeout(this.startTimer);
          resolve();
        } else {
          this.stop(new CasError("runtime", `Couldn't start Python: ${data.message}. Try reading the statement again.`));
        }
      };
      this.worker.onerror = (event) => {
        event.preventDefault();
        this.stop(new CasError("runtime", STOPPED));
      };
      this.boot(assets).catch((error) =>
        this.stop(new CasError("runtime", `Couldn't load the parser's files: ${error?.message ?? error}`)),
      );
    });
    // Reported by parse(); don't let an unused parser raise an unhandled rejection.
    this.ready.catch(() => {});
    this.startTimer = setTimeout(
      () => this.stop(new CasError("runtime", "The parser didn't start in time. Try reading the statement again.")),
      CasParser.startTimeoutMs,
    );
  }

  private async boot(assets: AddonAssets) {
    // Not manifest.json: Wealthfolio would take any file of that name for the add-on manifest.
    const runtime: RuntimeFiles = JSON.parse(await (await assets.getBlob(`${RUNTIME}files.json`)).text());
    const names = [...runtime.files, ...runtime.wasmParts, ...runtime.wheels];
    const blobs = await Promise.all(names.map((name) => assets.getBlob(RUNTIME + name)));
    if (this.error) return;
    const files = Object.fromEntries(names.map((name, i) => [name, blobs[i]]));
    this.worker.postMessage({
      type: "boot",
      files,
      wasmParts: runtime.wasmParts,
      wheels: runtime.wheels,
      pythonFiles: { "cas_parse.py": casParse, "casparser_isin.py": casparserIsin },
    });
  }

  /**
   * Parses a CAMS/KFintech (detailed or summary) or NSDL/CDSL statement. Throws a `CasError`
   * for anything else. The PDF's buffer is transferred to the Worker, so it is unusable afterwards.
   */
  async parse(pdf: ArrayBuffer, password: string): Promise<Statement> {
    await this.ready;
    if (this.error) throw this.error;
    const id = this.nextId++;
    const reply = await new Promise<ParseReply>((resolve, reject) => {
      const timer = setTimeout(
        () => this.stop(new CasError("runtime", "The parser didn't finish reading this PDF in time. Try reading it again.")),
        CasParser.parseTimeoutMs,
      );
      this.pending.set(id, {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.worker.postMessage({ type: "parse", id, pdf, password }, [pdf]);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
    if ("errorType" in reply) {
      if (reply.errorType === "IncorrectPasswordError") {
        throw new CasError("password", "Wrong password for this PDF.");
      }
      throw new CasError("parse", "Couldn't parse this PDF. Check that it is a CAMS, KFintech, NSDL or CDSL statement.");
    }
    // NSDL/CDSL results have no `cas_type` and a different shape.
    const data = JSON.parse(reply.json) as Statement;
    if ("cas_type" in data && data.cas_type !== "DETAILED" && data.cas_type !== "SUMMARY") {
      throw new CasError("unsupported", `Couldn't tell whether this ${data.file_type} statement is detailed or a summary.`);
    }
    return data;
  }

  /** Whether the parser has stopped (an error, a timeout or `dispose()`), so it can't read any more PDFs. */
  get stopped() {
    return this.error !== undefined;
  }

  private stop(error: CasError) {
    this.error ??= error;
    clearTimeout(this.startTimer);
    this.rejectReady(this.error);
    for (const { reject } of this.pending.values()) reject(this.error);
    this.pending.clear();
    this.worker.terminate();
    URL.revokeObjectURL(this.workerUrl);
  }

  dispose() {
    this.stop(new CasError("runtime", "The parser was closed."));
  }
}
