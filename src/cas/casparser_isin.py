# Stands in for the casparser-isin package, whose ISIN database is too big to ship in an add-on.
# casparser then keeps each scheme's printed ISIN and leaves its AMFI code empty.


class _Db:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def isin_lookup(self, *args, **kwargs):
        raise ValueError("no ISIN database in the add-on")

    def direct_isin_lookup(self, isin):
        return [{"isin": isin, "amfi_code": None, "type": None}] if isin else []

    def batch_isin_lookup(self, isins):
        return {}


class MFISINDb(_Db):
    pass


class ISINDb(_Db):
    pass
