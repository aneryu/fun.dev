import { EmailMessage } from "cloudflare:email";
import { FROM, check, mime } from "./uptime.js";

// Scheduled entry of the uptime monitor (server/uptime.js, docs/edge.md).
export default {
  /** @param {ScheduledController} controller */
  async scheduled(controller, env) {
    const alert = await check({ kv: env.STATE, now: controller.scheduledTime });
    console.log(JSON.stringify({ event: "uptime", alert: alert?.subject ?? null }));
    if (alert) await env.ALERT.send(new EmailMessage(FROM, env.ALERT_TO, mime(alert, env.ALERT_TO, controller.scheduledTime)));
  },
};
