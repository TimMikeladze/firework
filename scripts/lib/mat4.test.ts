import { describe, expect, test } from "bun:test";
import { invertInto, lookAt, multiply, perspective } from "./mat4.mjs";

/**
 * The sky shader reconstructs a world-space ray per pixel from the inverse
 * view-projection, and the water plane is intersected against that ray. A wrong
 * inverse does not crash — it quietly bends the horizon — so the round trip is
 * worth asserting on.
 */
describe("mat4", () => {
  const view = lookAt([0, 7, 88], [0, 1, 0], [0, 1, 0]);
  const viewProj = multiply(perspective(52, 1200 / 630, 0.5, 900), view);

  test("the inverse view-projection round-trips to the identity", () => {
    const inverse = new Float32Array(16);
    invertInto(inverse, viewProj);

    const identity = multiply(viewProj, inverse);
    for (let column = 0; column < 4; column++) {
      for (let row = 0; row < 4; row++) {
        const expected = column === row ? 1 : 0;
        expect(identity[column * 4 + row]).toBeCloseTo(expected, 4);
      }
    }
  });

  test("the camera looks down the axis it was aimed along", () => {
    // Column-major: the third column is the camera's backward axis in view
    // space, so an eye above and behind the origin tilts down and forward.
    const forward = [-view[2], -view[6], -view[10]];
    expect(forward[1]).toBeLessThan(0);
    expect(forward[2]).toBeLessThan(0);
    expect(Math.hypot(...forward)).toBeCloseTo(1, 5);
  });
});
