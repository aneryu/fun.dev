// Reading MakeHuman's CC0 assets (makehumancommunity.org; the assets, not its code): the base mesh,
// targets, the default rig and its weights, proxies and clothes (.mhclo) and materials (.mhmat).
// Formats as documented by the MakeHuman project; parsed here from their text.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const lines = (path) => readFileSync(path, "utf8").split(/\r?\n/);

/** An OBJ: positions, texture coordinates and faces (vertex and UV indices, from 0) with their group. */
export function readObj(path) {
  const v = [], vt = [], faces = [];
  let group = "";
  for (const line of lines(path)) {
    const [key, ...rest] = line.trim().split(/\s+/);
    if (key === "v") v.push(rest.slice(0, 3).map(Number));
    else if (key === "vt") vt.push(rest.slice(0, 2).map(Number));
    else if (key === "g") group = rest.join(" ");
    else if (key === "f") {
      const corners = rest.map((c) => c.split("/").map((x) => (x ? Number(x) - 1 : -1)));
      faces.push({ v: corners.map((c) => c[0]), vt: corners.map((c) => c[1] ?? -1), group });
    }
  }
  return { v, vt, faces };
}

/** A target: vertex index → [dx, dy, dz] (decimetres, as the base mesh). */
export function readTarget(path) {
  const out = new Map();
  for (const line of lines(path)) {
    if (!line || line.startsWith("#")) continue;
    const [i, x, y, z] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(i)) out.set(i, [x, y, z]);
  }
  return out;
}

/** Positions after targets: [[target, weight], …] added to the base. */
export function applyTargets(base, targets) {
  const p = base.map((q) => [...q]);
  for (const [target, w] of targets) for (const [i, d] of target) { const q = p[i]; q[0] += d[0] * w; q[1] += d[1] * w; q[2] += d[2] * w; }
  return p;
}

/** A material: its settings and the absolute paths of its textures. */
export function readMhmat(path) {
  const out = { path };
  for (const line of lines(path)) {
    if (!line || line.startsWith("#")) continue;
    const [key, ...rest] = line.trim().split(/\s+/);
    out[key] = rest.join(" ");
  }
  for (const key of ["diffuseTexture", "normalmapTexture", "transparencyTexture"]) if (out[key]) out[key] = join(dirname(path), out[key].split("/").pop());
  return out;
}

/**
 * A proxy or garment (.mhclo): its geometry (obj_file), material, the base mesh vertices it is
 * bound to (each vertex: three base vertices, weights and an offset, or one vertex exactly),
 * the scale references, the base vertices it hides (delete_verts), and its licence and author.
 */
export function readMhclo(path) {
  const out = { path, verts: [], deleteVerts: new Set(), scales: {}, tags: [] };
  let section = null;
  for (const raw of lines(path)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const m = line.match(/^#\s*(license|author):?\s+(.*)$/i);
      if (m) out[m[1].toLowerCase()] = m[2].trim();
      if (/explicitly released as CC0/i.test(line)) out.released = true;
      continue;
    }
    const [key, ...rest] = line.split(/\s+/);
    if (key === "verts") { section = "verts"; continue; }
    if (key === "delete_verts") { section = "delete"; continue; }
    if (section === "verts" && /^\d/.test(key)) {
      const n = [key, ...rest].map(Number);
      out.verts.push(n.length >= 9 ? { v: n.slice(0, 3), w: n.slice(3, 6), d: n.slice(6, 9) } : { v: [n[0], n[0], n[0]], w: [1, 0, 0], d: [0, 0, 0] });
      continue;
    }
    if (section === "delete" && /^\d/.test(key)) {
      for (const part of [key, ...rest]) {
        if (part.includes("-")) { const [a, b] = part.split("-").map(Number); for (let i = a; i <= b; i++) out.deleteVerts.add(i); }
        else if (part) out.deleteVerts.add(Number(part));
      }
      continue;
    }
    // Settings may sit inside the vertex list (material, a weights file); the list goes on after them.
    if (key === "x_scale" || key === "y_scale" || key === "z_scale") out.scales[key[0]] = rest.map(Number);
    else if (key === "obj_file") out.obj = join(dirname(path), rest.join(" "));
    else if (key === "material") out.material = join(dirname(path), rest.join(" "));
    else if (key === "name") out.name = rest.join(" ");
    else if (key === "tag") out.tags.push(rest.join(" ").toLowerCase());
    else if (key === "z_depth") out.zDepth = Number(rest[0]);
    else if (key === "license") out.license = rest.join(" ");
    else if (key === "author") out.author = rest.join(" ");
  }
  return out;
}

/** A proxy's vertices on a posed base mesh: the bound vertices' weighted point plus the offset scaled as the body is. */
export function fitProxy(clo, pose) {
  const scale = [0, 1, 2].map((k) => {
    const s = clo.scales["xyz"[k]];
    return s ? Math.abs(pose[s[0]][k] - pose[s[1]][k]) / s[2] : 1;
  });
  return clo.verts.map(({ v, w, d }) => [0, 1, 2].map((k) => w[0] * pose[v[0]][k] + w[1] * pose[v[1]][k] + w[2] * pose[v[2]][k] + d[k] * scale[k]));
}

/**
 * Whether an asset is CC0 by its own file: a licence line saying so, or the project's statement
 * that it was released as CC0 (2020). Packs listed as CC0 hold files that say otherwise (AGPL3,
 * CC BY) or nothing; those are left out.
 */
export const isCC0 = (asset) => asset.released === true || /^cc[-_ ]?0\b|^cc[-_ ]?zero/i.test((asset.license ?? "").trim());
