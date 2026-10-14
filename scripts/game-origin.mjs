export function gameOrigin(value = "") {
  if (!value) return "";
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname) || url.hostname.endsWith(".localhost")) {
    throw new Error("FUNDEV_GAME_ORIGIN must be a public HTTPS origin without path, credentials or port.");
  }
  return url.origin;
}
