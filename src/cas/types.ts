// casparser 1.4.1's JSON for a CAMS/KFintech statement (`CASData` in casparser/types.py) and
// for an NSDL/CDSL one (`NSDLCASData`), serialised by `read_cas_pdf(..., output="json")`.
// Decimals stay strings.

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


export interface DematOwner {
  name: string;
  PAN: string;
}

export interface DematEquity {
  name: string | null;
  isin: string;
  num_shares: Decimal;
  price: Decimal;
  value: Decimal;
  /** Filled in from casparser-isin's database, which the add-on doesn't ship. */
  symbol: string | null;
  exchange: string | null;
}

export interface DematFund {
  name: string | null;
  isin: string;
  amfi: string | null;
  type: string | null;
  balance: Decimal;
  nav: Decimal;
  value: Decimal;
  avg_cost: Decimal | null;
  total_cost: Decimal | null;
  ucc: string | null;
  /** Set for units held in a folio, outside demat. */
  folio: string | null;
  pnl: Decimal | null;
  return: Decimal | null;
}

export interface DematBond {
  name: string | null;
  isin: string;
  num_bonds: Decimal;
  value: Decimal;
  face_value: Decimal | null;
  coupon_rate: Decimal | null;
  coupon_frequency: string | null;
  maturity_date: string | null;
  market_price: Decimal | null;
}

export interface DematAccount {
  name: string;
  /** "NSDL Demat Account", "CDSL Demat Account", or "Mutual Fund Folios" for units held outside demat. */
  type: string;
  dp_id: string | null;
  client_id: string | null;
  folios: number;
  balance: Decimal;
  owners: DematOwner[];
  equities: DematEquity[];
  mutual_funds: DematFund[];
  bonds: DematBond[];
}

export interface NpsAccount {
  pran: string | null;
  nps_sp: string | null;
  value: Decimal;
  schemes: {
    scheme: string;
    fund_manager: string | null;
    tier: string | null;
    asset_class: string | null;
    units: Decimal;
    nav: Decimal;
    value: Decimal;
  }[];
}

export interface DepositoryData {
  accounts: DematAccount[];
  statement_period: { from: string; to: string };
  investor_info: { name: string; email: string; address: string; mobile: string };
  file_type: "NSDL" | "CDSL";
  nps: NpsAccount | null;
  parse_warnings: string[];
}

export type Statement = CasData | DepositoryData;

export const isDepository = (statement: Statement): statement is DepositoryData => "accounts" in statement;
