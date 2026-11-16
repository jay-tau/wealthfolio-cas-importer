import type { AddonContext } from "@wealthfolio/addon-sdk";
import { Alert, AlertDescription, AlertTitle, Button, Checkbox, Input, Label, Spinner } from "@wealthfolio/ui";
import { type RefCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CasError, CasParser } from "../cas/parser";
import type { Statement } from "../cas/types";
import { PASSWORD_SECRET } from "../lib/choices";
import { focusDropped, useFocusReturn } from "../lib/focus";
import { LinkButton, WrapButton } from "./review/parts";

/** What went wrong with the last read, as the form says it. */
type Failure =
  | { kind: "password" | "saved-password" }
  | { kind: "not-cas"; reason?: string }
  | { kind: "runtime" }
  | { kind: "accounts" };

const PASSWORD_WORDS = {
  password: "That password didn't open the PDF. Check it and try again.",
  "saved-password": "Your saved password didn't open this PDF. Type its password.",
};

/**
 * Adding a statement: the PDF, chosen or dropped, its password, and Read statement. Every failure
 * says what to do next and keeps the file and the password typed: a wrong password goes back to its
 * field, a reader that stopped reads the same file again with Try again, and accounts that couldn't
 * be read are read again without reading the PDF again.
 */
export function StatementForm({ ctx, onClear, onRead, disabled = false, fileRef, reset = 0 }: {
  ctx: AddonContext;
  onClear: () => void;
  /** Called with the statement and its file's name. A `CasError` of kind "accounts" offers Try again. */
  onRead: (data: Statement, fileName: string) => Promise<void>;
  disabled?: boolean;
  fileRef?: RefCallback<HTMLInputElement>;
  /** Changed to clear the chosen file, as Use another file does. The password stays. */
  reset?: number;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const parser = useRef<CasParser | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  // The saved password, and whether this read uses it rather than the field.
  const [saved, setSaved] = useState<string | null>(null);
  const [useSaved, setUseSaved] = useState(false);
  const [loadingPassword, setLoadingPassword] = useState(true);
  const [reading, setReading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [sayPassword, setSayPassword] = useState(false);
  // The statement read when the accounts couldn't be, so Try again doesn't read the PDF again.
  const kept = useRef<{ data: Statement; fileName: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Read statement and the PDF password stay, so whichever started the read gets the focus back,
  // unless what went wrong takes it.
  const focusReturn = useFocusReturn(reading);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // The control that takes the focus once the form is enabled again, if the user didn't move it.
  const focusNext = useRef<string | null>(null);
  const ids = {
    hint: `${uid}-hint`,
    error: `${uid}-password-error`,
    about: `${uid}-about`,
    status: `${uid}-reading`,
    another: `${uid}-another`,
    retry: `${uid}-retry`,
  };

  useEffect(() => () => parser.current?.dispose(), []);

  // A file dropped beside the drop area would open in the add-on's frame, in place of the page and
  // everything done on it, even during a review.
  useEffect(() => {
    const keep = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", keep);
    window.addEventListener("drop", keep);
    return () => {
      window.removeEventListener("dragover", keep);
      window.removeEventListener("drop", keep);
    };
  }, []);

  useEffect(() => {
    if (!reset) return;
    setFile(null);
    setFailure(null);
    kept.current = null;
    if (fileInput.current) fileInput.current.value = "";
  }, [reset]);

  useEffect(() => {
    ctx.api.secrets.get(PASSWORD_SECRET).then(
      (value) => {
        if (value === null) return;
        setSaved(value);
        setUseSaved(true);
      },
      () => ctx.api.logger.warn("Couldn't read the saved statement password."),
    ).finally(() => setLoadingPassword(false));
  }, [ctx]);

  const locked = disabled || reading || loadingPassword;

  // After the fieldset is enabled again, before the user can move the focus: the focus goes to the
  // control that says what to do next, unless the user moved it while the statement was read.
  useLayoutEffect(() => {
    const next = focusNext.current;
    if (locked || !next) return;
    focusNext.current = null;
    const element = document.getElementById(next);
    if (!element || !(focusDropped() || (document.hasFocus() && element.closest("fieldset")?.contains(document.activeElement)))) {
      // The field's description isn't read when the user has moved the focus away.
      if (next === "cas-password") setSayPassword(true);
      return;
    }
    element.focus();
    if (element instanceof HTMLInputElement && element.type === "password") element.select();
  });

  // Start Python while the user types the password; it takes a few seconds. A parser that has
  // stopped can't read again, so the next read starts a new one.
  const startParser = () => {
    if (parser.current && !parser.current.stopped) return parser.current;
    parser.current = null;
    try {
      parser.current = new CasParser(ctx.assets);
    } catch (e) {
      ctx.api.logger.error(`Couldn't start the parser: ${String(e)}`);
    }
    return parser.current;
  };

  const choose = (chosen: File | null) => {
    onClear();
    setFile(chosen);
    setFailure(null);
    kept.current = null;
    startParser();
  };

  /** Remembers the password typed, or replaces the saved one, once it has opened a statement. */
  const keepPassword = async () => {
    // A statement without a password reads with the field empty, which isn't remembered.
    if (useSaved || !remember || !password) return;
    try {
      await ctx.api.secrets.set(PASSWORD_SECRET, password);
      setSaved(password);
      setRemember(false);
      setUseSaved(true);
    } catch {
      ctx.api.toast.error("Couldn't remember the password.");
    }
  };

  const forget = async () => {
    try {
      await ctx.api.secrets.delete(PASSWORD_SECRET);
      setSaved(null);
      setRemember(false);
    } catch {
      ctx.api.toast.error("Couldn't forget the saved password.");
    }
  };

  const fail = (next: Failure, focus: string) => {
    setSayPassword(false);
    setFailure(next);
    focusNext.current = focus;
  };

  /** Hands the statement to the page; accounts that can't be read offer Try again. */
  const deliver = async (data: Statement, fileName: string) => {
    try {
      await onRead(data, fileName);
      kept.current = null;
    } catch (e) {
      if (!(e instanceof CasError) || e.kind !== "accounts") throw e;
      ctx.api.logger.error(e.message);
      kept.current = { data, fileName };
      fail({ kind: "accounts" }, ids.retry);
    }
  };

  const readStatement = async () => {
    const casParser = startParser();
    if (!file) return;
    focusReturn.hold();
    setReading(true);
    onClear();
    setFailure(null);
    kept.current = null;
    const usedSaved = useSaved && saved !== null;
    try {
      if (!casParser) throw new CasError("runtime", "The parser couldn't start.");
      const data = await casParser.parse(await file.arrayBuffer(), usedSaved ? saved : password);
      await keepPassword();
      await deliver(data, file.name);
    } catch (e) {
      const error = e instanceof CasError ? e : new CasError("runtime", String(e));
      if (error.kind === "password") {
        if (usedSaved) {
          // The saved password stays for other statements; this one needs its own.
          setUseSaved(false);
          setPassword("");
          fail({ kind: "saved-password" }, "cas-password");
        } else fail({ kind: "password" }, "cas-password");
      } else if (error.kind === "runtime") {
        ctx.api.logger.error(error.message);
        fail({ kind: "runtime" }, ids.retry);
      } else {
        ctx.api.logger.error(error.message);
        fail({ kind: "not-cas", reason: error.reason }, ids.another);
      }
    } finally {
      setReading(false);
    }
  };

  /** Try again: the statement read, handed over again, or the same file read again. */
  const retry = async () => {
    const statement = kept.current;
    if (failure?.kind !== "accounts" || !statement) return void readStatement();
    focusReturn.hold();
    setReading(true);
    setFailure(null);
    try {
      await deliver(statement.data, statement.fileName);
    } catch (e) {
      ctx.api.logger.error(String(e));
      fail({ kind: "accounts" }, ids.retry);
    } finally {
      setReading(false);
    }
  };

  const chooseAnother = () => {
    const input = fileInput.current;
    if (!input) return;
    input.focus();
    input.click();
  };

  // A statement without a password reads with any password, an empty one included.
  const canRead = Boolean(file) && !locked;
  const passwordError = failure?.kind === "password" || failure?.kind === "saved-password" ? PASSWORD_WORDS[failure.kind] : "";
  const notCas = failure?.kind === "not-cas";

  return (
    <div className="space-y-4">
      {/* Not a <form>: the add-on's sandboxed frame isn't allowed to submit forms. */}
      <fieldset disabled={locked} className="grid max-w-xl gap-4">
        <div
          className={`grid gap-2 rounded-lg border-2 border-dashed p-6 ${dragging ? "border-primary bg-muted" : ""}`}
          onDragOver={(event) => {
            if (locked || !event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(event) => {
            setDragging(false);
            const dropped = event.dataTransfer.files;
            if (locked || !dropped.length) return;
            event.preventDefault();
            // The field shows the file dropped, as it does one chosen.
            if (fileInput.current) fileInput.current.files = dropped;
            choose(dropped[0]);
          }}
        >
          <Label htmlFor="cas-file" className="text-base font-medium">
            Choose or drop your CAS PDF
          </Label>
          <p id={ids.about} className="text-muted-foreground text-sm">
            A Consolidated Account Statement from CAMS, KFintech, NSDL or CDSL. It's read on this device and never uploaded;
            fund codes and names are sent to price providers to find prices.
          </p>
          <Input
            ref={(element) => {
              fileInput.current = element;
              if (!locked) fileRef?.(element);
            }}
            id="cas-file"
            type="file"
            accept="application/pdf,.pdf"
            aria-describedby={ids.about}
            onChange={(event) => choose(event.target.files?.[0] ?? null)}
          />
        </div>
        {useSaved && saved !== null ? (
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span>Using your saved password</span>
            <span aria-hidden="true">·</span>
            <LinkButton
              type="button"
              onClick={() => {
                setUseSaved(false);
                setPassword("");
                setRemember(false);
                focusNext.current = "cas-password";
              }}
            >
              Use a different password
            </LinkButton>
          </p>
        ) : (
          <div className="grid gap-2">
            <Label htmlFor="cas-password">PDF password</Label>
            <Input
              id="cas-password"
              type="password"
              autoComplete="off"
              aria-invalid={passwordError ? true : undefined}
              aria-describedby={passwordError ? `${ids.error} ${ids.hint}` : ids.hint}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                if (passwordError) setFailure(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canRead) void readStatement();
              }}
            />
            {passwordError && (
              <p id={ids.error} className="text-destructive text-sm">
                {passwordError}
              </p>
            )}
            <p id={ids.hint} className="text-muted-foreground text-xs">
              Leave it empty for a statement without a password.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Label className="flex items-center gap-2">
                <Checkbox checked={remember} disabled={locked} onCheckedChange={(checked) => setRemember(checked === true)} />
                {saved !== null ? "Remember this password (replaces the saved one)" : "Remember this password"}
              </Label>
              {saved !== null && (
                <Button type="button" variant="link" size="sm" onClick={() => void forget()}>
                  Forget saved password
                </Button>
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              Kept in Wealthfolio's secret store: the system keyring on desktop, the server's store on the web. It isn't
              synced to other devices, and stays after the add-on is uninstalled until you forget it.
            </p>
          </div>
        )}
        {!notCas && (
          <div>
            <Button type="button" disabled={!canRead} onClick={() => void readStatement()}>
              {reading && <Spinner />}
              Read statement
            </Button>
          </div>
        )}
        {failure?.kind === "not-cas" && (
          <Alert variant="destructive">
            <AlertTitle>We couldn't read this as a CAS from CAMS, KFintech, NSDL or CDSL. Nothing was saved.</AlertTitle>
            <AlertDescription>
              {failure.reason && <p>{failure.reason}</p>}
              <WrapButton id={ids.another} type="button" variant="outline" onClick={chooseAnother}>
                Choose another file
              </WrapButton>
            </AlertDescription>
          </Alert>
        )}
        {(failure?.kind === "runtime" || failure?.kind === "accounts") && (
          <Alert variant="destructive">
            <AlertTitle>
              {failure.kind === "runtime" ? "We couldn't finish reading this PDF. Nothing was saved." : "Couldn't read your Wealthfolio accounts."}
            </AlertTitle>
            <AlertDescription>
              <WrapButton id={ids.retry} type="button" variant="outline" onClick={() => void retry()}>
                Try again
              </WrapButton>
            </AlertDescription>
          </Alert>
        )}
      </fieldset>
      <p id={ids.status} role="status" className={reading ? "text-muted-foreground text-sm" : "sr-only"}>
        {reading ? (failure === null && kept.current ? "Reading your Wealthfolio accounts…" : "Reading the statement…") : sayPassword ? passwordError : ""}
      </p>
    </div>
  );
}
