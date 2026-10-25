import type { AddonContext } from "@wealthfolio/addon-sdk";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Page,
  PageContent,
  PageHeader,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui";
import { useEffect, useRef, useState } from "react";
import { CasError, CasParser } from "../cas/parser";
import type { CasData, CasScheme } from "../cas/types";

type Status = { state: "idle" } | { state: "reading" } | { state: "error"; error: CasError } | { state: "done"; data: CasData };

export function StatementPage({ ctx }: { ctx: AddonContext }) {
  const parser = useRef<CasParser | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>({ state: "idle" });

  useEffect(() => () => parser.current?.dispose(), []);

  // Start Python while the user types the password; it takes a few seconds.
  const startParser = () => {
    if (parser.current) return parser.current;
    try {
      parser.current = new CasParser(ctx.assets);
    } catch (error) {
      setStatus({ state: "error", error: new CasError("runtime", `Couldn't start the parser: ${String(error)}`) });
    }
    return parser.current;
  };

  const read = async () => {
    const casParser = startParser();
    if (!file || !casParser) return;
    setStatus({ state: "reading" });
    try {
      setStatus({ state: "done", data: await casParser.parse(await file.arrayBuffer(), password) });
    } catch (error) {
      setStatus({
        state: "error",
        error: error instanceof CasError ? error : new CasError("runtime", String(error)),
      });
    }
  };

  const reading = status.state === "reading";
  const canRead = Boolean(file && password) && !reading;

  return (
    <Page>
      <PageHeader
        heading="CAS Importer"
        text="Read a detailed CAMS or KFintech statement (CAS PDF) on this device. Nothing is imported yet."
      />
      <PageContent>
        <div className="space-y-6">
          {/* Not a <form>: the add-on's sandboxed frame isn't allowed to submit forms. */}
          <div className="grid max-w-xl gap-4">
            <div className="grid gap-2">
              <Label htmlFor="cas-file">Statement PDF</Label>
              <Input
                id="cas-file"
                type="file"
                accept="application/pdf,.pdf"
                disabled={reading}
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setStatus({ state: "idle" });
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
                disabled={reading}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canRead) void read();
                }}
              />
            </div>
            <div>
              <Button type="button" disabled={!canRead} onClick={() => void read()}>
                {reading && <Spinner />}
                {reading ? "Reading…" : "Read statement"}
              </Button>
            </div>
          </div>

          {status.state === "error" && (
            <Alert variant="destructive">
              <AlertTitle>{status.error.kind === "password" ? "Wrong password" : "Couldn't read the statement"}</AlertTitle>
              <AlertDescription>{status.error.message}</AlertDescription>
            </Alert>
          )}

          {status.state === "done" && <Statement data={status.data} />}
        </div>
      </PageContent>
    </Page>
  );
}

function Statement({ data }: { data: CasData }) {
  const schemes = data.folios.flatMap((folio) => folio.schemes);
  const rows = schemes.reduce((count, scheme) => count + scheme.transactions.length, 0);
  return (
    <div className="space-y-6">
      <p className="text-muted-foreground">
        {data.file_type} detailed statement for {data.investor_info.name}, {data.statement_period.from} to{" "}
        {data.statement_period.to}: {data.folios.length} folios, {schemes.length} funds, {rows} rows.
      </p>
      {data.parse_warnings.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>casparser found rows that don't add up</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {data.parse_warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {data.folios.map((folio) => (
        <Card key={`${folio.amc} ${folio.folio}`}>
          <CardHeader>
            <CardTitle>
              {folio.amc}, folio {folio.folio}
            </CardTitle>
            {folio.PAN && <p className="text-muted-foreground text-sm">PAN {folio.PAN}</p>}
          </CardHeader>
          <CardContent className="space-y-6">
            {folio.schemes.map((scheme) => (
              <Scheme key={`${scheme.rta_code} ${scheme.scheme}`} scheme={scheme} />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Scheme({ scheme }: { scheme: CasScheme }) {
  return (
    <section className="space-y-2">
      <h3 className="font-medium">{scheme.scheme}</h3>
      <p className="text-muted-foreground text-sm">
        {scheme.isin ? `ISIN ${scheme.isin}` : "No ISIN printed"} · {scheme.rta} · units {scheme.open} → {scheme.close}{" "}
        · value ₹{scheme.valuation.value} on {scheme.valuation.date}
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Units</TableHead>
            <TableHead className="text-right">NAV</TableHead>
            <TableHead className="text-right">Balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {scheme.transactions.map((row, i) => (
            <TableRow key={i}>
              <TableCell className="whitespace-nowrap">{row.date}</TableCell>
              <TableCell>{row.description}</TableCell>
              <TableCell>
                <Badge variant="secondary">{row.type}</Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">{row.amount}</TableCell>
              <TableCell className="text-right tabular-nums">{row.units}</TableCell>
              <TableCell className="text-right tabular-nums">{row.nav}</TableCell>
              <TableCell className="text-right tabular-nums">{row.balance}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
