import { cleanupTransfers } from "./transfer.js";
export default {
  /** @param {ScheduledController} controller @param {Pick<TransferEnv, "DB">} env */
  async scheduled(controller, env) {
    if (!env.DB) throw new Error("Missing cleanup DB binding");
    const result = await cleanupTransfers(env.DB, controller.scheduledTime);
    console.log(JSON.stringify({ event: "transfer_cleanup", ...result }));
  },
};
