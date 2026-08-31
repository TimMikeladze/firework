/**
 * The last thing every bus in the app goes through.
 *
 * Two different mixes end up here — the show's own reports (`@/builder/sfx`)
 * and the demo track (`./demo-song`) — and both have the same problem: a
 * compressor's attack, however fast, still lets the first millisecond of a
 * transient past, and a mix made of transients will poke through the ceiling
 * and clip. A waveshaper has no attack at all, so it catches exactly that.
 */

/**
 * A soft knee for the last few dB, as a waveshaper curve.
 *
 * Below `knee` the curve is exactly the identity. A shaper that quietly adds
 * gain to everything — `tanh(kx)/tanh(k)` does, by `k/tanh(k)` — would pin the
 * whole mix against the ceiling, and then a quiet sound and a loud one arrive
 * at the ear at the same level.
 */
export function softClipCurve(knee = 0.6): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const span = 1 - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + span * Math.tanh((a - knee) / span);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}
