import { rowsMissClosing } from "../cas/mapping.ts";
import type { CasData, CasScheme } from "../cas/types.ts";
import { fundKey, holdingKey } from "./choices.ts";
import { fundName, readableName } from "./fund-name.ts";
import { longDate, STATEMENT_WORDS, units } from "./review-format.ts";

// casparser's `parse_warnings`, read from their text and said in the Review screen's words. casparser
// 1.4.1 words five kinds; any other, such as a new one in a later casparser, keeps its own text so it
// can be reported.

/** A scheme as a warning names it: its name as printed, and its registrar's scheme code. */
export interface SchemeRef {
  name: string;
  code: string;
}

/** A warning's kind and the details it gives. */
export type ParseWarning =
  /** A row's printed unit balance isn't the units the rows add up to by then. */
  | { kind: "balance"; scheme: SchemeRef; date: string; type: string; computed: string; printed: string }
  /** The closing unit balance isn't the units the rows add up to. */
  | { kind: "closing"; scheme: SchemeRef; computed: string; printed: string }
  /** A scheme that wasn't read, with its page or where it was dropped, and some of its printed text. */
  | { kind: "skipped"; page?: string; where?: string; text: string }
  /** A depository statement's fund line whose NAV and value were worked out from its largest amount. */
  | { kind: "value"; isin: string }
  | { kind: "other"; text: string };

// A Python string's repr, as casparser quotes names and printed text: in single quotes, or in double
// quotes when it has a single quote and no double quote.
const ESCAPE = String.raw`\\(?:['"\\nrt]|x[0-9a-f]{2}|u[0-9a-f]{4}|U(?:000[0-9a-f]{5}|0010[0-9a-f]{4}))`;
// repr escapes controls and Unicode separators, apart from ordinary spaces.
const REPR = String.raw`('(?:[^'\\\p{C}\p{Z}]| |${ESCAPE})*'|"(?:[^"\\\p{C}\p{Z}]| |${ESCAPE})*")`;
const MISREAD = "; a transaction row may be missing or mis-parsed";
// An absolute end check: $ alone would also accept a trailing newline.
const BALANCE = new RegExp(
  String.raw`^${REPR} \[(.*?)\]: unit-balance discontinuity at (.+?) \((.+?)\) — computed (\S+) but statement printed (\S+) \(Δ=\S+\)${MISREAD}(?![\s\S])`,
  "u",
);
const CLOSING = new RegExp(String.raw`^${REPR} \[(.*?)\]: closing unit balance mismatch — computed (\S+) but statement printed (\S+) \(Δ=\S+\)${MISREAD}(?![\s\S])`, "u");
const UNREAD_ON_PAGE = new RegExp(
  String.raw`^unparseable scheme header region before 'Opening Unit Balance' on page (\d+); the scheme and its transactions were skipped: ${REPR}(?![\s\S])`,
  "u",
);
const UNREAD_AT = new RegExp(
  String.raw`^scheme header region discarded at (.+?) without an 'Opening Unit Balance' anchor; its scheme and transactions were skipped: ${REPR}(?![\s\S])`,
  "u",
);
const VALUE = /^MF holdings (.*?): no closing nav\/value pair; inferred from max tail(?![\s\S])/;

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t" };

/** A Python repr's string: `'Fictiva\x02 Fund'` → "Fictiva\u0002 Fund". */
function unrepr(quoted: string) {
  return quoted.slice(1, -1).replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[^])/g, (all, escape: string) => {
    if (escape.length === 1) return ESCAPES[escape] ?? escape;
    const code = parseInt(escape.slice(1), 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

/** A warning's kind and details, from casparser's text. */
export function readWarning(text: string): ParseWarning {
  let m: RegExpExecArray | null;
  if ((m = BALANCE.exec(text))) {
    return { kind: "balance", scheme: { name: unrepr(m[1]), code: m[2] }, date: m[3], type: m[4], computed: m[5], printed: m[6] };
  }
  if ((m = CLOSING.exec(text))) return { kind: "closing", scheme: { name: unrepr(m[1]), code: m[2] }, computed: m[3], printed: m[4] };
  if ((m = UNREAD_ON_PAGE.exec(text))) return { kind: "skipped", page: m[1], text: unrepr(m[2]) };
  if ((m = UNREAD_AT.exec(text))) return { kind: "skipped", where: m[1], text: unrepr(m[2]) };
  if ((m = VALUE.exec(text))) return { kind: "value", isin: m[1].trim() };
  return { kind: "other", text };
}

/** A row's type as a word, after "the": casparser writes it as "TransactionType.PURCHASE_SIP" or "PURCHASE_SIP". */
const ROW_WORDS: Record<string, string> = {
  ...STATEMENT_WORDS,
  STT_TAX: "STT",
  STAMP_DUTY_TAX: "stamp duty",
  TDS_TAX: "TDS",
  SEGREGATION: "credit of segregated units",
  GIFT_IN: "gift received",
  GIFT_OUT: "gift given",
  REVERSAL: "reversal",
};
const rowWord = (type: string) => ROW_WORDS[type.replace(/^TransactionType\./, "")];

/** Where casparser dropped a scheme it couldn't read. */
const PLACES: Record<string, string> = {
  "AMC boundary": "just before the next fund house",
  "folio boundary": "just before the next folio",
  "end of document": "at the end of the statement",
};

const MAY_BE_MISSING = "A row may be missing or misread.";

/** What the Review screen knows about the funds a warning names. */
export interface WarningContext {
  /** The detailed or summary statement, whose schemes the warnings name. */
  statement?: CasData;
  /** The name the Review screen shows for a fund or holding, by its key, if it lists one. */
  nameOf: (key: string) => string | undefined;
  /**
   * The detailed Review screen asks about each fund whose rows don't add up to its closing balance:
   * casparser's warning about its closing balance isn't repeated.
   */
  asksUnbalanced?: boolean;
}

/** The statement's schemes a warning names, by their readable name and scheme code. */
function schemesOf(statement: CasData | undefined, ref: SchemeRef): CasScheme[] {
  const name = readableName(ref.name);
  return (statement?.folios ?? []).flatMap((f) => f.schemes).filter((s) => s.rta_code === ref.code && readableName(s.scheme) === name);
}

/**
 * A scheme as the Review screen names it; one it doesn't list, such as a closed scheme, by its
 * printed name as the screen shortens fund names, else by its scheme code.
 */
function schemeName(ref: SchemeRef, context: WarningContext) {
  const [scheme] = schemesOf(context.statement, ref);
  const shown = scheme && context.nameOf(fundKey(scheme));
  if (shown) return shown;
  const printed = readableName(ref.name);
  if (printed) return fundName(printed) || printed;
  return ref.code.trim() ? `The fund with scheme code ${ref.code.trim()}` : "A fund";
}

function isinName(isin: string, context: WarningContext) {
  const shown = isin ? context.nameOf(holdingKey({ isin, rta: null, rtaCode: null })) : undefined;
  return shown || (isin ? `The fund with ISIN ${isin}` : "A fund");
}

/** One warning on the Review screen. */
export interface WarningLine {
  /** What it means and what to do, in the Review screen's words. */
  text: string;
  /** casparser's own text, to copy and report, for a warning the add-on doesn't recognise. */
  message?: string;
}

/** A warning in the Review screen's words. */
export function warningLine(warning: ParseWarning, context: WarningContext): WarningLine {
  switch (warning.kind) {
    case "balance": {
      const word = rowWord(warning.type);
      const after = `after the ${word ?? "row"} on ${longDate(warning.date)}`;
      return {
        text: `${schemeName(warning.scheme, context)}: ${after}, its rows add up to ${units(warning.computed)} units, but the statement prints ${units(warning.printed)}. ${MAY_BE_MISSING}`,
      };
    }
    case "closing":
      return {
        text: `${schemeName(warning.scheme, context)}: its rows add up to ${units(warning.computed)} units, but the statement's closing balance is ${units(warning.printed)}. ${MAY_BE_MISSING}`,
      };
    case "skipped": {
      const place = warning.page ? `on page ${warning.page}` : PLACES[warning.where ?? ""];
      const printed = readableName(warning.text);
      return {
        text: `A fund ${place ? `${place} ` : ""}couldn't be read${printed ? `: “${printed}”` : ""}. Its transactions aren't in this import: find it in the PDF and add them in Wealthfolio yourself.`,
      };
    }
    case "value":
      return {
        text: `${isinName(warning.isin, context)}: its NAV and value couldn't be read from its line, so the largest amount on that line was taken as its value. Check its NAV, value and cost against the PDF.`,
      };
    case "other":
      return { text: "casparser found something it couldn't read cleanly. To report it, copy its message:", message: readableName(warning.text) };
  }
}

/**
 * The statement's warnings in the Review screen's words, in casparser's order, each once. With
 * `asksUnbalanced`, a closing balance warning is left out when the screen asks about its fund:
 * when the statement's rows for every scheme it can name don't add up, the add-on's own check.
 */
export function warningLines(warnings: readonly string[], context: WarningContext): WarningLine[] {
  const lines = new Map<string, WarningLine>();
  for (const text of warnings) {
    const warning = readWarning(text);
    if (warning.kind === "closing" && context.asksUnbalanced) {
      const schemes = schemesOf(context.statement, warning.scheme);
      if (schemes.length && schemes.every(rowsMissClosing)) continue;
    }
    const line = warningLine(warning, context);
    lines.set(`${line.text}\n${line.message ?? ""}`, line);
  }
  return [...lines.values()];
}
