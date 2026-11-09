// Tricount relay: GET /registry?id=<public identifier token>
// Talks to Tricount's (unofficial, bunq-era) API and returns the registry JSON
// with CORS headers for ALLOWED_ORIGIN only.

const API = 'https://api.tricount.bunq.com';
const UA = 'com.bunq.tricount.android:RELEASE:7.0.7:3174:ANDROID:13:C';
const APP_VERSION = '5.0.8';
const TOKEN_RE = /^[A-Za-z0-9]{6,64}$/;
const CACHE_SECONDS = 60;
const NOT_FOUND_CACHE_SECONDS = 600;
const NOT_FOUND = '__tricountNotFound';

// Per-isolate session cache; re-created when the isolate is recycled or on 401.
let session = null; // { token, userId }

function apiHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    'app-version': APP_VERSION,
    'X-Bunq-Client-Request-Id': crypto.randomUUID(),
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function publicKeyPem() {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  let bin = '';
  for (const b of spki) bin += String.fromCharCode(b);
  const b64 = btoa(bin).match(/.{1,64}/g).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

async function createSession() {
  const res = await fetch(`${API}/v1/session-registry-installation`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      app_installation_uuid: crypto.randomUUID(),
      client_public_key: await publicKeyPem(),
      device_description: 'Android',
    }),
  });
  if (!res.ok) throw new HttpError(502, `Tricount session failed (${res.status})`);
  const body = await res.json();
  const items = body.Response || [];
  const token = items.find((x) => x.Token)?.Token?.token;
  const userId = items.find((x) => x.UserPerson)?.UserPerson?.id;
  if (!token || !userId) throw new HttpError(502, 'Unexpected Tricount session response');
  session = { token, userId };
  return session;
}

async function fetchRegistry(id, retry = true) {
  const s = session || (await createSession());
  const res = await fetch(
    `${API}/v1/user/${s.userId}/registry?public_identifier_token=${encodeURIComponent(id)}`,
    { headers: apiHeaders({ 'X-Bunq-Client-Authentication': s.token }) },
  );
  if ((res.status === 401 || res.status === 403) && retry) {
    session = null;
    return fetchRegistry(id, false);
  }
  if (res.status === 404) throw new HttpError(404, 'Tricount not found');
  if (!res.ok) throw new HttpError(502, `Tricount registry failed (${res.status})`);
  const body = await res.json();
  const items = body.Response || [];
  // An unknown token comes back as 200 with an empty list.
  if (items.length === 0) throw new HttpError(404, 'Tricount not found');
  const registry = items.map((x) => x.Registry).find(Boolean);
  if (!registry) throw new HttpError(502, 'Unexpected Tricount registry response');
  return strip(registry);
}

// Drop fields the viewer doesn't need that can hold contact details or card ids
// (alias.pointer is an email/phone for members with a bunq account).
const STRIP_KEYS = new Set(['pointer', 'setting', 'card_ids', 'card_labels']);
function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!STRIP_KEYS.has(k)) o[k] = strip(x);
    return o;
  }
  return v;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function corsHeaders(env, origin) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = { Vary: 'Origin' };
  if (allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
  }
  return h;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(env, origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' || url.pathname !== '/registry') return json({ error: 'Not found' }, 404, cors);
    // Only answer the configured site(s), so this is not an open relay.
    if (!cors['Access-Control-Allow-Origin']) return json({ error: 'Origin not allowed' }, 403, cors);

    const id = url.searchParams.get('id') || '';
    if (!TOKEN_RE.test(id)) return json({ error: 'Invalid tricount id' }, 400, cors);

    // Per-IP limit (RATE_LIMITER binding in wrangler.toml); skipped if the binding is absent.
    if (env.RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: 'Too many requests, try again in a minute' }, 429, { ...cors, 'Retry-After': '60' });
    }

    const cacheKey = new Request(`https://cache.local/registry/${id}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.json();
      if (body && body[NOT_FOUND]) return json({ error: 'Tricount not found' }, 404, { ...cors, 'X-Cache': 'HIT' });
      return json(body, 200, { ...cors, 'X-Cache': 'HIT' });
    }

    try {
      const registry = await fetchRegistry(id);
      ctx.waitUntil(cache.put(cacheKey, json(registry, 200, { 'Cache-Control': `max-age=${CACHE_SECONDS}` })));
      return json(registry, 200, cors);
    } catch (e) {
      // Cache "not found" too, so requests for made-up ids don't each reach Tricount.
      if (e.status === 404) {
        ctx.waitUntil(cache.put(cacheKey, json({ [NOT_FOUND]: true }, 200, { 'Cache-Control': `max-age=${NOT_FOUND_CACHE_SECONDS}` })));
      }
      return json({ error: e.message || 'Relay error' }, e.status || 500, cors);
    }
  },
};
