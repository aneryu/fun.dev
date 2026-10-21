// XYZ Euler degrees at the authoring boundary; shortest-arc quaternion interpolation.
export function rotationQuaternion(degrees) {
  const [x, y, z] = degrees.map(v => v * Math.PI / 360);
  const a = Math.cos(x), b = Math.cos(y), c = Math.cos(z);
  const d = Math.sin(x), e = Math.sin(y), f = Math.sin(z);
  return [d*b*c+a*e*f, a*e*c-d*b*f, a*b*f+d*e*c, a*b*c-d*e*f];
}
export function quaternionRotation(value) {
  const length = Math.hypot(...value), [x, y, z, w] = value.map(v => v / length);
  const m13 = 2*(x*z+w*y), m23 = 2*(y*z-w*x), m33 = 1-2*(x*x+y*y);
  const m12 = 2*(x*y-w*z), m11 = 1-2*(y*y+z*z);
  return [Math.abs(m13) < 1-1e-14 ? Math.atan2(-m23, m33) : Math.atan2(2*(y*z+w*x), 1-2*(x*x+z*z)),
    Math.asin(Math.max(-1, Math.min(1, m13))),
    Math.abs(m13) < 1-1e-14 ? Math.atan2(-m12, m11) : 0].map(v => {
      const degrees = v * 180 / Math.PI;
      return Object.is(degrees, -0) ? 0 : degrees; // JSON has only unsigned zero.
    });
}
export function slerpRotation(a, b, t) {
  const qa = rotationQuaternion(a);
  let qb = rotationQuaternion(b), dot = qa.reduce((sum, v, i) => sum + v * qb[i], 0);
  if (dot < 0) { qb = qb.map(v => -v); dot = -dot; }
  let x = 1-t, y = t;
  if (dot < .999999) {
    const angle = Math.acos(Math.min(1, dot)), sin = Math.sin(angle);
    x = Math.sin((1-t)*angle)/sin; y = Math.sin(t*angle)/sin;
  }
  return quaternionRotation(qa.map((v, i) => x*v+y*qb[i]));
}
