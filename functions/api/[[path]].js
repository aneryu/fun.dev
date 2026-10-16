import { handleTransfer } from "../../server/transfer.js";
import { handleModelUpload } from "../../server/models.js";
export function onRequest(context) {
  if (new URL(context.request.url).pathname.startsWith("/api/models/")) return handleModelUpload(context.request, context.env);
  return handleTransfer(context.request, context.env);
}
