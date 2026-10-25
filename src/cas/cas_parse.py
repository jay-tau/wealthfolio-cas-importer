# What the add-on's Worker calls: casparser's JSON for the PDF's bytes (a JS Uint8Array).
import io

from casparser import read_cas_pdf


def parse(pdf, password):
    return read_cas_pdf(io.BytesIO(pdf.to_bytes()), password, output="json")
