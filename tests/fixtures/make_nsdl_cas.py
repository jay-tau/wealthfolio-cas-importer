"""Write a MADE-UP NSDL Consolidated Account Statement (CAS) PDF.

Usage: python make_nsdl_cas.py out.pdf

Everything in the statement is invented: investor, PAN (ABCDE1234F, the
PDF's user password), NSDL ID, address, brokers, DP IDs and client IDs,
companies, bonds, funds, ISINs (well-formed INEZ9... / INFZ9... codes with
valid check digits), prices and amounts. The "Mutual Fund Folios" rows are
the folios of make_cas.py's CAMS statement as they stand at its close on
31-Mar-2025 (same ISINs, units, NAVs and costs), so the two fixtures
describe one investor.

The statement holds:

  * an NSDL demat account in summary form: 3 equities, 1 mutual fund,
    2 bonds (face value, coupon, frequency, maturity);
  * a CDSL demat account in detailed form (balance breakdown columns):
    3 equities (one partly pledged, one also held in the NSDL account),
    2 mutual funds, 2 bonds (market price only);
  * the "Mutual Fund Folios" pseudo-account: 4 schemes in 2 folios held
    with the RTAs, 3 with average/total cost, profit and annualised return,
    1 printing "--" for those;
  * a transactions section for the NSDL account, which casparser skips.

The layout follows what casparser 1.4.1's NSDL parser reads
(parsers/nsdl.py, pageobj.py, _investor.py, detect.py):

  * Detection: "NSDL Consolidated Account Statement" on page 1 or 2.
  * Period: the first "Statement for the period from dd-Mmm-yyyy to
    dd-Mmm-yyyy" anywhere; kept as the printed strings.
  * Text is grouped into blocks: lines whose tops are <= 9 pt apart form one
    block, and within a block, lines sharing a left edge (within 3 pt) stack
    into one cell. So a table row's wrapped lines must be <= 9 pt apart,
    rows and every other element > 9 pt apart (here 7 pt and >= 12 pt).
    Right of x = 100, stacked lines only join when their centres differ by
    > 1 pt (left-aligned text of different widths does).
  * Page 2, left column (x < 200), top-down: "NSDL ID: ..." marker, name,
    address lines, "PINCODE: ..." (kept as the last address line). Nothing
    else may sit in that column between the marker and PINCODE.
  * Page 2 account roster (the only source of accounts): an "In the single
    name of" block, then a SEPARATE block "<NAME> (PAN:<PAN>)" (the owners of
    every roster row below it), then one block per account:
      - "NSDL|CDSL Demat Account" | "<BROKER>" over "DP ID:<id> Client
        ID:<digits>" | <No. of ISINs> | <value>   (4 cells);
      - "Mutual Fund Folios" | "<n> Folios" | <No. of schemes> | <value>
        (exactly 4 cells).
    The last cell becomes `balance`; `folios` is the No. of ISINs for a
    demat row but <n> for the folios row.
  * Pages 3+: an account header block holding "<NSDL|CDSL> Demat Account"
    and "DP ID:<id> Client ID:<digits>" (3 to 8 cells) selects the roster
    account with that DP ID and client ID. A one-cell section marker
    ("Equities (E)", "Mutual Funds (M)", "Corporate Bonds (C)") and the
    column header row that follows pick the table type:
      - "Stock Symbol" + "Company Name": summary equities, ISIN (symbol
        under it) | name | face value | shares | price | value;
      - "ISIN Description" + "NAV": summary funds, ISIN | name | units |
        NAV | value;
      - "Coupon" + "Maturity": summary bonds, read by x position: ISIN
        15-80, name 80-175, coupon rate (number) and frequency (text) both
        175-240, maturity 240-310, number of bonds 310-390, face value
        390-510, value 510-600;
      - "Current Bal" + "Market Price": detailed table for equities, funds
        or bonds (by the marker before it); the ISIN must be alone in its
        cell (no symbol line), then name, current balance (the quantity),
        the other balances, market price, value.
    "Sub Total" rows are skipped.
  * A block containing "Mutual Fund Folios (F)" switches to the folios
    account; its header row needs "Folio No" + "Average" or "Total Cost".
    Rows: ISIN over UCC (or "NOT AVAILABLE") | scheme name | folio
    (digits or digits/digits) | units | average cost | total cost | NAV |
    value | profit | annualised return %. Columns are found by arithmetic
    (units x NAV = value, value - total cost = profit), not x position;
    negatives need a leading minus (parentheses are not numbers).
  * Rows in any table need an ISIN as their first cell. The transactions
    section repeats the account header, which clears the table type, and
    its column header matches none of the above, so nothing in it is read.
    Without that header, the last holdings table stays active: a sub-heading
    whose first cell is a lone ISIN then becomes a holding with quantity and
    value 0 (tried: a zero bond), so the sub-heading here is one string.
  * A marker casparser lists as unsupported ("Preference Shares (P)",
    "National Pension System (N)", ...) only clears the table type. If the
    section then prints the detailed "Current Bal" header, its rows land in
    equities (tried: a preference share did), so the fixture has none.
    nsdl.py never fills `nps`; only the CDSL parser reads NPS holdings.

Every value is units x price with Decimal arithmetic, and each roster
balance is the sum of its account's values.

Output is AES-256 (R6) encrypted with user password "ABCDE1234F".
"""

from __future__ import annotations

import io
import sys
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import List, Optional

import pikepdf
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

PAN = "ABCDE1234F"
OWNER_PASSWORD = "fixture-owner-password"
PERIOD_FROM, PERIOD_TO = "01-Mar-2025", "31-Mar-2025"

INVESTOR = {
    "nsdl_id": "9999000012",
    "name": "ANANYA R TESTWALA",
    "address": [
        "FLAT 7B, PLACEHOLDER RESIDENCY",
        "12 SAMPLE STREET, DEMO NAGAR",
        "FAKEVILLE",
        "MAHARASHTRA",
    ],
    "pincode": "999999",
}

# ----------------------------------------------------------------- numbers

D = Decimal


def q(d: Decimal, places: int) -> Decimal:
    return d.quantize(D(1).scaleb(-places), rounding=ROUND_HALF_UP)


def inr(d: Decimal, places: int = 2) -> str:
    """Indian digit grouping (1,23,456.78); negatives with a leading minus."""
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
    assert len(body) == 11 and body[:3] in ("INE", "INF"), body
    return body + isin_check_digit(body)


# ----------------------------------------------------------------- holdings


@dataclass
class Equity:
    isin: str
    symbol: str
    name: str
    face_value: Decimal
    shares: Decimal
    price: Decimal
    pledged: Decimal = D(0)  # detailed form only

    @property
    def value(self) -> Decimal:
        return q(self.shares * self.price, 2)


@dataclass
class DematFund:
    isin: str
    name: str
    units: Decimal
    nav: Decimal

    @property
    def value(self) -> Decimal:
        return q(self.units * self.nav, 2)


@dataclass
class Bond:
    isin: str
    name: str
    count: Decimal
    price: Decimal  # face value (summary form) or market price (detailed form)
    coupon: Optional[Decimal] = None
    frequency: Optional[str] = None
    maturity: Optional[str] = None

    @property
    def value(self) -> Decimal:
        return q(self.count * self.price, 2)


@dataclass
class FolioFund:
    isin: str
    ucc: str
    name: str
    folio: str
    units: Decimal
    nav: Decimal
    cost: Optional[Decimal]
    annual_return: Optional[Decimal]

    @property
    def value(self) -> Decimal:
        return q(self.units * self.nav, 2)


@dataclass
class Account:
    depository: str  # "NSDL" (summary tables) or "CDSL" (detailed tables)
    broker: str
    dp_id: str
    client_id: str
    equities: List[Equity]
    funds: List[DematFund]
    bonds: List[Bond]

    @property
    def title(self) -> str:
        return f"{self.depository} Demat Account"

    @property
    def dp_line(self) -> str:
        return f"DP ID:{self.dp_id} Client ID:{self.client_id}"

    @property
    def count(self) -> int:
        return len(self.equities) + len(self.funds) + len(self.bonds)

    @property
    def value(self) -> Decimal:
        return sum((h.value for h in [*self.equities, *self.funds, *self.bonds]), D(0))


def build_portfolio():
    sampleworks = dict(
        isin=isin("INEZ90B0101"), symbol="SMPLWORKS", name="SAMPLEWORKS TECHNOLOGIES LIMITED",
        face_value=D("1.00"), price=D("312.85"),
    )
    nsdl = Account(
        "NSDL", "FICTIVA SECURITIES PRIVATE LIMITED", "IN999901", "90000001",
        equities=[
            Equity(isin("INEZ90A0101"), "FICTPOWER", "FICTIVA POWER AND LIGHT LIMITED",
                   D("10.00"), D(150), D("1234.50")),
            Equity(shares=D(420), **sampleworks),
            Equity(isin("INEZ90C0102"), "DEMOBANK", "DEMOCORP BANK LIMITED",
                   D("2.00"), D(75), D("1689.40")),
        ],
        funds=[DematFund(isin("INFZ90K01NE"), "FICTIVA NIFTY 50 ETF", D("1200.000"), D("248.6512"))],
        bonds=[
            Bond(isin("INEZ91A0701"), "FICTIVA FINANCE LIMITED SR I 8.10 NCD 15AP31",
                 D(50), D("1000.00"), D("8.10"), "Once a year", "15-Apr-2031"),
            Bond(isin("INEZ91B0702"), "SAMPLE HOUSING FINANCE LIMITED 7.95 NCD 20JN28",
                 D(2), D("100000.00"), D("7.95"), "On Maturity", "20-Jun-2028"),
        ],
    )
    cdsl = Account(
        "CDSL", "TESTBRIDGE BROKING LIMITED", "99990001", "90000002",
        equities=[
            Equity(isin("INEZ92A0101"), "MOCKSTEEL", "MOCKSTEEL INDUSTRIES LIMITED",
                   D("5.00"), D(200), D("845.20"), pledged=D(50)),
            Equity(isin("INEZ92B0101"), "PLCPHARMA", "PLACEHOLDER PHARMA LIMITED",
                   D("10.00"), D(60), D("2104.75")),
            Equity(shares=D(100), **sampleworks),
        ],
        funds=[
            DematFund(isin("INFZ91T01NF"), "TESTBRIDGE NIFTY 50 INDEX FUND - DIRECT PLAN - GROWTH",
                      D("1523.456"), D("18.7421")),
            DematFund(isin("INFZ91T01GE"), "TESTBRIDGE GOLD ETF", D("300.000"), D("74.1500")),
        ],
        bonds=[
            Bond(isin("INEZ92A0703"), "MOCKSTEEL INDUSTRIES LIMITED 9.25 NCD 01MR27",
                 D(25), D("1012.40")),
            Bond(isin("INEZ93A0801"), "DEMOCORP INFRA BONDS LIMITED 7.60 BD 30SP33",
                 D(5), D("101250.00")),
        ],
    )
    # make_cas.py's folios at 31-Mar-2025 (closing units, NAV and cost).
    folios = [
        FolioFund(isin("INFZ90K01FC"), "FFCDG", "Fictiva Flexi Cap Fund - Direct Plan - Growth",
                  "91234567/12", D("2892.104"), D("74.3120"), D("154554.00"), D("17.84")),
        FolioFund(isin("INFZ90K01LQ"), "FLQDG", "Fictiva Liquid Fund - Direct Plan - Growth",
                  "91234567/12", D("8.053"), D("2911.4521"), D("21337.21"), D("7.12")),
        FolioFund(isin("INFZ90K01BA"), "NOT AVAILABLE",
                  "Fictiva Balanced Advantage Fund - Direct Plan - IDCW Reinvestment",
                  "91234567/12", D("3540.293"), D("18.0410"), D("54276.36"), D("11.05")),
        FolioFund(isin("INFZ91T01CB"), "TCBRP",
                  "Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout",
                  "1040012345", D("9511.738"), D("10.7432"), None, None),
    ]
    return [nsdl, cdsl], folios


# ----------------------------------------------------------------- layout

PAGE_W, PAGE_H = A4
FONT, BOLD = "Helvetica", "Helvetica-Bold"
SIZE, HSIZE = 6, 5.5  # table text, column labels
WRAP, HWRAP = 7, 6.5  # line step inside a row / a label (<= 9: same block)
GAP = 12  # row-to-row step (> 9: new block)
BOTTOM = 50
X0 = 20


def wrap(text: str, width: float, font=FONT, size=SIZE) -> List[str]:
    lines, cur = [], ""
    for word in text.split():
        trial = f"{cur} {word}".strip()
        if cur and stringWidth(trial, font, size) > width:
            lines.append(cur)
            cur = word
        else:
            cur = trial
    return lines + [cur]


class Layout:
    """Collects draw ops per page; rendered once the page count is known."""

    def __init__(self):
        self.pages: List[list] = []
        self.y = 0.0

    def new_page(self):
        self.pages.append([])
        self.y = PAGE_H - 40

    def text(self, x, y, s, font=FONT, size=SIZE):
        self.pages[-1].append(("l", x, y, s, font, size))

    def rtext(self, x, y, s, font=FONT, size=SIZE):
        self.pages[-1].append(("r", x, y, s, font, size))

    def need(self, height):
        if self.y - height < BOTTOM:
            self.new_page()

    def labels(self, cols):
        """Column-label row: [(x, [line, ...]), ...], left-aligned stacks."""
        depth = max(len(lines) for _, lines in cols)
        self.need(depth * HWRAP + GAP)
        for x, lines in cols:
            for k, s in enumerate(lines):
                self.text(x, self.y - k * HWRAP, s, BOLD, HSIZE)
        self.y -= (depth - 1) * HWRAP + GAP

    def row(self, left, right, *, font=FONT):
        """Table row. left: [(x, width, text or [lines])], text wrapped to
        width (0 = no wrap); right: [(x_right, text)] on the first line."""
        wrapped = [(x, s if isinstance(s, list) else wrap(s, w, font) if w else [s]) for x, w, s in left]
        depth = max(len(lines) for _, lines in wrapped)
        self.need(depth * WRAP + GAP)
        for x, lines in wrapped:
            for k, s in enumerate(lines):
                self.text(x, self.y - k * WRAP, s, font)
        for x, s in right:
            self.rtext(x, self.y, s, font)
        self.y -= (depth - 1) * WRAP + GAP

    def heading(self, s, size=8, gap=16):
        self.need(gap + GAP)
        self.text(X0, self.y, s, BOLD, size)
        self.y -= gap


def bond_band_check(x_right: float, s: str, lo: float, hi: float):
    """Summary-form bond cells are assigned to columns by their left edge."""
    x_left = x_right - stringWidth(s, FONT, SIZE)
    if not lo <= x_left < hi:
        raise SystemExit(f"bond cell {s!r} starts at {x_left:.1f}, outside {lo}-{hi}")


def account_header(L: Layout, ac: Account):
    L.need(40)
    y = L.y
    L.text(X0, y, ac.title, BOLD, 7)
    L.text(150, y, ac.broker, BOLD, 7)
    L.text(150, y - 8, ac.dp_line, FONT, 7)
    L.text(390, y, "ACCOUNT HOLDER", BOLD, 7)
    L.text(390, y - 8, f"{INVESTOR['name']} (PAN:{PAN})", FONT, 7)
    L.y -= 8 + 20


def sub_total(L: Layout, x_right: float, value: Decimal):
    L.row([(X0, 0, "Sub Total")], [(x_right, inr(value))], font=BOLD)
    L.y -= 4


def nsdl_account(L: Layout, ac: Account):
    """Summary-form tables (as on an NSDL demat account's page)."""
    account_header(L, ac)
    L.heading("Equities (E)", 7)
    L.labels([(X0, ["ISIN", "Stock Symbol"]), (90, ["Company Name"]), (300, ["Face Value", "(INR)"]),
              (370, ["No. of", "Shares"]), (440, ["Market Price", "(INR)"]), (545, ["Value", "(INR)"])])
    for e in ac.equities:
        L.row([(X0, 0, [e.isin, f"{e.symbol}.NSE"]), (90, 170, e.name)],
              [(330, inr(e.face_value)), (395, inr(e.shares, 0)), (470, inr(e.price)), (570, inr(e.value))])
    sub_total(L, 570, sum((e.value for e in ac.equities), D(0)))

    L.heading("Mutual Funds (M)", 7)
    L.labels([(X0, ["ISIN"]), (90, ["ISIN Description"]), (370, ["No. of", "Units"]),
              (440, ["NAV", "(INR)"]), (545, ["Value", "(INR)"])])
    for f in ac.funds:
        L.row([(X0, 0, f.isin), (90, 200, f.name)],
              [(395, inr(f.units, 3)), (470, inr(f.nav, 4)), (570, inr(f.value))])
    sub_total(L, 570, sum((f.value for f in ac.funds), D(0)))

    L.heading("Corporate Bonds (C)", 7)
    L.labels([(X0, ["ISIN"]), (84, ["Company Name"]), (178, ["Coupon", "Rate (%)"]),
              (203, ["Frequency"]), (248, ["Maturity", "Date"]), (345, ["No. of", "Bonds"]),
              (440, ["Face Value", "per Bond (INR)"]), (540, ["Value", "(INR)"])])
    for b in ac.bonds:
        right = [(380, inr(b.count, 0)), (480, inr(b.price)), (570, inr(b.value))]
        for (x, s), (lo, hi) in zip(right, [(310, 390), (390, 510), (510, 600)]):
            bond_band_check(x, s, lo, hi)
        L.row([(X0, 0, b.isin), (84, 88, b.name), (178, 0, f"{b.coupon}"), (203, 0, b.frequency),
               (248, 0, b.maturity)], right)
    sub_total(L, 570, sum((b.value for b in ac.bonds), D(0)))


# Detailed (CDSL-style) table: 9 balance columns, then market price and value.
BAL_LABELS = [["Current", "Bal."], ["Free", "Bal."], ["Lent", "Bal."], ["Pledge", "Setup", "Bal."],
              ["Locked", "In Bal."], ["Safe-", "keep Bal."], ["Ear-", "marked", "Bal."],
              ["Pledged", "Bal."], ["Pledgee", "Bal."]]
BAL_RIGHT = [190 + 32 * i for i in range(9)]  # right edges 190 .. 446
X_MPRICE, X_VALUE = 505, 570


def detailed_table(L: Layout, marker: str, rows):
    """rows: [(isin, name, current balance, pledged, price, price decimals, value)]."""
    L.heading(marker, 7)
    L.labels([(X0, ["ISIN"]), (74, ["Security"])]
             + [(r - 28, lab) for r, lab in zip(BAL_RIGHT, BAL_LABELS)]
             + [(X_MPRICE - 42, ["Market Price /", "Face Value (INR)"]), (X_VALUE - 30, ["Value", "(INR)"])])
    total = D(0)
    for code, name, current, pledged, price, places, value in rows:
        bals = [current, current - pledged, D(0), D(0), D(0), D(0), D(0), pledged, D(0)]
        L.row([(X0, 0, code), (74, 84, name)],
              [(x, inr(v, 3)) for x, v in zip(BAL_RIGHT, bals)]
              + [(X_MPRICE, inr(price, places)), (X_VALUE, inr(value))])
        total += value
    sub_total(L, X_VALUE, total)


def cdsl_account(L: Layout, ac: Account):
    account_header(L, ac)
    detailed_table(L, "Equities (E)",
                   [(e.isin, e.name, e.shares, e.pledged, e.price, 2, e.value) for e in ac.equities])
    detailed_table(L, "Mutual Funds (M)",
                   [(f.isin, f.name, f.units, D(0), f.nav, 4, f.value) for f in ac.funds])
    detailed_table(L, "Corporate Bonds (C)",
                   [(b.isin, b.name, b.count, D(0), b.price, 2, b.value) for b in ac.bonds])


def folio_section(L: Layout, folios: List[FolioFund]):
    L.need(120)
    L.heading("Mutual Fund Folios (F)", 8, 18)
    L.labels([(X0, ["ISIN", "UCC"]), (80, ["ISIN Description"]), (160, ["Folio No."]),
              (215, ["No. of", "Units"]), (272, ["Average Cost", "Per Unit (INR)"]),
              (335, ["Total Cost", "(INR)"]), (390, ["Current NAV", "per Unit (INR)"]),
              (450, ["Current Value", "(INR)"]), (500, ["Unrealised", "Profit/(Loss)", "(INR)"]),
              (545, ["Annualised", "Return (%)"])])
    for f in folios:
        if f.cost is None:
            cost = ["--", "--", "--", "--"]
        else:
            cost = [inr(f.cost / f.units, 4), inr(f.cost), inr(f.value - f.cost), inr(f.annual_return)]
        L.row([(X0, 0, [f.isin, f.ucc]), (80, 75, f.name), (160, 0, f.folio)],
              [(240, inr(f.units, 3)), (305, cost[0]), (365, cost[1]), (420, inr(f.nav, 4)),
               (480, inr(f.value)), (535, cost[2]), (575, cost[3])])
    sub_total(L, 480, sum((f.value for f in folios), D(0)))


def transactions(L: Layout, ac: Account):
    """A small transaction ledger; casparser reads holdings only and skips it."""
    e = ac.equities[0]
    L.need(110)
    L.heading("Transactions during the statement period", 8, 18)
    account_header(L, ac)
    L.labels([(X0, ["Date"]), (70, ["Order No. /", "Trade No."]), (150, ["Transaction Particulars"]),
              (340, ["Opening", "Balance"]), (395, ["Credit"]), (445, ["Debit"]),
              (490, ["Closing", "Balance"]), (540, ["Stamp Duty", "(INR)"])])
    # One string, not an ISIN cell: see the module docstring.
    L.row([(X0, 0, f"ISIN : {e.isin} - {e.name}")], [], font=BOLD)
    bought, buy_price = D(50), D("1218.30")
    stamp = bought * buy_price * D("0.00015")  # 0.015 % stamp duty on a delivery buy
    L.row([(X0, 0, PERIOD_FROM), (150, 0, "Opening Balance")], [(370, inr(e.shares - bought, 0))])
    L.row([(X0, 0, "12-Mar-2025"), (70, 0, "1000000000000123"),
           (150, 180, "By Market Purchase - Settlement No 2025050 / CM")],
          [(420, inr(bought, 0)), (515, inr(e.shares, 0)), (575, inr(stamp))])
    L.row([(X0, 0, PERIOD_TO), (150, 0, "Closing Balance")], [(515, inr(e.shares, 0))])


def lay_out(accounts: List[Account], folios: List[FolioFund]) -> Layout:
    L = Layout()
    L.new_page()  # page 1: cover (drawn in render)
    L.new_page()  # page 2: investor + account roster (drawn in render)
    L.new_page()
    L.heading(f"Holdings as on {PERIOD_TO}", 9, 22)
    for ac in accounts:
        (nsdl_account if ac.depository == "NSDL" else cdsl_account)(L, ac)
        L.y -= 10
    folio_section(L, folios)
    L.y -= 10
    transactions(L, accounts[0])
    return L


def cover_page(c):
    c.setFont(BOLD, 14)
    c.drawCentredString(PAGE_W / 2, 780, "NSDL Consolidated Account Statement")
    c.setFont(FONT, 9)
    c.drawCentredString(PAGE_W / 2, 762, f"Statement for the period from {PERIOD_FROM} to {PERIOD_TO}")
    c.setFont(FONT, 7.5)
    y = 720
    for s in [
        "This statement is a made-up test fixture generated by make_nsdl_cas.py.",
        "It does not describe any real investor, account, depository participant, company, bond or fund.",
        "All names, ISINs, DP IDs, client IDs, prices and amounts are invented for parser testing.",
    ]:
        c.drawCentredString(PAGE_W / 2, y, s)
        y -= 11


def roster_page(c, accounts: List[Account], folios: List[FolioFund]):
    # Investor block, left column (x < 200): marker, name, address, PINCODE.
    y = 800
    lines = [f"NSDL ID: {INVESTOR['nsdl_id']}", INVESTOR["name"], *INVESTOR["address"],
             f"PINCODE: {INVESTOR['pincode']}"]
    for s in lines:
        c.setFont(BOLD if s == INVESTOR["name"] else FONT, 8)
        c.drawString(36, y, s)
        y -= 10
    # Right column (x >= 200, ignored by the investor extractor).
    c.setFont(BOLD, 10)
    c.drawString(330, 800, "Consolidated Account Statement")
    c.setFont(FONT, 7.5)
    c.drawString(330, 788, f"{PERIOD_FROM} to {PERIOD_TO}")

    y = 700
    c.setFont(BOLD, 9)
    c.drawString(36, y, "YOUR DEMAT ACCOUNTS AND MUTUAL FUND FOLIOS")
    c.setFont(FONT, 7.5)
    c.drawString(36, y - 16, "In the single name of")
    c.setFont(BOLD, 7.5)
    c.drawString(36, y - 30, f"{INVESTOR['name']} (PAN:{PAN})")
    y -= 50
    c.setFont(BOLD, 7)
    c.drawString(36, y, "Account Type")
    c.drawString(150, y, "Account Details")
    c.drawRightString(450, y, "No. of ISINs / Schemes")
    c.drawRightString(555, y, "Value (INR)")
    y -= 18
    for ac in accounts:
        c.setFont(FONT, 7)
        c.drawString(36, y, ac.title)
        c.drawString(150, y, ac.broker)
        c.drawString(150, y - 8, ac.dp_line)
        c.drawRightString(450, y, str(ac.count))
        c.drawRightString(555, y, inr(ac.value))
        y -= 8 + 14
    n_folios = len({f.folio for f in folios})
    folio_value = sum((f.value for f in folios), D(0))
    c.drawString(36, y, "Mutual Fund Folios")
    c.drawString(150, y, f"{n_folios} Folios")
    c.drawRightString(450, y, str(len(folios)))
    c.drawRightString(555, y, inr(folio_value))
    y -= 16
    c.setFont(BOLD, 7)
    c.drawString(36, y, "Total")
    c.drawRightString(555, y, inr(sum((ac.value for ac in accounts), folio_value)))


def render(accounts: List[Account], folios: List[FolioFund], L: Layout) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4, invariant=1)
    c.setTitle("NSDL Consolidated Account Statement (test fixture)")
    c.setAuthor("make_nsdl_cas.py")
    n_pages = len(L.pages)
    for pno, ops in enumerate(L.pages, start=1):
        if pno == 1:
            cover_page(c)
        elif pno == 2:
            roster_page(c, accounts, folios)
        for kind, x, y, s, font, size in ops:
            c.setFont(font, size)
            (c.drawString if kind == "l" else c.drawRightString)(x, y, s)
        c.setFont(FONT, 6.5)
        c.drawCentredString(PAGE_W / 2, 24, f"Page {pno} of {n_pages}")
        c.showPage()
    c.save()
    return buf.getvalue()


def main(argv: List[str]) -> None:
    if len(argv) != 1:
        raise SystemExit("usage: python make_nsdl_cas.py out.pdf")
    accounts, folios = build_portfolio()
    plain = render(accounts, folios, lay_out(accounts, folios))
    with pikepdf.open(io.BytesIO(plain)) as pdf:
        pdf.save(argv[0], encryption=pikepdf.Encryption(owner=OWNER_PASSWORD, user=PAN, R=6, aes=True))
    print("wrote", argv[0])


if __name__ == "__main__":
    main(sys.argv[1:])
