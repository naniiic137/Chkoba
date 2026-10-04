// Which browser pages may create rooms and open game sockets. Shared by the Cloudflare
// Worker (worker/index.js) and the local server (server.js).
//   - no Origin header: not a browser page (curl, a test, a same-origin navigation)
//   - the server's own origin
//   - localhost / 127.0.0.1 on any port, for local development
//   - an https page whose host is, or is a subdomain of, a host in ALLOWED_HOSTS
//     (comma-separated, for example "chkobba.pages.dev")

function parseHosts(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function originAllowed(origin, selfOrigin, allowedHosts) {
  if (!origin) return true;
  if (selfOrigin && origin === selfOrigin) return true;
  let url;
  try { url = new URL(origin); } catch (e) { return false; }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') return true;
  if (url.protocol !== 'https:') return false;
  return parseHosts(allowedHosts).some((h) => host === h || host.endsWith('.' + h));
}

// CORS headers for an allowed API response: echo the page's origin, never "*".
function corsHeaders(origin) {
  const h = { Vary: 'Origin' };
  if (origin) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

module.exports = { originAllowed, parseHosts, corsHeaders };
