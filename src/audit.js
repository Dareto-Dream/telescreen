import { actorOf } from './session.js';
import { announce } from './hooks.js';

// Destructive or moderation actions worth a ping; everything still goes to the logs.
const WORTH = new Set(['auth.denied', 'pg.delete', 'redis.del', 'redis.command', 'files.delete', 'content.delete', 'deltatime.shadowban', 'deltatime.unshadowban', 'deltatime.trust', 'journeyman.server_ban', 'journeyman.server_unban', 'journeyman.applicant_ban', 'journeyman.decision']);

// Audit trail goes to stdout as structured JSON so it lands in Railway logs even
// when the databases this thing administers are the ones on fire.
export function audit(request, action, detail = {}) {
  const actor = actorOf(request.session) || detail.email || null;
  if (WORTH.has(action)) announce(action, `${action} by ${actor || 'someone'}`, { Actor: actor, ...detail });
  request.log.info({ audit: true, action, actor: actorOf(request.session) || detail.email || null, ip: request.ip, ...detail }, `audit ${action}`);
}
