import { actorOf } from './session.js';

// Audit trail goes to stdout as structured JSON so it lands in Railway logs even
// when the databases this thing administers are the ones on fire.
export function audit(request, action, detail = {}) {
  request.log.info({ audit: true, action, actor: actorOf(request.session) || detail.email || null, ip: request.ip, ...detail }, `audit ${action}`);
}
