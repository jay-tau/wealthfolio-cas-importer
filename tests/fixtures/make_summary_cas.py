"""Write a MADE-UP CAMS or KFintech summary Consolidated Account Statement PDF.

Usage: python make_summary_cas.py out.pdf [--kfintech]

Everything in the statement is invented: investor, PAN (ABCDE1234F, the
PDF's user password), address, email, phone, folios, AMCs ("Fictiva Mutual
Fund", "Testbridge Mutual Fund"), scheme names, ISINs (well-formed INFZ9...
codes with valid check digits), NAVs and amounts.

The layout follows what casparser 1.4.1's CAMS/KFin SUMMARY parser reads
(parsers/cams_summary.py, _investor.py, detect.py):

  * vertical "CAMSCASWS..." (or, with --kfintech, "KFINCASWS...") watermark
    on every page for issuer detection; the parsers drop vertical text. A
    KFintech file must not contain "CAMSCASWS" anywhere, since that is
    checked first;
  * "Consolidated Account Summary" on page 1, and no "Consolidated Account
    Statement" anywhere on that page (the first match decides the type);
  * "As on dd-Mmm-yyyy": the first line containing "as on <date>" gives the
    statement date, which becomes both statement_period.from and .to;
  * investor block in the left column (x < 200): Email Id / name / address /
    Mobile, one text-show op per line;
  * a column header holding at least 5 of the labels, including "Folio" and
    "Scheme", inside one 15 pt window. CAMS prints it on one baseline (Folio
    No. | ISIN | Scheme Name | Cost Value | Unit Balance | NAV Date | NAV |
    Market Value | Registrar, with "(INR)" under the money columns); KFintech
    spreads it over three (Cost Value | Closing Unit | Price | Market Value
    on top, Folio No. | ISIN | Scheme Name | NAV Date | Registrar 5 pt lower,
    Balance under Closing Unit). Header words are clustered by x across all
    baselines: words of one column must sit within 7 pt of each other and
    neighbouring columns more than 7 pt apart. Keep every other line more
    than 15 pt away from the header's top line: a line inside the window
    counts as header, so it is never read as a row and its words join the
    clusters (an AMC line there still sets the AMC, but merges the Folio
    and ISIN columns);
  * an AMC line ("<X> Mutual Fund" and nothing else on that baseline) before
    the AMC's folios;
  * one row per scheme: folio (>= 6 digits, optional "/N" sub-account), ISIN,
    "<CODE>-<scheme name>", Cost Value (blank when unknown), Unit Balance,
    NAV Date, NAV, Market Value, Registrar. Folio, ISIN, Scheme, NAV Date and
    Registrar are left-aligned at their label's left edge; Cost, Balance,
    NAV and Market Value are right-aligned on their label's right edge, and
    every glyph midpoint must fall within 42 pt of that edge. At 7 pt
    Helvetica that holds 99,99,999.99; an amount of a crore or more silently
    loses its leading digit (in the Cost column that digit is appended to
    the scheme name instead). A scheme name must end before Cost.right - 42.
    A folio whose "/N" crosses into the ISIN zone (ISIN.left - 3) comes back
    without its "/N";
  * a scheme name too wide for its column wraps onto the line below, which
    holds nothing but the rest of the name, in the Scheme column;
  * a "Total" row (no folio) ends the table, followed by notes. The Total
    row is what stops the notes below it from being appended to the last
    scheme's name.

Output is AES-256 (R6) encrypted with user password "ABCDE1234F".
"""

from __future__ import annotations

import io
import sys
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import List, Optional

import pikepdf
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

PAN = "ABCDE1234F"
OWNER_PASSWORD = "fixture-owner-password"
AS_ON = date(2025, 3, 31)

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


def q(d: Decimal, places: int) -> Decimal:
    return d.quantize(D(1).scaleb(-places), rounding=ROUND_HALF_UP)


def inr(d: Decimal, places: int = 2) -> str:
    """Indian digit grouping (1,23,456.78)."""
    whole, _, frac = f"{q(d, places):.{places}f}".partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups + [tail])
    return f"{whole}.{frac}" if places else whole


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


# ----------------------------------------------------------------- holdings


@dataclass
class Holding:
    code: str
    name: str
    isin: str
    units: Decimal
    nav: Decimal
    cost: Optional[Decimal]  # None prints a blank Cost Value cell
    rta: str
    nav_date: date = AS_ON

    @property
    def value(self) -> Decimal:
        return q(self.units * self.nav, 2)


@dataclass
class Folio:
    amc: str
    folio: str
    holdings: List[Holding]


def build_portfolio() -> List[Folio]:
    return [
        Folio("Fictiva Mutual Fund", "91234567 / 12", [
            Holding("FFCDG", "Fictiva Flexi Cap Fund - Direct Plan - Growth", isin("INFZ90K01FC"),
                    D("2892.104"), D("74.3120"), D("154554.00"), "CAMS"),
            Holding("FLQDG", "Fictiva Liquid Fund - Direct Plan - Growth", isin("INFZ90K01LQ"),
                    D("12.296"), D("2911.4521"), D("33150.40"), "CAMS"),
        ]),
        # Sub-account "/0" written without spaces; the folio above keeps CAMS's " / ".
        Folio("Fictiva Mutual Fund", "91234570/0", [
            Holding("FBADR", "Fictiva Balanced Advantage Fund - Direct Plan - Income Distribution cum "
                    "Capital Withdrawal Option - Reinvestment", isin("INFZ90K01BA"),
                    D("3443.910"), D("18.0410"), D("56021.37"), "CAMS"),
        ]),
        Folio("Testbridge Mutual Fund", "1040012345", [
            Holding("TCBRP", "Testbridge Corporate Bond Fund - Regular Plan - IDCW Payout", isin("INFZ91T01CB"),
                    D("9511.474"), D("10.7432"), D("99995.00"), "KFINTECH"),
            # Cost unknown to the registrar: the Cost Value cell is left blank.
            Holding("TGLDG", "Testbridge Gilt Fund - Direct Plan - Growth", isin("INFZ91T01GL"),
                    D("845.512"), D("54.0912"), None, "KFINTECH"),
            # A closed-ended plan whose last NAV is older than the statement date.
            Holding("TFT12", "Testbridge Fixed Term Plan - Series 12 - Direct Plan - Growth", isin("INFZ91T01FT"),
                    D("5000.000"), D("11.2045"), D("50000.00"), "KFINTECH", nav_date=date(2025, 3, 28)),
        ]),
    ]


# ----------------------------------------------------------------- layout

PAGE_W, PAGE_H = landscape(A4)
FONT, BOLD = "Helvetica", "Helvetica-Bold"
SIZE = 7
# Left-aligned columns: left edges. Right-aligned columns: right edges (_R).
X_FOLIO, X_ISIN, X_SCHEME = 30, 92, 156
COST_R, BAL_R = 470, 540
X_NAVDATE = 556
NAV_R, MV_R = 650, 730
X_REG = 748
NUMERIC_WIDTH = 42  # casparser cams_summary.NUMERIC_WIDTH
HEADER_TOP = 440
ROW_STEP, CONT_STEP = 12, 8
WATERMARK = {
    "CAMS": "CAMSCASWS-00000002-31032025-TEST-FIXTURE Version:V3.4 Live-1017",
    "KFINTECH": "KFINCASWS-00000002-31032025-TEST-FIXTURE Version:V3.4 Live-1017",
}


def width(s: str, font: str = FONT, size: float = SIZE) -> float:
    return stringWidth(s, font, size)


def check_left(s: str, x: float, limit: float, what: str):
    if x + width(s) > limit - 1:
        raise SystemExit(f"{what} too wide ({x + width(s):.1f} > {limit - 1}pt): {s!r}")


def check_right(s: str, x_hi: float, what: str):
    # casparser assigns a glyph by its midpoint; the leftmost one must be
    # inside the column's NUMERIC_WIDTH zone.
    mid = x_hi - width(s) + width(s[0]) / 2
    if mid < x_hi - NUMERIC_WIDTH + 1:
        raise SystemExit(f"{what} too wide for the {NUMERIC_WIDTH}pt numeric zone: {s!r}")


SCHEME_LIMIT = COST_R - NUMERIC_WIDTH  # Scheme zone ends where Cost's begins


def wrap_scheme(text: str) -> List[str]:
    """Greedy word wrap at single spaces, so casparser's " "-join restores it."""
    lines, cur = [], ""
    for word in text.split(" "):
        cand = f"{cur} {word}" if cur else word
        if cur and X_SCHEME + width(cand) > SCHEME_LIMIT - 1:
            lines.append(cur)
            cur = word
        else:
            cur = cand
    lines.append(cur)
    return lines


def header(c, kfin: bool):
    def lt(x, y, s):
        c.setFont(BOLD, SIZE)
        c.drawString(x, y, s)

    def rt(x, y, s):
        c.setFont(BOLD, SIZE)
        c.drawRightString(x, y, s)

    y = HEADER_TOP
    if not kfin:
        lt(X_FOLIO, y, "Folio No.")
        lt(X_ISIN, y, "ISIN")
        lt(X_SCHEME, y, "Scheme Name")
        rt(COST_R, y, "Cost Value")
        rt(BAL_R, y, "Unit Balance")
        lt(X_NAVDATE, y, "NAV Date")
        rt(NAV_R, y, "NAV")
        rt(MV_R, y, "Market Value")
        lt(X_REG, y, "Registrar")
        for x in (COST_R, NAV_R, MV_R):
            rt(x, y - 8, "(INR)")
    else:
        rt(COST_R, y, "Cost Value")
        rt(BAL_R, y, "Closing Unit")
        rt(NAV_R, y, "Price")
        rt(MV_R, y, "Market Value")
        lt(X_FOLIO, y - 5, "Folio No.")
        lt(X_ISIN, y - 5, "ISIN")
        lt(X_SCHEME, y - 5, "Scheme Name")
        lt(X_NAVDATE, y - 5, "NAV Date")
        lt(X_REG, y - 5, "Registrar")
        rt(BAL_R, y - 10, "Balance")


def render(folios: List[Folio], kfin: bool) -> bytes:
    issuer = "KFINTECH" if kfin else "CAMS"
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(PAGE_W, PAGE_H), invariant=1)
    c.setTitle("Consolidated Account Summary (test fixture)")
    c.setAuthor("make_summary_cas.py")

    # Vertical watermark down the right edge (issuer marker).
    t = c.beginText()
    t.setTextTransform(0, 1, -1, 0, PAGE_W - 14, 60)
    t.setFont(FONT, 6)
    t.textLine(f"{WATERMARK[issuer]}-P1")
    c.drawText(t)

    c.setFont(BOLD, 12)
    c.drawCentredString(PAGE_W / 2, 568, "Consolidated Account Summary")
    c.setFont(FONT, 9)
    c.drawCentredString(PAGE_W / 2, 555, f"As on {dstr(AS_ON)}")

    # Investor block, left column (casparser reads atoms with x_left < 200).
    y = 530
    for s in [f"Email Id: {INVESTOR['email']}", INVESTOR["name"], *INVESTOR["address"],
              f"Mobile: {INVESTOR['mobile']}"]:
        c.setFont(BOLD if s == INVESTOR["name"] else FONT, 8)
        c.drawString(X_FOLIO, y, s)
        y -= 10

    # Right-column note (x >= 200, ignored by the investor extractor).
    c.setFont(FONT, 7)
    y = 530
    for s in [
        f"PAN: {PAN}",
        "This statement is a made-up test fixture generated by make_summary_cas.py.",
        "It does not describe any real investor, folio, scheme or AMC.",
        "All names, ISINs, NAVs and amounts are invented for parser testing.",
    ]:
        c.drawString(430, y, s)
        y -= 10

    header(c, kfin)

    y = HEADER_TOP - 24  # first content line well outside the 15pt header window
    amc = None
    tot_cost = tot_value = D(0)
    for f in folios:
        if f.amc != amc:
            amc = f.amc
            c.setFont(BOLD, 8)
            c.drawString(X_FOLIO, y, f.amc)
            y -= ROW_STEP
        for h in f.holdings:
            lines = wrap_scheme(f"{h.code}-{h.name}")
            cells_l = [(X_FOLIO, f.folio, X_ISIN - 3, "folio"), (X_ISIN, h.isin, X_SCHEME - 3, "ISIN"),
                       (X_SCHEME, lines[0], SCHEME_LIMIT, "scheme"),
                       (X_NAVDATE, dstr(h.nav_date), NAV_R - NUMERIC_WIDTH, "NAV date"),
                       (X_REG, h.rta, PAGE_W - 30, "registrar")]
            cells_r = [(COST_R, inr(h.cost) if h.cost is not None else "", "cost"),
                       (BAL_R, inr(h.units, 3), "units"), (NAV_R, inr(h.nav, 4), "NAV"),
                       (MV_R, inr(h.value), "value")]
            c.setFont(FONT, SIZE)
            for x, s, limit, what in cells_l:
                check_left(s, x, limit, what)
                c.drawString(x, y, s)
            for x, s, what in cells_r:
                if s:
                    check_right(s, x, what)
                    c.drawRightString(x, y, s)
            for cont in lines[1:]:
                y -= CONT_STEP
                c.drawString(X_SCHEME, y, cont)
            y -= ROW_STEP
            tot_cost += h.cost or 0
            tot_value += h.value

    y -= 2
    c.setFont(BOLD, SIZE)
    c.drawString(X_FOLIO, y, "Total")
    for x, s in ((COST_R, inr(tot_cost)), (MV_R, inr(tot_value))):
        check_right(s, x, "total")
        c.drawRightString(x, y, s)

    # Notes after the Total row. They are short enough to sit only in the
    # Folio / ISIN / Scheme zones, i.e. they look like a wrapped scheme name.
    y -= 24
    c.setFont(FONT, SIZE)
    for s in [
        "Notes:",
        "Cost Value is left blank where the cost of the units is not available.",
        "Market Value is computed at the NAV of the NAV Date shown against each scheme.",
        "Units held in demat form are not included in this summary.",
        "Please report any discrepancy within 30 days of receiving this summary.",
    ]:
        c.drawString(X_FOLIO, y, s)
        y -= 10

    c.setFont(FONT, 6.5)
    c.drawCentredString(PAGE_W / 2, 24, "Page 1 of 1")
    c.showPage()
    c.save()
    return buf.getvalue()


def main(argv: List[str]) -> None:
    args = [a for a in argv if not a.startswith("--")]
    flags = {a for a in argv if a.startswith("--")}
    if len(args) != 1 or flags - {"--kfintech"}:
        raise SystemExit("usage: python make_summary_cas.py out.pdf [--kfintech]")
    plain = render(build_portfolio(), "--kfintech" in flags)
    with pikepdf.open(io.BytesIO(plain)) as pdf:
        pdf.save(
            args[0],
            encryption=pikepdf.Encryption(owner=OWNER_PASSWORD, user=PAN, R=6, aes=True),
        )
    print("wrote", args[0])


if __name__ == "__main__":
    main(sys.argv[1:])
