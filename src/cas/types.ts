// casparser 1.4.1's JSON for a CAMS/KFintech statement (`CASData` in casparser/types.py,
// serialised by `read_cas_pdf(..., output="json")`). Decimals stay strings.

export type Decimal = string;

export type TransactionType =
  | "PURCHASE"
  | "PURCHASE_SIP"
  | "REDEMPTION"
  | "DIVIDEND_PAYOUT"
  | "DIVIDEND_REINVEST"
  | "SWITCH_IN"
  | "SWITCH_IN_MERGER"
  | "SWITCH_OUT"
  | "SWITCH_OUT_MERGER"
  | "STT_TAX"
  | "STAMP_DUTY_TAX"
  | "TDS_TAX"
  | "SEGREGATION"
  | "GIFT_IN"
  | "GIFT_OUT"
  | "MISC"
  | "UNKNOWN"
  | "REVERSAL";

export interface CasTransaction {
  date: string;
  description: string;
  amount: Decimal | null;
  units: Decimal | null;
  nav: Decimal | null;
  balance: Decimal | null;
  type: TransactionType;
  dividend_rate: Decimal | null;
  gift_folio: string | null;
}

export interface CasScheme {
  scheme: string;
  advisor: string | null;
  rta_code: string;
  rta: string;
  type: string | null;
  isin: string | null;
  amfi: string | null;
  nominees: string[];
  open: Decimal;
  close: Decimal;
  close_calculated: Decimal;
  valuation: { date: string; nav: Decimal; cost: Decimal | null; value: Decimal };
  transactions: CasTransaction[];
}

export interface CasFolio {
  folio: string;
  amc: string;
  name: string | null;
  PAN: string | null;
  KYC: string | null;
  PANKYC: string | null;
  schemes: CasScheme[];
}

export interface CasData {
  statement_period: { from: string; to: string };
  folios: CasFolio[];
  investor_info: { name: string; email: string; address: string; mobile: string };
  cas_type: "UNKNOWN" | "SUMMARY" | "DETAILED";
  file_type: "UNKNOWN" | "CAMS" | "KFINTECH" | "CDSL" | "NSDL";
  /** casparser's checks, e.g. a unit balance that doesn't match the printed one. */
  parse_warnings: string[];
}
