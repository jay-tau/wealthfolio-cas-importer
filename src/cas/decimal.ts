// Exact arithmetic on casparser's decimal strings, so amounts never pass through floats.
// Wealthfolio parses the strings into rust_decimal and must reach the same values.

/** `n / 10^scale` */
export interface Dec {
  readonly n: bigint;
  readonly scale: number;
}

export function dec(value: string): Dec {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new Error(`Not a decimal: ${value}`);
  const fraction = match[3] ?? "";
  const scale = fraction.length - Number(match[4] ?? 0);
  const n = BigInt(match[2] + fraction) * 10n ** BigInt(Math.max(0, -scale));
  return { n: match[1] ? -n : n, scale: Math.max(0, scale) };
}

/** 10^-places */
export const step = (places: number): Dec => ({ n: 1n, scale: places });

const rescale = (a: Dec, scale: number) => a.n * 10n ** BigInt(scale - a.scale);

export function add(a: Dec, b: Dec): Dec {
  const scale = Math.max(a.scale, b.scale);
  return { n: rescale(a, scale) + rescale(b, scale), scale };
}

export const neg = (a: Dec): Dec => ({ n: -a.n, scale: a.scale });
export const sub = (a: Dec, b: Dec) => add(a, neg(b));
export const abs = (a: Dec): Dec => (a.n < 0n ? neg(a) : a);
export const mul = (a: Dec, b: Dec): Dec => ({ n: a.n * b.n, scale: a.scale + b.scale });

/** `a / b` rounded half away from zero to `places` decimals. */
export function div(a: Dec, b: Dec, places: number): Dec {
  if (b.n === 0n) throw new Error("Division by zero");
  // a/b = (a.n / b.n) * 10^(b.scale - a.scale); scale the numerator so the quotient has `places` decimals.
  const shift = places + b.scale - a.scale;
  let num = shift >= 0 ? a.n * 10n ** BigInt(shift) : a.n;
  let den = shift >= 0 ? b.n : b.n * 10n ** BigInt(-shift);
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const q = num / den;
  const twice = 2n * (num % den);
  const n = twice >= den ? q + 1n : twice <= -den ? q - 1n : q;
  return { n, scale: places };
}

export function cmp(a: Dec, b: Dec): number {
  const diff = sub(a, b).n;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

export const isZero = (a: Dec) => a.n === 0n;

/** Without trailing zeros, like rust_decimal's `normalize()`. */
export function format(a: Dec): string {
  let { n, scale } = a;
  while (scale > 0 && n % 10n === 0n) {
    n /= 10n;
    scale--;
  }
  const digits = (n < 0n ? -n : n).toString().padStart(scale + 1, "0");
  const whole = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return n < 0n ? `-${whole}` : whole;
}
