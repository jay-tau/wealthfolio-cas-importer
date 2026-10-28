"""Write a MADE-UP CDSL Consolidated Account Statement (CAS) PDF.

Usage: python make_cdsl_cas.py out.pdf

Everything in the statement is invented: investor, PANs (ABCDE1234F, the
PDF's user password, and a joint holder's ABCDE5678K; the fourth letter D is
no real PAN holder type), address, CAS ID, depository participants ("Fictiva
Securities", "Testbridge Capital Services"), DP IDs, client IDs, BO ID,
companies, ISINs (well-formed INEZ9... / INFZ9... codes with valid check
digits), folios, UCCs, the masked PRAN, the CRA code, the pension fund
manager, prices, NAVs and values.

The layout follows what casparser 1.4.1's CDSL parser reads (parsers/cdsl.py,
pageobj.py, _investor.py, detect.py). cdsl.py works on Blocks: text-show ops
whose tops are <= 9 pt apart join one block, and inside a block ops that
share a left edge (within 3 pt) and are <= 9 pt apart stack into one cell.
Every line here is its own text-show op; lines meant as separate blocks are
>= 12 pt apart, lines of one wrapped cell 7-8 pt apart.

  * "Central Depository Services (India) Limited" at the top of every page
    (issuer detection reads pages 1-2), "Page N of M" at the bottom.
  * Page 1: "Statement for the period from dd-Mmm-yyyy to dd-Mmm-yyyy" (the
    first "for the period from X to Y" anywhere gives statement_period, kept
    as printed).
  * Page 2, read only from page 2:
      - investor block, left column (x < 200): "CAS ID: ...", name, address
        lines, "PINCODE: ..." (the PINCODE line ends the block and is kept as
        the last address line; without it the rest of the page's left
        column would become address);
      - account roster, one block per row with exactly 4 cells:
        "CDSL|NSDL Demat Account" | "<DP name>" over "DP Id: <dp> Client Id :
        <client>" | ISIN count | value, and "Mutual Fund Folios" | "Folios :
        <n>" | ISIN count | value. The roster alone creates the accounts (in
        roster order) and their balance and folios (= the printed ISIN
        count). The DP name and DP Id lines must stack into one cell: shifted
        10 pt apart they make 5 cells and the whole account disappears;
      - owners: an "Accounts in the single|joint name of" line resets them,
        then each "<NAME> (PAN : <PAN>)" line (its own block, no "Mutual" in
        it) adds one; each roster row takes the owners collected so far.
        An owner line within 9 pt of the heading is lost with it.
  * Page 3 on, up to the first "DP Name : ... BO ID : ..." block: one
    descriptive group per MF folio, each field its own block:
    "Scheme Name : ..." + "Scheme Code : <CODE>", "Folio No : ...",
    "ISIN : ..." + "RTA : ..." + "UCC : ..." (UCC last: casparser reads the
    word after "UCC :", so a blank UCC followed by another cell would return
    that cell's label).
  * One section per demat account:
      - CDSL: "DP Name : <DP> ... BO ID : <dp+client, 16 digits>";
      - NSDL: "NSDL Demat Account" stacked over "DP Name : <DP> ... DP ID :
        IN...  CLIENT ID : ..." (this header form is typed NSDL only when the
        same block says NSDL and not CDSL; with the label 16 pt above, the
        NSDL holdings silently go nowhere and the account keeps only its
        roster balance). "DP Name : <DP> ... DPID : IN<dp><client>" (16
        chars) also works, typed by its IN prefix;
      - "STATEMENT OF TRANSACTIONS ..." switches holdings parsing off, so the
        transaction ledger is skipped;
      - "HOLDING STATEMENT AS ON ..." switches it on; the column header
        (contains "ISIN" and "Security") is skipped; each row is ISIN |
        Security (may wrap) | Current Bal | Frozen Bal | Pledge Bal | Pledge
        Setup Bal | Free Bal | Market Price | Value. num_shares is the first
        number after the name (Current Bal), price/value the last two cells.
        Zero balances print "--". INF ISINs (the ETF) go to mutual_funds.
  * "MUTUAL FUND UNITS HELD AS ON ...": rows go to the Mutual Fund Folios
    account. Row: "<CODE> - <scheme>" (wraps) | ISIN | Folio | ARN code or
    DIRECT | Units | NAV | Invested | Valuation | TER % | Commission |
    Profit/(Loss) | Return %. The code prefix links the row to its
    descriptive group's UCC (the only thing the descriptive groups feed).
    Tried and silently wrong, with no parse_warnings:
      - a loss in brackets: pnl null and return = TER (brackets are not
        numbers), so losses print with a minus sign;
      - blank Invested with TER etc. still printed: invested = valuation,
        value = TER, pnl null (the 3rd number is taken as invested whenever
        there are 4 or more), so a folio with no cost data prints only Units
        / NAV / Valuation;
      - Return % of 0.00: return = TER (zeros are dropped and the last
        remaining number is taken);
      - no ARN/DIRECT cell: pnl and return null even when printed.
  * NPS, last: "NPS-SP : <CRA>" + "PRAN ID : <masked>", a transaction
    statement (skipped, even rows naming "NPS TRUST"), "HOLDING STATEMENT AS
    ON ...", rows of scheme name (starts "NPS TRUST", wraps, carries
    "SCHEME <E|C|G|A>" and "TIER I|II") >= 150 pt left of the fund manager
    column, units and NAV on a line between the two text lines, then
    "Portfolio Value Rs. <total>". casparser recomputes each scheme's value
    as units x NAV and reports the printed total as nps.value. Any later
    "Portfolio Value" line overwrites that total (with NPS before the demat
    sections, nps.value became the NSDL account's value), so NPS comes last.
    The masked PRAN uses X: "PRAN ID : ********9001" gives pran null.

cdsl.py never fills bonds (always []) or avg_cost (always null).

Output is AES-256 (R6) encrypted with user password "ABCDE1234F".
"""

from __future__ import annotations

import io
import sys
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import List, Optional, Tuple

import pikepdf
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

PAN = "ABCDE1234F"
JOINT_PAN = "ABCDE5678K"
OWNER_PASSWORD = "fixture-owner-password"
PERIOD = ("01-Apr-2025", "31-Mar-2026")
AS_ON = "31-03-2026"
TXN_PERIOD = "01-04-2025 TO 31-03-2026"

INVESTOR = {
    "cas_id": "TST0000001",
    "name": "ANANYA R TESTWALA",
    "joint": "RAVI TESTWALA",
    "address": [
        "Flat 7B, Placeholder Residency",
        "12 Sample Street, Demo Nagar",
        "Fakeville, Maharashtra",
    ],
    "pincode": "999999",
}

# ----------------------------------------------------------------- numbers

D = Decimal


def q(d: Decimal, places: int) -> Decimal:
    return d.quantize(D(1).scaleb(-places), rounding=ROUND_HALF_UP)


def inr(d: Decimal, places: int = 2) -> str:
    """Indian digit grouping (1,23,456.78); negatives with a minus sign."""
    d = q(d, places)
    whole, _, frac = f"{abs(d):.{places}f}".partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups + [tail])
    s = f"{whole}.{frac}" if places else whole
    return f"-{s}" if d < 0 else s


def bal(d: Decimal) -> str:
    """Depository balance column: 3 decimals, or "--" for zero."""
    return inr(d, 3) if d else "--"


def isin_check_digit(body: str) -> str:
    """ISO 6166 check digit for an 11-char ISIN body."""
    digits = "".join(str(int(ch, 36)) for ch in body)
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 0:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return str((10 - total % 10) % 10)


def isin(body: str) -> str:
    assert len(body) == 11 and body[:4] in ("INEZ", "INFZ"), body
    return body + isin_check_digit(body)


# ----------------------------------------------------------------- holdings


@dataclass
class Holding:
    isin: str
    name: List[str]  # printed lines of the Security cell
    current: Decimal
    price: Decimal
    frozen: Decimal = D(0)
    pledge: Decimal = D(0)
    pledge_setup: Decimal = D(0)

    @property
    def free(self) -> Decimal:
        return self.current - self.frozen - self.pledge - self.pledge_setup

    @property
    def value(self) -> Decimal:
        return q(self.current * self.price, 2)


@dataclass
class Account:
    kind: str  # "CDSL" | "NSDL"
    dp_name: str
    dp_id: str
    client_id: str
    owners: List[Tuple[str, str]]
    holdings: List[Holding]
    # (index into holdings, [(date, particulars, op bal, credit, debit, cl bal)])
    txns: List[Tuple[int, List[tuple]]]

    @property
    def value(self) -> Decimal:
        return sum((h.value for h in self.holdings), D(0))


@dataclass
class MFFolio:
    code: str
    amc: str
    scheme: str
    isin: str
    folio: str
    arn: str  # "DIRECT" or ARN code
    rta: str
    ucc: str  # "" prints a blank UCC
    units: Decimal
    nav: Decimal
    invested: Optional[Decimal]  # None: no cost data, reduced row
    ter: Decimal = D(0)
    commission: Decimal = D(0)
    ret: Decimal = D(0)

    @property
    def value(self) -> Decimal:
        return q(self.units * self.nav, 2)


@dataclass
class NPSScheme:
    name: List[str]  # printed lines
    units: Decimal
    nav: Decimal

    @property
    def value(self) -> Decimal:
        v = self.units * self.nav
        # casparser rounds half-even, the statement half-up: keep off ties.
        assert v.quantize(D("0.01")) == q(v, 2), v
        return q(v, 2)


OWNER = (INVESTOR["name"], PAN)
JOINT = (INVESTOR["joint"], JOINT_PAN)

CDSL_ACCOUNT = Account(
    kind="CDSL",
    dp_name="FICTIVA SECURITIES LIMITED",
    dp_id="19999901",
    client_id="00012345",
    owners=[OWNER],
    holdings=[
        Holding(isin("INEZ90A0101"), ["FICTIVA INDUSTRIES LIMITED"], D("120.000"), D("1482.35")),
        Holding(
            isin("INEZ91B0101"),
            ["TESTBRIDGE POWER AND", "INFRASTRUCTURE LIMITED"],
            D("450.000"),
            D("312.60"),
            pledge=D("50.000"),
        ),
        # Lapsed rights entitlement: no balance, a price, zero value.
        Holding(
            isin("INEZ91B2001"),
            ["TESTBRIDGE POWER AND", "INFRASTRUCTURE LTD - RE"],
            D(0),
            D("6.29"),
        ),
        Holding(isin("INFZ90K01NF"), ["FICTIVA NIFTY 50 ETF"], D("300.000"), D("268.41")),
    ],
    txns=[
        (
            0,
            [
                ("01-04-2025", "Opening Balance", "100.000", "", "", ""),
                ("12-06-2025", "BY-CM FICTIVA SECURITIES LIMITED / PURCHASE", "", "20.000", "", "120.000"),
                ("31-03-2026", "Closing Balance", "", "", "", "120.000"),
            ],
        ),
        (
            3,
            [
                ("01-04-2025", "Opening Balance", "--", "", "", ""),
                ("05-08-2025", "BY-CM FICTIVA SECURITIES LIMITED / PURCHASE", "", "300.000", "", "300.000"),
                ("31-03-2026", "Closing Balance", "", "", "", "300.000"),
            ],
        ),
    ],
)

NSDL_ACCOUNT = Account(
    kind="NSDL",
    dp_name="TESTBRIDGE CAPITAL SERVICES PRIVATE LIMITED",
    dp_id="IN999901",
    client_id="10012345",
    owners=[OWNER, JOINT],
    holdings=[
        Holding(isin("INEZ93C0101"), ["SAMPLEWORKS TECHNOLOGIES LIMITED"], D("75.000"), D("2145.90")),
        Holding(isin("INEZ94D0101"), ["DEMOCORP FINANCE LIMITED"], D("200.000"), D("88.15")),
    ],
    txns=[],
)

MF_FOLIOS = [
    MFFolio(
        "FFCDG", "Fictiva Mutual Fund", "Fictiva Flexi Cap Fund - Direct Plan - Growth",
        isin("INFZ90K01FC"), "91234567/12", "DIRECT", "CAMS", "UCCZ900001",
        D("2104.518"), D("81.4471"), D("140000.00"), ter=D("0.62"), ret=D("13.84"),
    ),
    MFFolio(
        "TCBRP", "Testbridge Mutual Fund", "Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout",
        isin("INFZ91T01CB"), "1040012345", "ARN-000000", "KFINTECH", "UCCZ900002",
        D("9512.207"), D("10.9105"), D("100000.00"), ter=D("1.08"), commission=D("412.37"), ret=D("6.91"),
    ),
    MFFolio(
        "FMCDG", "Fictiva Mutual Fund", "Fictiva Midcap Fund - Direct Plan - Growth",
        isin("INFZ90K01MC"), "91234567/12", "DIRECT", "CAMS", "UCCZ900003",
        D("640.250"), D("29.8814"), D("21000.00"), ter=D("0.71"), ret=D("-9.12"),
    ),
    # No cost data: only units / NAV / valuation printed; blank UCC.
    MFFolio(
        "TGLDG", "Testbridge Mutual Fund", "Testbridge Gilt Fund - Direct Plan - Growth",
        isin("INFZ91T01GL"), "1040012345", "DIRECT", "KFINTECH", "",
        D("455.120"), D("55.1287"), None,
    ),
]

NPS_SP = "TCRA"
NPS_PRAN = "XXXXXXXX9001"
NPS_FUND_MANAGER = ["FICTIVA PENSION FUND", "MANAGEMENT LIMITED"]
NPS_SCHEMES = [
    NPSScheme(["NPS TRUST- A/C FICTIVA PENSION FUND", "MANAGEMENT LIMITED SCHEME E - TIER I"], D("1234.5678"), D("58.1234")),
    NPSScheme(["NPS TRUST- A/C FICTIVA PENSION FUND", "MANAGEMENT LIMITED SCHEME G - TIER I"], D("2345.6789"), D("29.8765")),
    NPSScheme(["NPS TRUST- A/C FICTIVA PENSION FUND", "MANAGEMENT LIMITED SCHEME E - TIER II"], D("456.7891"), D("41.2345")),
]


def mf_total() -> Decimal:
    return sum((f.value for f in MF_FOLIOS), D(0))


def nps_total() -> Decimal:
    return sum((s.value for s in NPS_SCHEMES), D(0))


# ----------------------------------------------------------------- layout

PAGE_W, PAGE_H = A4
FONT, BOLD = "Helvetica", "Helvetica-Bold"
TOP = 780


class Doc:
    """Collects draw ops per page; rendered once the page count is known."""

    def __init__(self):
        self.pages: List[list] = []
        self.y = 0.0

    def new_page(self):
        self.pages.append([])
        self.y = TOP

    def text(self, x, y, s, font=FONT, size=7.0, max_w=None):
        if max_w is not None and stringWidth(s, font, size) > max_w:
            raise SystemExit(f"text too wide ({stringWidth(s, font, size):.1f} > {max_w}pt): {s!r}")
        self.pages[-1].append(("l", x, y, s, font, size))

    def rtext(self, x, y, s, font=FONT, size=7.0):
        self.pages[-1].append(("r", x, y, s, font, size))

    def ctext(self, y, s, font=FONT, size=7.0):
        self.pages[-1].append(("c", PAGE_W / 2, y, s, font, size))

    def gap(self, step):
        self.y -= step


def cover(L: Doc):
    L.new_page()
    L.ctext(L.y, "CONSOLIDATED ACCOUNT STATEMENT (CAS)", BOLD, 12)
    L.gap(16)
    L.ctext(L.y, f"Statement for the period from {PERIOD[0]} to {PERIOD[1]}", FONT, 9)
    L.gap(30)
    for s in (
        "This statement is a made-up test fixture generated by make_cdsl_cas.py.",
        "It does not describe any real investor, depository participant, account, company, fund or pension scheme.",
        "All names, PANs, IDs, ISINs, prices, NAVs and values are invented for parser testing.",
    ):
        L.text(36, L.y, s)
        L.gap(12)
    L.gap(20)
    L.text(36, L.y, "YOUR CONSOLIDATED PORTFOLIO", BOLD, 8)
    L.gap(14)
    rows = [
        ("CDSL demat account", CDSL_ACCOUNT.value),
        ("NSDL demat account", NSDL_ACCOUNT.value),
        ("Mutual fund folios", mf_total()),
        ("National Pension System (NPS)", nps_total()),
    ]
    rows.append(("Total", sum((v for _, v in rows), D(0))))
    for label, v in rows:
        f = BOLD if label == "Total" else FONT
        L.text(36, L.y, label, f)
        L.rtext(300, L.y, f"Rs. {inr(v)}", f)
        L.gap(12)


def roster(L: Doc):
    L.new_page()
    y = L.y
    lines = [f"CAS ID: {INVESTOR['cas_id']}", INVESTOR["name"], *INVESTOR["address"], f"PINCODE: {INVESTOR['pincode']}"]
    for s in lines:
        L.text(36, y, s, BOLD if s == INVESTOR["name"] else FONT, 8, max_w=160)
        y -= 11
    L.y = y - 30

    X_TYPE, X_DETAIL, R_ISINS, R_VALUE = 36, 150, 440, 545
    L.text(X_TYPE, L.y, "SUMMARY OF YOUR DEMAT ACCOUNTS AND MUTUAL FUND FOLIOS", BOLD, 8)
    L.gap(16)
    L.text(X_TYPE, L.y, "Account Type", BOLD)
    L.text(X_DETAIL, L.y, "Account Details", BOLD)
    L.rtext(R_ISINS, L.y, "No. of ISINs", BOLD)
    L.rtext(R_VALUE, L.y, "Value (Rs.)", BOLD)
    L.gap(16)

    def owners(heading, people):
        L.text(X_TYPE, L.y, heading, BOLD)
        L.gap(13)
        for name, pan in people:
            L.text(X_TYPE, L.y, f"{name} (PAN : {pan})")
            L.gap(13)
        L.gap(2)

    def demat_row(a: Account):
        L.text(X_TYPE, L.y, f"{a.kind} Demat Account")
        L.text(X_DETAIL, L.y, a.dp_name)
        L.text(X_DETAIL, L.y - 8, f"DP Id: {a.dp_id} Client Id : {a.client_id}")
        assert stringWidth(a.dp_name, FONT, 7) != stringWidth(f"DP Id: {a.dp_id} Client Id : {a.client_id}", FONT, 7)
        L.rtext(R_ISINS, L.y, str(len(a.holdings)))
        L.rtext(R_VALUE, L.y, inr(a.value))
        L.gap(8 + 14)

    owners("Accounts in the single name of", CDSL_ACCOUNT.owners)
    demat_row(CDSL_ACCOUNT)
    L.text(X_TYPE, L.y, "Mutual Fund Folios")
    L.text(X_DETAIL, L.y, f"Folios : {len(MF_FOLIOS)}")
    L.rtext(R_ISINS, L.y, str(len({f.isin for f in MF_FOLIOS})))
    L.rtext(R_VALUE, L.y, inr(mf_total()))
    L.gap(16)
    owners("Accounts in the joint name of", NSDL_ACCOUNT.owners)
    demat_row(NSDL_ACCOUNT)
    L.text(X_TYPE, L.y, "Total", BOLD)
    L.rtext(R_VALUE, L.y, inr(CDSL_ACCOUNT.value + NSDL_ACCOUNT.value + mf_total()), BOLD)


def folio_details(L: Doc):
    L.new_page()
    L.text(36, L.y, "MUTUAL FUND FOLIOS", BOLD, 9)
    L.gap(20)
    for f in MF_FOLIOS:
        L.text(36, L.y, f"AMC Name : {f.amc}")
        L.gap(12)
        L.text(36, L.y, f"Scheme Name : {f.scheme}", max_w=330)
        L.text(380, L.y, f"Scheme Code : {f.code}")
        L.gap(12)
        L.text(36, L.y, f"Folio No : {f.folio}")
        L.text(380, L.y, "Mode of Holding : Single")
        L.gap(12)
        L.text(36, L.y, "KYC of Investor : OK")
        L.gap(12)
        L.text(36, L.y, f"ISIN : {f.isin}")
        L.text(200, L.y, f"RTA : {f.rta}")
        L.text(380, L.y, f"UCC : {f.ucc}".rstrip())
        L.gap(22)


# Holdings table columns: left edges for ISIN / Security, right edges after.
H_ISIN, H_SEC = 30, 92
H_NUM = [("Current", "Bal"), ("Frozen", "Bal"), ("Pledge", "Bal"), ("Pledge Setup", "Bal"),
         ("Free", "Bal"), ("Market", "Price"), ("Value", "(Rs.)")]
H_RIGHT = [270, 310, 350, 400, 440, 492, 560]
TSIZE = 6.5


def demat_section(L: Doc, a: Account):
    L.new_page()
    if a.kind == "CDSL":
        L.text(36, L.y, "CDSL Demat Account", BOLD, 8)
        L.gap(16)
        L.text(36, L.y, f"DP Name : {a.dp_name}", BOLD)
        L.text(330, L.y, f"BO ID : {a.dp_id}{a.client_id}", BOLD)
    else:
        L.text(36, L.y, "NSDL Demat Account", BOLD, 8)
        L.gap(8)
        L.text(36, L.y, f"DP Name : {a.dp_name}", BOLD)
        L.text(330, L.y, f"DP ID : {a.dp_id}", BOLD)
        L.text(440, L.y, f"CLIENT ID : {a.client_id}", BOLD)
    L.gap(14)
    L.text(36, L.y, "Account Status : Active")
    L.text(200, L.y, "BSDA : No")
    L.gap(24)

    L.text(36, L.y, f"STATEMENT OF TRANSACTIONS FOR THE PERIOD FROM {TXN_PERIOD}", BOLD, 7.5)
    L.gap(16)
    if not a.txns:
        L.text(36, L.y, "No transactions during the period")
        L.gap(14)
    else:
        X_TDATE, X_TDESC = 36, 90
        T_RIGHT = [330, 390, 450, 520]
        L.text(X_TDATE, L.y, "Date", BOLD, TSIZE)
        L.text(X_TDESC, L.y, "Transaction Particulars", BOLD, TSIZE)
        for r, label in zip(T_RIGHT, ("Op. Bal", "Credit", "Debit", "Cl. Bal")):
            L.rtext(r, L.y, label, BOLD, TSIZE)
        L.gap(14)
        for idx, rows in a.txns:
            h = a.holdings[idx]
            L.text(X_TDATE, L.y, f"ISIN : {h.isin} - {' '.join(h.name)}", BOLD, TSIZE)
            L.gap(12)
            for dt, desc, *nums in rows:
                L.text(X_TDATE, L.y, dt, FONT, TSIZE)
                L.text(X_TDESC, L.y, desc, FONT, TSIZE, max_w=T_RIGHT[0] - 40 - X_TDESC)
                for r, n in zip(T_RIGHT, nums):
                    if n:
                        L.rtext(r, L.y, n, FONT, TSIZE)
                L.gap(12)
            L.gap(4)
    L.gap(12)

    L.text(36, L.y, f"HOLDING STATEMENT AS ON {AS_ON}", BOLD, 7.5)
    L.gap(16)
    L.text(H_ISIN, L.y, "ISIN", BOLD, TSIZE)
    L.text(H_SEC, L.y, "Security", BOLD, TSIZE)
    for r, (top, bottom) in zip(H_RIGHT, H_NUM):
        L.rtext(r, L.y, top, BOLD, TSIZE)
        L.rtext(r, L.y - 7, bottom, BOLD, TSIZE)
    L.gap(7 + 15)
    for h in a.holdings:
        L.text(H_ISIN, L.y, h.isin, FONT, TSIZE)
        for k, line in enumerate(h.name):
            L.text(H_SEC, L.y - 7 * k, line, FONT, TSIZE, max_w=H_RIGHT[0] - 45 - H_SEC)
        cells = [bal(h.current), bal(h.frozen), bal(h.pledge), bal(h.pledge_setup), bal(h.free),
                 inr(h.price), inr(h.value)]
        for r, s in zip(H_RIGHT, cells):
            L.rtext(r, L.y, s, FONT, TSIZE)
        L.gap(7 * (len(h.name) - 1) + 14)
    L.gap(4)
    L.text(H_ISIN, L.y, f"Portfolio Value Rs. {inr(a.value)}", BOLD, 7)


# MF units table columns.
M_NAME, M_ISIN, M_FOLIO, M_ARN = 24, 132, 180, 222
M_NAME_W = M_ISIN - M_NAME - 6
M_RIGHT = [300, 338, 384, 430, 456, 494, 540, 571]
M_HEAD = [
    ("Closing Bal", "(Units)"), ("NAV", "(Rs.)"), ("Invested", "(Rs.)"), ("Valuation", "(Rs.)"),
    ("TER", "(%)"), ("Commis-", "sion (Rs.)"), ("Profit/", "(Loss) (Rs.)"), ("Return", "(%)"),
]
MSIZE = 6.0


def wrap(s: str, font: str, size: float, width: float) -> List[str]:
    lines, cur = [], ""
    for word in s.split(" "):
        cand = f"{cur} {word}" if cur else word
        if cur and stringWidth(cand, font, size) > width:
            lines.append(cur)
            cur = word
        else:
            cur = cand
    lines.append(cur)
    return lines


def mf_units(L: Doc):
    L.new_page()
    L.text(36, L.y, f"MUTUAL FUND UNITS HELD AS ON {AS_ON}", BOLD, 8)
    L.gap(18)
    L.text(M_NAME, L.y, "Scheme Name", BOLD, MSIZE)
    L.text(M_ISIN, L.y, "ISIN", BOLD, MSIZE)
    L.text(M_FOLIO, L.y, "Folio No", BOLD, MSIZE)
    L.text(M_ARN, L.y, "ARN Code", BOLD, MSIZE)
    for r, (top, bottom) in zip(M_RIGHT, M_HEAD):
        L.rtext(r, L.y, top, BOLD, MSIZE)
        L.rtext(r, L.y - 7, bottom, BOLD, MSIZE)
    L.gap(7 + 15)
    for f in MF_FOLIOS:
        name = wrap(f"{f.code} - {f.scheme}", FONT, MSIZE, M_NAME_W)
        for k, line in enumerate(name):
            L.text(M_NAME, L.y - 7 * k, line, FONT, MSIZE)
        L.text(M_ISIN, L.y, f.isin, FONT, MSIZE)
        L.text(M_FOLIO, L.y, f.folio, FONT, MSIZE, max_w=M_ARN - M_FOLIO - 4)
        L.text(M_ARN, L.y, f.arn, FONT, MSIZE, max_w=M_RIGHT[0] - 32 - M_ARN)
        cells = [inr(f.units, 3), inr(f.nav, 4), None, inr(f.value)]
        if f.invested is not None:
            cells[2] = inr(f.invested)
            cells += [inr(f.ter), inr(f.commission), inr(f.value - f.invested), inr(f.ret)]
            assert f.ret != 0, f.code
        for r, s in zip(M_RIGHT, cells):
            if s is not None:
                L.rtext(r, L.y, s, FONT, MSIZE)
        L.gap(7 * (len(name) - 1) + 15)
    L.text(M_NAME, L.y, "Total", BOLD, MSIZE)
    L.rtext(M_RIGHT[3], L.y, inr(mf_total()), BOLD, MSIZE)


def nps(L: Doc):
    L.new_page()
    L.text(36, L.y, "NATIONAL PENSION SYSTEM (NPS)", BOLD, 8)
    L.gap(16)
    L.text(36, L.y, f"NPS-SP : {NPS_SP}", BOLD)
    L.text(200, L.y, f"PRAN ID : {NPS_PRAN}", BOLD)
    L.gap(24)
    L.text(36, L.y, f"STATEMENT OF TRANSACTIONS FOR THE PERIOD FROM {TXN_PERIOD}", BOLD, 7.5)
    L.gap(16)
    X_DATE, X_DESC, R_DRCR, R_AMT = 36, 90, 470, 540
    L.text(X_DATE, L.y, "Date", BOLD, TSIZE)
    L.text(X_DESC, L.y, "Particulars", BOLD, TSIZE)
    L.rtext(R_DRCR, L.y, "Dr/Cr", BOLD, TSIZE)
    L.rtext(R_AMT, L.y, "Amount (Rs.)", BOLD, TSIZE)
    L.gap(14)
    for dt, scheme, amount in (
        ("15-05-2025", NPS_SCHEMES[0], "15,000.00"),
        ("15-05-2025", NPS_SCHEMES[1], "10,000.00"),
    ):
        L.text(X_DATE, L.y, dt, FONT, TSIZE)
        L.text(X_DESC, L.y, " ".join(scheme.name), FONT, TSIZE)
        L.rtext(R_DRCR, L.y, "CR", FONT, TSIZE)
        L.rtext(R_AMT, L.y, amount, FONT, TSIZE)
        L.gap(14)
    L.gap(12)

    L.text(36, L.y, f"HOLDING STATEMENT AS ON {AS_ON}", BOLD, 7.5)
    L.gap(16)
    X_NAME, X_FM, R_UNITS, R_NAV = 36, 230, 470, 540
    L.text(X_NAME, L.y, "Scheme Name", BOLD, TSIZE)
    L.text(X_FM, L.y, "Fund Manager", BOLD, TSIZE)
    L.rtext(R_UNITS, L.y, "Units", BOLD, TSIZE)
    L.rtext(R_NAV, L.y, "NAV (Rs.)", BOLD, TSIZE)
    L.gap(16)
    for s in NPS_SCHEMES:
        for k, (name, fm) in enumerate(zip(s.name, NPS_FUND_MANAGER)):
            L.text(X_NAME, L.y - 8 * k, name, FONT, TSIZE, max_w=X_FM - X_NAME - 10)
            L.text(X_FM, L.y - 8 * k, fm, FONT, TSIZE)
        L.rtext(R_UNITS, L.y - 4, inr(s.units, 4), FONT, TSIZE)
        L.rtext(R_NAV, L.y - 4, inr(s.nav, 4), FONT, TSIZE)
        L.gap(8 + 15)
    L.text(X_NAME, L.y, f"Portfolio Value Rs. {inr(nps_total())} as on {AS_ON}", BOLD, 7)
    L.gap(36)

    L.text(36, L.y, "Notes", BOLD, 7.5)
    L.gap(12)
    for s in (
        "1. Values of demat holdings use the closing market price on the last trading day of the period.",
        "2. Mutual fund valuations use the NAV declared by the fund house for the last day of the period.",
        "3. This is a made-up statement for parser tests; it is not issued by any depository.",
    ):
        L.text(36, L.y, s, FONT, 6.5)
        L.gap(10)


def render(L: Doc) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4, invariant=1)
    c.setTitle("CDSL Consolidated Account Statement (test fixture)")
    c.setAuthor("make_cdsl_cas.py")
    n_pages = len(L.pages)
    for pno, ops in enumerate(L.pages, start=1):
        c.setFont(BOLD, 10)
        c.drawCentredString(PAGE_W / 2, 812, "Central Depository Services (India) Limited")
        for kind, x, y, s, font, size in ops:
            c.setFont(font, size)
            {"l": c.drawString, "r": c.drawRightString, "c": c.drawCentredString}[kind](x, y, s)
        c.setFont(FONT, 6.5)
        c.drawCentredString(PAGE_W / 2, 24, f"Page {pno} of {n_pages}")
        c.showPage()
    c.save()
    return buf.getvalue()


def main(argv: List[str]) -> None:
    if len(argv) != 1:
        raise SystemExit("usage: python make_cdsl_cas.py out.pdf")
    L = Doc()
    cover(L)
    roster(L)
    folio_details(L)
    demat_section(L, CDSL_ACCOUNT)
    demat_section(L, NSDL_ACCOUNT)
    mf_units(L)
    nps(L)
    plain = render(L)
    with pikepdf.open(io.BytesIO(plain)) as pdf:
        pdf.save(
            argv[0],
            encryption=pikepdf.Encryption(owner=OWNER_PASSWORD, user=PAN, R=6, aes=True),
        )
    print("wrote", argv[0])


if __name__ == "__main__":
    main(sys.argv[1:])
