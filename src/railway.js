import { z } from 'zod';
import { requireOwner } from './auth.js';
import { config } from './config.js';
import { audit } from './audit.js';

const ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const enabled = () => Boolean(config.railway.projectToken || config.railway.apiToken);

async function gql(query, variables = {}) {
  const headers = { 'Content-Type': 'application/json' };
  // Project tokens use their own header; account/workspace tokens are Bearer.
  if (config.railway.projectToken) headers['Project-Access-Token'] = config.railway.projectToken;
  else headers.Authorization = `Bearer ${config.railway.apiToken}`;
  const response = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) {
    const e = new Error(`Railway: ${body.errors?.[0]?.message || `HTTP ${response.status}`}`); e.statusCode = 502; throw e;
  }
  return body.data;
}

let scope = null;
async function target() {
  if (scope) return scope;
  let { projectId, environmentId } = config.railway;
  if (config.railway.projectToken && (!projectId || !environmentId)) {
    const data = await gql('query { projectToken { projectId environmentId } }');
    projectId ||= data.projectToken.projectId; environmentId ||= data.projectToken.environmentId;
  }
  if (!projectId || !environmentId) { const e = new Error('Set TELESCREEN_RAILWAY_PROJECT_ID and TELESCREEN_RAILWAY_ENVIRONMENT_ID'); e.statusCode = 503; throw e; }
  scope = { projectId, environmentId };
  return scope;
}

// Cache the overview briefly; Hobby plans get 1000 API calls an hour and each
// refresh costs one call per service.
let cached = { at: 0, data: null };

async function overview(force) {
  if (!force && cached.data && Date.now() - cached.at < 15_000) return cached.data;
  const { projectId, environmentId } = await target();
  const { project } = await gql(`query($id: String!) { project(id: $id) { id name
    environments { edges { node { id name } } }
    services { edges { node { id name icon } } } } }`, { id: projectId });
  const services = await Promise.all(project.services.edges.map(async ({ node }) => {
    const data = await gql(`query($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { id status createdAt staticUrl url canRedeploy } } } }`,
      { input: { projectId, environmentId, serviceId: node.id } });
    return { ...node, deployment: data.deployments.edges[0]?.node || null };
  }));
  const environment = project.environments.edges.map(e => e.node).find(e => e.id === environmentId);
  const data = { project: { id: project.id, name: project.name }, environment: environment || { id: environmentId, name: '?' }, services: services.sort((a, b) => a.name.localeCompare(b.name)) };
  cached = { at: Date.now(), data };
  return data;
}

// Never act on a deployment id from the browser without confirming it's ours.
async function ownDeployment(id) {
  const { projectId, environmentId } = await target();
  const { deployment } = await gql('query($id: String!) { deployment(id: $id) { id projectId environmentId serviceId status } }', { id });
  if (!deployment || deployment.projectId !== projectId || deployment.environmentId !== environmentId) { const e = new Error('Deployment not in this project'); e.statusCode = 404; throw e; }
  return deployment;
}

const deploymentId = z.object({ id: z.string().min(1).max(100) });
const ACTIONS = {
  restart: 'mutation($id: String!) { deploymentRestart(id: $id) }',
  redeploy: 'mutation($id: String!) { deploymentRedeploy(id: $id) { id status } }',
  stop: 'mutation($id: String!) { deploymentStop(id: $id) }',
};

export async function railwayRoutes(app) {
  app.get('/api/railway', async request => {
    if (!enabled()) return { enabled: false };
    return { enabled: true, ...await overview(request.query?.fresh === '1') };
  });

  app.get('/api/railway/logs', async request => {
    const q = deploymentId.extend({ kind: z.enum(['deploy', 'build', 'http']).default('deploy'), limit: z.coerce.number().int().min(10).max(1000).default(300), filter: z.string().max(200).optional() }).parse(request.query);
    await ownDeployment(q.id);
    if (q.kind === 'http') {
      const { httpLogs } = await gql('query($id: String!, $limit: Int) { httpLogs(deploymentId: $id, limit: $limit) { timestamp method path httpStatus totalDuration srcIp } }', { id: q.id, limit: q.limit });
      return { lines: httpLogs.map(l => ({ timestamp: l.timestamp, severity: l.httpStatus >= 500 ? 'error' : l.httpStatus >= 400 ? 'warn' : 'info', message: `${l.httpStatus} ${l.method} ${l.path} ${l.totalDuration}ms ${l.srcIp || ''}` })) };
    }
    const field = q.kind === 'build' ? 'buildLogs' : 'deploymentLogs';
    const data = await gql(`query($id: String!, $limit: Int${q.kind === 'deploy' ? ', $filter: String' : ''}) { ${field}(deploymentId: $id, limit: $limit${q.kind === 'deploy' ? ', filter: $filter' : ''}) { timestamp message severity } }`, { id: q.id, limit: q.limit, ...(q.kind === 'deploy' ? { filter: q.filter || null } : {}) });
    return { lines: data[field] };
  });

  app.post('/api/railway/deployment/:action', async request => {
    requireOwner(request);
    const action = z.enum(Object.keys(ACTIONS)).parse(request.params.action);
    const { id } = deploymentId.parse(request.body);
    const deployment = await ownDeployment(id);
    audit(request, `railway.${action}`, { deployment: id, service: deployment.serviceId });
    const data = await gql(ACTIONS[action], { id });
    cached.at = 0;
    return { ok: true, data };
  });
}
