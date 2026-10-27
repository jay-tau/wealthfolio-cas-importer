import type { AddonContext } from "@wealthfolio/addon-sdk";
import { Alert, AlertDescription, AlertTitle, Button, Checkbox, Input, Label, Spinner } from "@wealthfolio/ui";
import { useEffect, useRef, useState } from "react";
import { CasError, CasParser } from "../cas/parser";
import type { Statement } from "../cas/types";
import { PASSWORD_SECRET } from "../lib/choices";

export function StatementForm({ ctx, onClear, onRead, disabled = false }: {
  ctx: AddonContext;
  onClear: () => void;
  onRead: (data: Statement) => Promise<void>;
  disabled?: boolean;
}) {
  const parser = useRef<CasParser | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadingPassword, setLoadingPassword] = useState(true);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<CasError | null>(null);

  useEffect(() => () => parser.current?.dispose(), []);

  useEffect(() => {
    ctx.api.secrets.get(PASSWORD_SECRET).then(
      (value) => {
        if (value === null) return;
        setPassword((typed) => typed || value);
        setRemember(true);
        setSaved(true);
      },
      () => ctx.api.logger.warn("Couldn't read the saved statement password."),
    ).finally(() => setLoadingPassword(false));
  }, [ctx]);

  // Start Python while the user types the password; it takes a few seconds.
  const startParser = () => {
    if (parser.current) return parser.current;
    try {
      parser.current = new CasParser(ctx.assets);
    } catch (e) {
      setError(new CasError("runtime", `Couldn't start the parser: ${String(e)}`));
    }
    return parser.current;
  };

  const keepPassword = async () => {
    try {
      if (remember) {
        await ctx.api.secrets.set(PASSWORD_SECRET, password);
        setSaved(true);
      } else if (saved) {
        await ctx.api.secrets.delete(PASSWORD_SECRET);
        setSaved(false);
      }
    } catch {
      ctx.api.toast.error("Couldn't update the saved password.");
    }
  };

  const forget = async () => {
    try {
      await ctx.api.secrets.delete(PASSWORD_SECRET);
      setSaved(false);
      setRemember(false);
      setPassword("");
    } catch {
      ctx.api.toast.error("Couldn't forget the saved password.");
    }
  };

  const read = async () => {
    const casParser = startParser();
    if (!file || !casParser) return;
    setReading(true);
    onClear();
    setError(null);
    try {
      const data = await casParser.parse(await file.arrayBuffer(), password);
      await keepPassword();
      await onRead(data);
    } catch (e) {
      setError(e instanceof CasError ? e : new CasError("runtime", String(e)));
    } finally {
      setReading(false);
    }
  };

  const locked = disabled || reading || loadingPassword;
  const canRead = Boolean(file && password) && !locked;

  return (
    <div className="space-y-4">
      {/* Not a <form>: the add-on's sandboxed frame isn't allowed to submit forms. */}
      <fieldset disabled={locked} className="grid max-w-xl gap-4">
        <div className="grid gap-2">
          <Label htmlFor="cas-file">Statement PDF</Label>
          <Input
            id="cas-file"
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => {
              onClear();
              setFile(event.target.files?.[0] ?? null);
              setError(null);
              startParser();
            }}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cas-password">PDF password</Label>
          <Input
            id="cas-password"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canRead) void read();
            }}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Label className="flex items-center gap-2">
              <Checkbox checked={remember} disabled={locked} onCheckedChange={(checked) => setRemember(checked)} />
              Remember the password
            </Label>
            {saved && (
              <Button type="button" variant="link" size="sm" onClick={() => void forget()}>
                Forget the saved password
              </Button>
            )}
          </div>
          <p className="text-muted-foreground text-xs">
            Kept in Wealthfolio's secret store: the system keyring on desktop, the server's store on the web. It isn't
            synced to other devices, and stays after the add-on is uninstalled until you forget it.
          </p>
        </div>
        <div>
          <Button type="button" disabled={!canRead} onClick={() => void read()}>
            {reading && <Spinner />}
            {reading ? "Reading…" : "Read statement"}
          </Button>
        </div>
      </fieldset>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>{error.kind === "password" ? "Wrong password" : "Couldn't read the statement"}</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
