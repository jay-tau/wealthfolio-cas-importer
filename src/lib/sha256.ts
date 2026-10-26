// SHA-256, for remembering a PAN or folio without storing it. Not `crypto.subtle`, which
// only exists in secure contexts, and Wealthfolio's web app may be served over plain HTTP.

const K = new Uint32Array(64);
const H0 = new Uint32Array(8);
{
  const primes: number[] = [];
  for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p)) primes.push(n);
  const frac = (x: number) => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
  primes.forEach((p, i) => {
    K[i] = frac(Math.cbrt(p));
    if (i < 8) H0[i] = frac(Math.sqrt(p));
  });
}

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export function sha256(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const data = new Uint8Array(blocks * 64);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(data.length - 8, Math.floor((bytes.length * 8) / 2 ** 32));
  view.setUint32(data.length - 4, (bytes.length * 8) >>> 0);

  const h = H0.slice();
  const w = new Uint32Array(64);
  for (let block = 0; block < blocks; block++) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block * 64 + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      [hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => (h[i] = h[i] + v));
  }
  return [...h].map((v) => v.toString(16).padStart(8, "0")).join("");
}
