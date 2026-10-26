"""Write a MADE-UP CAMS detailed Consolidated Account Statement PDF.

Usage: python make_cas.py out.pdf [--mismatch]

Everything in the statement is invented: investor, PAN (ABCDE1234F, the
PDF's user password), address, email, phone, folios, AMCs ("Fictiva Mutual
Fund", "Testbridge Mutual Fund"), scheme names, ISINs (well-formed INFZ9...
codes with valid check digits), NAVs and amounts.

The layout follows what casparser 1.4.1's CAMS DETAILED parser reads
(parsers/cams_detailed.py, _investor.py, detect.py):

  * vertical "CAMSCASWS..." watermark on every page (issuer detection; the
    parsers drop vertical text);
  * "Consolidated Account Statement" + "dd-Mmm-yyyy To dd-Mmm-yyyy" on page 1;
  * investor block in the left column (x < 200): Email Id / name / address /
    Mobile;
  * a two-row column header (Date, Transaction, Amount, Units, Price, Unit /
    (INR), (INR), Balance) at the top of every transaction page;
  * per scheme: AMC line, "Folio No:" line, holder name, "<code>-<name> -
    ISIN: ...(Advisor: ...)" + "Registrar : <RTA>", nominee line,
    "Opening Unit Balance:", dated rows, then one footer line with Closing
    Unit Balance / NAV on / Total Cost Value / Market Value on.

Balances are computed with Decimal so every printed running Unit Balance is
consistent. --mismatch drops one SIP purchase row so casparser reports one
unit-balance discontinuity in parse_warnings.

Output is AES-256 (R6) encrypted with user password "ABCDE1234F".
"""

from __future__ import annotations

import io
import sys
from dataclasses import dataclass, field
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import List, Optional

import pikepdf
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

PAN = "ABCDE1234F"
OWNER_PASSWORD = "fixture-owner-password"
PERIOD_FROM = date(2023, 4, 1)
PERIOD_TO = date(2025, 3, 31)

INVESTOR = {
    "name": "ANANYA R TESTWALA",
    "email": "ananya.testwala@example.com",
    "address": [
        "Flat 7B, Placeholder Residency",
        "12 Sample Street, Demo Nagar",
        "Fakeville 999999",
        "Maharashtra, India",
    ],
    "mobile": "+910000000000",
}

# ----------------------------------------------------------------- numbers

D = Decimal
STAMP_RATE = D("0.00005")  # 0.005 % stamp duty on purchases / switch-ins / reinvestments
STT_RATE = D("0.00001")  # 0.001 % STT on equity-oriented redemptions / switch-outs
TDS_RATE = D("0.10")  # 10 % TDS on IDCW payouts


def q(d: Decimal, places: int) -> Decimal:
    return d.quantize(D(1).scaleb(-places), rounding=ROUND_HALF_UP)


def inr(d: Decimal, places: int = 2) -> str:
    """Indian digit grouping (1,23,456.78); negatives in parentheses."""
    d = q(d, places)
    neg = d < 0
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
    return f"({s})" if neg else s


def dstr(d: date) -> str:
    return d.strftime("%d-%b-%Y")


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
    assert len(body) == 11 and body.startswith("INF"), body
    return body + isin_check_digit(body)


# ----------------------------------------------------------------- ledger


@dataclass
class Row:
    date: date
    desc: str
    amount: Optional[Decimal] = None
    units: Optional[Decimal] = None
    nav: Optional[Decimal] = None
    balance: Optional[Decimal] = None
    cont: Optional[str] = None  # wrapped description continuation line
    tag: str = ""  # used by --mismatch to pick the row to drop


@dataclass
class Scheme:
    code: str
    name: str
    isin: Optional[str]
    advisor: str
    rta: str
    nominee: str
    open_units: Decimal = D(0)
    open_cost: Decimal = D(0)
    close_nav: Decimal = D(0)
    rows: List[Row] = field(default_factory=list)
    balance: Decimal = D(0)
    lots: List[List[Decimal]] = field(default_factory=list)  # FIFO [units, cost]
    header_lines: Optional[List[str]] = None  # override scheme line wrapping

    def __post_init__(self):
        self.balance = self.open_units
        if self.open_units:
            self.lots.append([self.open_units, self.open_cost])

    # -- cost tracking (FIFO) -------------------------------------------
    def _add_lot(self, units, cost):
        self.lots.append([units, cost])

    def _consume(self, units):
        left = units
        while left > 0:
            lot = self.lots[0]
            if lot[0] <= left:
                left -= lot[0]
                self.lots.pop(0)
            else:
                cost_out = q(lot[1] * left / lot[0], 2)
                lot[0] -= left
                lot[1] -= cost_out
                left = D(0)

    @property
    def cost(self) -> Decimal:
        return q(sum((lot[1] for lot in self.lots), D(0)), 2)

    # -- transaction helpers -------------------------------------------
    def buy(self, dt, desc, gross, nav, *, cont=None, tag=""):
        stamp = q(gross * STAMP_RATE, 2)
        net = gross - stamp
        units = q(net / nav, 3)
        self.balance += units
        self.rows.append(Row(dt, desc, net, units, nav, self.balance, cont=cont, tag=tag))
        self.rows.append(Row(dt, "*** Stamp Duty ***", stamp))
        self._add_lot(units, net)
        return units

    def sell(self, dt, desc, units, nav, *, stt=True):
        amount = q(units * nav, 2)
        self.balance -= units
        self.rows.append(Row(dt, desc, -amount, -units, nav, self.balance))
        if stt:
            self.rows.append(Row(dt, "*** STT Paid ***", q(amount * STT_RATE, 2)))
        self._consume(units)
        return amount

    def idcw_payout(self, dt, rate):
        gross = q(self.balance * rate, 2)
        self.rows.append(Row(dt, f"IDCW Paid @ Rs.{rate} per unit", gross))
        self.rows.append(Row(dt, "*** TDS on Above ***", q(gross * TDS_RATE, 2)))

    def idcw_reinvest(self, dt, rate, ex_nav):
        gross = q(self.balance * rate, 2)
        self.buy(dt, f"IDCW Reinvestment @ Rs.{rate} per unit", gross, ex_nav)

    def misc(self, dt, desc):
        self.rows.append(Row(dt, desc))

    @property
    def value(self) -> Decimal:
        return q(self.balance * self.close_nav, 2)


@dataclass
class Folio:
    amc: str
    folio: str
    holder: str
    schemes: List[Scheme]
    kyc: str = "OK"
    pankyc: str = "OK"


def build_portfolio() -> List[Folio]:
    # ---- Fictiva Mutual Fund (Registrar: CAMS) ----------------------------
    flexi = Scheme(
        code="FFCDG",
        name="Fictiva Flexi Cap Fund - Direct Plan - Growth",
        isin=isin("INFZ90K01FC"),
        advisor="DIRECT",
        rta="CAMS",
        nominee="RAVI TESTWALA",
        open_units=D("1250.000"),
        open_cost=D("48000.00"),
        close_nav=D("74.3120"),
    )
    liquid = Scheme(
        code="FLQDG",
        name="Fictiva Liquid Fund - Direct Plan - Growth",
        isin=isin("INFZ90K01LQ"),
        advisor="DIRECT",
        rta="CAMS",
        nominee="RAVI TESTWALA",
        close_nav=D("2911.4521"),
    )
    balanced = Scheme(
        code="FBADR",
        name="Fictiva Balanced Advantage Fund - Direct Plan - IDCW Reinvestment",
        isin=isin("INFZ90K01BA"),
        advisor="DIRECT",
        rta="CAMS",
        nominee="RAVI TESTWALA",
        close_nav=D("18.0410"),
    )
    # The balanced fund's header is too wide for one line: wrap it the way
    # CAMS does, carrying the ISIN/Advisor annotation on a second line.
    balanced.header_lines = [
        f"{balanced.code}-{balanced.name}",
        f"- ISIN: {balanced.isin}(Advisor: {balanced.advisor})",
    ]

    # Flexi cap: 24 monthly SIPs of Rs.5,000 on the 10th, one redemption,
    # one switch-out to the liquid fund. NAV drifts up with a wiggle.
    wiggle = [D(x) for x in ("0", "0.62", "-0.41", "0.95", "0.18", "-0.77", "0.33", "1.12", "-0.25", "0.48", "-0.92", "0.71")]
    sip_dates = [date(2023 + (3 + m) // 12, (3 + m) % 12 + 1, 10) for m in range(24)]
    events = []
    for n, dt in enumerate(sip_dates, start=1):
        nav = q(D("48.5000") + D("1.0875") * (n - 1) + wiggle[(n - 1) % 12], 4)
        if n == 1:
            # Long description wraps onto a continuation line; only the
            # tail carries the SIP keyword (casparser re-classifies on merge).
            events.append((dt, 0, lambda dt=dt, nav=nav: flexi.buy(
                dt, "Purchase - Online via Fictiva Investor App", D(5000), nav,
                cont="- Systematic Instalment No 1 of 24")))
        else:
            events.append((dt, 0, lambda dt=dt, nav=nav, n=n: flexi.buy(
                dt, f"SIP Purchase - Instalment No {n} of 24", D(5000), nav, tag=f"sip{n}")))

    def redeem():
        flexi.sell(date(2024, 1, 15), "Redemption - Online", D("200.000"), D("57.2214"))

    def switch():
        dt = date(2024, 6, 20)
        out_amount = flexi.sell(dt, "Switch-Out - To Fictiva Liquid Fund", D("150.000"), D("61.0855"))
        stt = q(out_amount * STT_RATE, 2)
        liquid.buy(dt, "Switch-In - From Fictiva Flexi Cap Fund", out_amount - stt, D("2771.3348"))

    events.append((date(2024, 1, 15), 1, redeem))
    events.append((date(2024, 6, 20), 1, switch))

    liquid_events = [
        (date(2023, 5, 5), 0, lambda: liquid.buy(date(2023, 5, 5), "Purchase - Online", D(25000), D("2564.8812"))),
        (date(2024, 11, 18), 1, lambda: liquid.sell(date(2024, 11, 18), "Redemption - Online", D("5.000"), D("2862.1907"), stt=False)),
    ]
    for _, _, fn in sorted(events + liquid_events, key=lambda e: (e[0], e[1])):
        fn()

    balanced.buy(date(2023, 6, 12), "Purchase - Online", D(50000), D("15.2370"))
    balanced.idcw_reinvest(date(2023, 9, 25), D("0.40"), D("15.6145"))
    balanced.idcw_reinvest(date(2024, 3, 26), D("0.45"), D("16.4482"))
    balanced.idcw_reinvest(date(2024, 9, 25), D("0.42"), D("17.5263"))

    # ---- Testbridge Mutual Fund (Registrar: KFINTECH) ----------------------
    corp_bond = Scheme(
        code="TCBRP",
        name="Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout",
        isin=isin("INFZ91T01CB"),
        advisor="ARN-000000",
        rta="KFINTECH",
        nominee="RAVI TESTWALA",
        close_nav=D("10.7432"),
    )
    corp_bond.buy(date(2023, 7, 3), "Purchase - Online", D(100000), D("10.5128"))
    corp_bond.idcw_payout(date(2023, 12, 28), D("0.85"))
    corp_bond.idcw_payout(date(2024, 6, 28), D("0.80"))
    corp_bond.idcw_payout(date(2024, 12, 27), D("0.82"))

    overnight = Scheme(  # no ISIN printed in its header
        code="TONDG",
        name="Testbridge Overnight Fund - Direct Plan - Growth",
        isin=None,
        advisor="DIRECT",
        rta="KFINTECH",
        nominee="",
        close_nav=D("1311.2045"),
    )
    overnight.buy(date(2023, 8, 14), "Purchase - Online", D(20000), D("1215.6611"))
    overnight.misc(date(2024, 2, 2), "***Registration of Nominee***")
    overnight.sell(date(2025, 3, 10), "Redemption - Online", D("6.250"), D("1306.9834"), stt=False)

    # Closed schemes: CAMS still lists a fund sold before the statement, with no
    # units at either end, and no rows or only events such as a new nominee.
    midcap = Scheme(
        code="FMCDG",
        name="Fictiva Midcap Fund - Direct Plan - Growth",
        isin=isin("INFZ90K01MC"),
        advisor="DIRECT",
        rta="CAMS",
        nominee="RAVI TESTWALA",
        close_nav=D("31.2077"),
    )
    gilt = Scheme(
        code="TGLDG",
        name="Testbridge Gilt Fund - Direct Plan - Growth",
        isin=isin("INFZ91T01GL"),
        advisor="DIRECT",
        rta="KFINTECH",
        nominee="RAVI TESTWALA",
        close_nav=D("54.0912"),
    )
    gilt.misc(date(2023, 11, 6), "***Registration of Nominee***")

    return [
        Folio("Fictiva Mutual Fund", "91234567 / 12", INVESTOR["name"], [flexi, liquid, balanced, midcap]),
        Folio("Testbridge Mutual Fund", "1040012345", INVESTOR["name"], [corp_bond, overnight, gilt]),
    ]


# ----------------------------------------------------------------- layout

PAGE_W, PAGE_H = A4
FONT, BOLD = "Helvetica", "Helvetica-Bold"
SIZE = 7.5
X_DATE, X_DESC = 36, 88
X_AMOUNT, X_UNITS, X_PRICE, X_BAL = 340, 405, 470, 545  # right edges
NUMERIC_ZONE = 55  # casparser NUMERIC_ZONE_WIDTH
ROW_STEP, CONT_STEP = 10, 8
BOTTOM = 52
WATERMARK = "CAMSCASWS-00000001-01042025-TEST-FIXTURE Version:V3.4 Live-1017"


class Layout:
    """Collects draw ops per page; rendered once the page count is known."""

    def __init__(self):
        self.pages: List[list] = []
        self.y = 0.0
        self.new_page(first=True)

    def new_page(self, first=False):
        self.pages.append([])
        self.y = 625 if first else PAGE_H - 40
        self.column_header()

    def op(self, *args):
        self.pages[-1].append(args)

    def text(self, x, y, s, font=FONT, size=SIZE):
        self.op("l", x, y, s, font, size)

    def rtext(self, x, y, s, font=FONT, size=SIZE):
        self.op("r", x, y, s, font, size)

    def column_header(self):
        y = self.y
        self.text(X_DATE, y, "Date", BOLD)
        self.text(X_DESC, y, "Transaction", BOLD)
        self.rtext(X_AMOUNT, y, "Amount", BOLD)
        self.rtext(X_UNITS, y, "Units", BOLD)
        self.rtext(X_PRICE, y, "Price", BOLD)
        self.rtext(X_BAL, y, "Unit", BOLD)
        self.rtext(X_AMOUNT, y - 8, "(INR)", BOLD)
        self.rtext(X_PRICE, y - 8, "(INR)", BOLD)
        self.rtext(X_BAL, y - 8, "Balance", BOLD)
        self.y = y - 8 - 20  # first content line well outside the 15pt header window

    def need(self, height):
        if self.y - height < BOTTOM:
            self.new_page()

    def advance(self, step):
        self.y -= step


def check_desc_width(s: str):
    room = (X_AMOUNT - NUMERIC_ZONE - 4) - X_DESC
    w = stringWidth(s, FONT, SIZE)
    if w > room:
        raise SystemExit(f"description too wide ({w:.1f} > {room}pt): {s!r}")


def lay_out(folios: List[Folio], drop_tag: Optional[str]) -> Layout:
    L = Layout()
    for folio in folios:
        L.need(14 + 12 * 6)
        L.text(X_DATE, L.y, folio.amc, BOLD, 8.5)
        L.advance(14)
        for s in folio.schemes:
            header = s.header_lines or [
                f"{s.code}-{s.name}"
                + (f" - ISIN: {s.isin}" if s.isin else "")
                + f"(Advisor: {s.advisor})"
            ]
            L.need(11 * (4 + len(header)) + 2 * ROW_STEP)
            L.text(X_DATE, L.y, f"Folio No: {folio.folio}", BOLD)
            L.text(250, L.y, f"PAN: {PAN}", BOLD)
            L.text(400, L.y, f"KYC: {folio.kyc}  PAN: {folio.pankyc}", BOLD)
            L.advance(10)
            L.text(X_DATE, L.y, folio.holder)
            L.advance(10)
            for k, hl in enumerate(header):
                if stringWidth(hl, BOLD, SIZE) > 470 - X_DATE - 10:
                    raise SystemExit(f"scheme header line too wide: {hl!r}")
                L.text(X_DATE, L.y, hl, BOLD)
                if k == 0:
                    L.text(470, L.y, f"Registrar : {s.rta}", BOLD)
                L.advance(10)
            L.text(X_DATE, L.y, f"Nominee 1: {s.nominee}")
            L.text(220, L.y, "Nominee 2:")
            L.text(380, L.y, "Nominee 3:")
            L.advance(12)
            L.text(X_DESC, L.y, f"Opening Unit Balance: {inr(s.open_units, 3)}", BOLD)
            L.advance(12)
            for r in s.rows:
                if drop_tag and r.tag == drop_tag:
                    continue
                L.need(ROW_STEP + (CONT_STEP if r.cont else 0))
                check_desc_width(r.desc)
                L.text(X_DATE, L.y, dstr(r.date))
                L.text(X_DESC, L.y, r.desc)
                if r.amount is not None:
                    L.rtext(X_AMOUNT, L.y, inr(r.amount, 2))
                if r.units is not None:
                    L.rtext(X_UNITS, L.y, inr(r.units, 3))
                if r.nav is not None:
                    L.rtext(X_PRICE, L.y, inr(r.nav, 4))
                if r.balance is not None:
                    L.rtext(X_BAL, L.y, inr(r.balance, 3))
                if r.cont:
                    check_desc_width(r.cont)
                    L.advance(CONT_STEP)
                    L.text(X_DESC, L.y, r.cont)
                L.advance(ROW_STEP)
            L.need(12)
            L.advance(2)
            to = dstr(PERIOD_TO)
            parts = [
                f"Closing Unit Balance: {inr(s.balance, 3)}",
                f"NAV on {to}: INR {inr(s.close_nav, 4)}",
                f"Total Cost Value: {inr(s.cost, 2)}",
                f"Market Value on {to}: INR {inr(s.value, 2)}",
            ]
            x = X_DATE
            for p in parts:
                L.text(x, L.y, p, BOLD, 7)
                x += stringWidth(p, BOLD, 7) + 14
            if x - 14 > X_BAL + 5:
                raise SystemExit(f"footer line too wide ({x:.0f}pt)")
            L.advance(18)
    return L


def render(folios: List[Folio], L: Layout) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4, invariant=1)
    c.setTitle("Consolidated Account Statement (test fixture)")
    c.setAuthor("make_cas.py")
    n_pages = len(L.pages)
    for pno, ops in enumerate(L.pages, start=1):
        # Vertical watermark down the right edge (issuer marker).
        t = c.beginText()
        t.setTextTransform(0, 1, -1, 0, PAGE_W - 18, 120)
        t.setFont(FONT, 6)
        t.textLine(f"{WATERMARK}-P{pno}")
        c.drawText(t)
        if pno == 1:
            page_one_banner(c, folios)
        for kind, x, y, s, font, size in ops:
            c.setFont(font, size)
            (c.drawString if kind == "l" else c.drawRightString)(x, y, s)
        c.setFont(FONT, 6.5)
        c.drawCentredString(PAGE_W / 2, 24, f"Page {pno} of {n_pages}")
        c.showPage()
    c.save()
    return buf.getvalue()


def page_one_banner(c, folios: List[Folio]):
    c.setFont(BOLD, 12)
    c.drawCentredString(PAGE_W / 2, 806, "Consolidated Account Statement")
    c.setFont(FONT, 9)
    c.drawCentredString(PAGE_W / 2, 793, f"{dstr(PERIOD_FROM)} To {dstr(PERIOD_TO)}")

    # Investor block, left column (casparser reads atoms with x_left < 200).
    y = 768
    c.setFont(FONT, 8)
    lines = [f"Email Id: {INVESTOR['email']}", INVESTOR["name"], *INVESTOR["address"], f"Mobile: {INVESTOR['mobile']}"]
    for s in lines:
        c.setFont(BOLD if s == INVESTOR["name"] else FONT, 8)
        c.drawString(X_DATE, y, s)
        y -= 10

    # Right-column note (x >= 200, ignored by the investor extractor).
    c.setFont(FONT, 7)
    note = [
        "This statement is a made-up test fixture generated by make_cas.py.",
        "It does not describe any real investor, folio, scheme or AMC.",
        "All names, ISINs, NAVs and amounts are invented for parser testing.",
        "Values are as on the last day of the statement period.",
    ]
    y = 768
    for s in note:
        c.drawString(300, y, s)
        y -= 10

    # Portfolio summary by AMC.
    y = 690
    c.setFont(BOLD, 8)
    c.drawString(X_DATE, y, "PORTFOLIO SUMMARY")
    y -= 12
    c.setFont(BOLD, 7.5)
    c.drawString(X_DATE, y, "Mutual Fund")
    c.drawRightString(X_AMOUNT, y, "Cost Value (INR)")
    c.drawRightString(X_PRICE, y, "Market Value (INR)")
    y -= 10
    c.setFont(FONT, 7.5)
    tot_cost = tot_value = D(0)
    for f in folios:
        cost = sum((s.cost for s in f.schemes), D(0))
        value = sum((s.value for s in f.schemes), D(0))
        tot_cost += cost
        tot_value += value
        c.drawString(X_DATE, y, f.amc)
        c.drawRightString(X_AMOUNT, y, inr(cost))
        c.drawRightString(X_PRICE, y, inr(value))
        y -= 10
    c.setFont(BOLD, 7.5)
    c.drawString(X_DATE, y, "Total")
    c.drawRightString(X_AMOUNT, y, inr(tot_cost))
    c.drawRightString(X_PRICE, y, inr(tot_value))


def main(argv: List[str]) -> None:
    args = [a for a in argv if not a.startswith("--")]
    flags = {a for a in argv if a.startswith("--")}
    if len(args) != 1 or flags - {"--mismatch"}:
        raise SystemExit("usage: python make_cas.py out.pdf [--mismatch]")
    folios = build_portfolio()
    drop = "sip6" if "--mismatch" in flags else None
    plain = render(folios, lay_out(folios, drop))
    with pikepdf.open(io.BytesIO(plain)) as pdf:
        pdf.save(
            args[0],
            encryption=pikepdf.Encryption(owner=OWNER_PASSWORD, user=PAN, R=6, aes=True),
        )
    print("wrote", args[0], "(dropped row: %s)" % drop if drop else "")


if __name__ == "__main__":
    main(sys.argv[1:])
