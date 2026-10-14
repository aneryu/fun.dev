import { handleTransfer } from "../../server/transfer.js";
export function onRequest(context) {
  return handleTransfer(context.request, context.env);
}
