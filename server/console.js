import { approveVersion, approveVersions, editModel, errorResponse, getModel, ID, json, listVersions, ModelError, rejectVersion, routeUpload, typeOf, VERSION } from "./models.js";

// console.fun.dev (docs/models.md): the review console. Cloudflare Access guards the whole host;
// every request is checked here again against the Access JWT, so a misconfigured Access
// application cannot expose it. Static files come from the ASSETS binding (console/).
const decoder = new TextDecoder();
const base64url = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
let keys = { team: null, at: 0, list: [] };

async function accessKeys(env) {
  if (env.ACCESS_CERTS) return JSON.parse(env.ACCESS_CERTS).keys;
  if (keys.team === env.ACCESS_TEAM && Date.now() - keys.at < 3600000) return keys.list;
  const response = await fetch(`https://${env.ACCESS_TEAM}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access certs: HTTP ${response.status}`);
  keys = { team: env.ACCESS_TEAM, at: Date.now(), list: (await response.json()).keys };
  return keys.list;
}

/** Returns the signed-in email, or null. */
export async function verifyAccess(request, env) {
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD || !env.CONSOLE_EMAIL) return null;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  const parts = token?.split(".");
  if (parts?.length !== 3) return null;
  try {
    const header = JSON.parse(decoder.decode(base64url(parts[0]))), claims = JSON.parse(decoder.decode(base64url(parts[1])));
    const jwk = (await accessKeys(env)).find((key) => key.kid === header.kid);
    if (header.alg !== "RS256" || !jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    const audience = [claims.aud].flat();
    const now = Date.now() / 1000;
    if (!valid || !audience.includes(env.ACCESS_AUD) || claims.iss !== `https://${env.ACCESS_TEAM}` || !(claims.exp > now) || (claims.nbf && claims.nbf > now + 60)) return null;
    return typeof claims.email === "string" && claims.email.toLowerCase() === env.CONSOLE_EMAIL.toLowerCase() ? claims.email : null;
  } catch {
    return null;
  }
}

async function readJSON(request) {
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") throw new ModelError("json_required", 415);
  const text = await request.text();
  if (text.length > 64 * 1024) throw new ModelError("too_large", 413);
  try { const data = JSON.parse(text); if (data && typeof data === "object" && !Array.isArray(data)) return data; } catch { /* below */ }
  throw new ModelError("invalid_request");
}

export default {
  /** @param {Request} request */
  async fetch(request, env) {
    const email = await verifyAccess(request, env);
    if (!email) return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
    const url = new URL(request.url), path = url.pathname;
    if (!path.startsWith("/api/") && !path.startsWith("/files/")) return env.ASSETS.fetch(request);
    try {
      if (path.startsWith("/files/")) {
        const [id, version, file] = path.split("/").slice(2).map(decodeURIComponent);
        if (request.method !== "GET" || !file || path.split("/").length !== 5 || !ID.test(id) || !VERSION.test(version)) throw new ModelError("not_found", 404);
        const object = await env.MODELS_SOURCES.get(`models/${id}/${version}/${file}`);
        if (!object) throw new ModelError("not_found", 404);
        return new Response(object.body, { headers: { "Content-Type": typeOf(file), "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } });
      }
      // State changes need a same-origin JSON request with this header, which a cross-site form cannot send.
      if (request.method !== "GET" && (request.headers.get("X-Fun-Console") !== "1" || request.headers.get("Sec-Fetch-Site") === "cross-site")) throw new ModelError("origin_denied", 403);
      if (path === "/api/session" && request.method === "GET") return json({ email });
      if (path === "/api/versions" && request.method === "GET") {
        const status = url.searchParams.get("status") ?? "pending";
        if (!["pending", "rejected", "approved", "incomplete", "all"].includes(status)) throw new ModelError("invalid_request");
        return json({ versions: await listVersions(env.MODELS_DB, status) });
      }
      // Uploads from the console page, signed in through Access: the same routes as api.fun.dev.
      if (path.startsWith("/api/upload/")) {
        try { return await routeUpload(request, env, path.slice("/api/upload".length)); }
        // The page asks before uploading; a version not seen yet is not an error there.
        catch (error) { if (request.method === "GET" && error.code === "not_found") return json({ status: "new", note: null, files: {}, stats: null }); throw error; }
      }
      // Several pending versions at once; the page sends small batches and asks for the catalog last.
      if (path === "/api/approve" && request.method === "POST") {
        const { versions = [], catalog = true } = await readJSON(request);
        return json(await approveVersions(env, versions, { catalog: catalog === true }));
      }
      // /api/models/<id> (GET, PATCH) and /api/models/<id>/<version>/(approve|reject) (POST)
      const segments = path.split("/").slice(3).map(decodeURIComponent);
      const [id, version, action] = segments;
      if (!path.startsWith("/api/models/") || !id || id.length > 64 || !ID.test(id)) throw new ModelError("not_found", 404);
      if (segments.length === 1 && request.method === "GET") return json(await getModel(env.MODELS_DB, id));
      if (segments.length === 1 && request.method === "PATCH") return json(await editModel(env, id, await readJSON(request)));
      if (segments.length === 3 && VERSION.test(version) && request.method === "POST") {
        if (action === "approve") { await approveVersion(env, id, version); return json(await getModel(env.MODELS_DB, id)); }
        if (action === "reject") { await rejectVersion(env.MODELS_DB, id, version, (await readJSON(request)).note ?? ""); return json(await getModel(env.MODELS_DB, id)); }
      }
      throw new ModelError("not_found", 404);
    } catch (error) {
      return errorResponse(error, "Console failure");
    }
  },
};
