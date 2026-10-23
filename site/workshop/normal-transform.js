// Inverse transpose of the affine linear part, normalized (translation has no effect).
export function transformNormals(values, m) {
  const a=m[0], b=m[4], c=m[8], d=m[1], e=m[5], f=m[9], g=m[2], h=m[6], i=m[10];
  const co=[e*i-f*h, f*g-d*i, d*h-e*g, c*h-b*i, a*i-c*g, b*g-a*h, b*f-c*e, c*d-a*f, a*e-b*d];
  const sign=Math.sign(a*co[0]+b*co[1]+c*co[2]);
  const out=new Float64Array(values.length);
  for(let k=0;k<values.length;k+=3){
    const x=values[k],y=values[k+1],z=values[k+2];
    const v=[co[0]*x+co[1]*y+co[2]*z,co[3]*x+co[4]*y+co[5]*z,co[6]*x+co[7]*y+co[8]*z];
    const n=Math.hypot(...v)||1;
    out.set(v.map(t=>sign*t/n),k);
  }
  return out;
}
