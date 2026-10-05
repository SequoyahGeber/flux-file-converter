const crypto = require('node:crypto');
const { fail } = require('./security.cjs');
async function createAuth(config, keySet) {
  const { createRemoteJWKSet, jwtVerify } = await import('jose');
  if (
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(config.issuer || '') ||
    !config.audience ||
    !/^https:\/\/[a-z0-9.-]+$/.test(config.origin || '')
  )
    throw new Error(
      'Cloudflare Access issuer, application audience, and HTTPS origin are required.',
    );
  const keys =
    keySet ||
    createRemoteJWKSet(new URL(config.issuer + '/cdn-cgi/access/certs'), {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
    });
  return async (req) => {
    // Never trust the email header alone, a proxy IP, or an unsigned decoded token.
    const token = req.headers['cf-access-jwt-assertion'];
    if (typeof token !== 'string' || token.length > 16000)
      throw fail('Sign in through Cloudflare Access.', 401);
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['RS256'],
        clockTolerance: 5,
        // Match the month-long Access session while still enforcing any shorter
        // signed expiry issued by Cloudflare.
        maxTokenAge: '30d',
        requiredClaims: ['exp'],
      }));
    } catch {
      throw fail('Your login has expired or is invalid. Sign in again.', 401);
    }
    if (
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.email !== 'string' ||
      !payload.email ||
      payload.type !== 'app'
    )
      throw fail('A signed-in user account is required.', 401);
    if (req.headers.host !== new URL(config.origin).host)
      throw fail('Invalid application host.', 403);
    if (
      !['GET', 'HEAD'].includes(req.method) &&
      (req.headers.origin !== config.origin || req.headers['x-flux-request'] !== '1')
    )
      throw fail('This request must come from the converter page.', 403);
    // Login redirects can retain cross-site metadata for the final navigation.
    // Permit only the static landing document after token and host validation;
    // API reads, writes and embedded/subresource requests remain isolated.
    const landingNavigation =
      req.method === 'GET' &&
      (req.url === '/' || req.url?.startsWith('/?')) &&
      req.headers['sec-fetch-mode'] === 'navigate' &&
      req.headers['sec-fetch-dest'] === 'document';
    if (req.headers['sec-fetch-site'] === 'cross-site' && !landingNavigation)
      throw fail('Cross-site requests are blocked.', 403);
    return {
      id: crypto
        .createHash('sha256')
        .update(payload.iss + ':' + payload.sub)
        .digest('hex'),
      email: payload.email,
    };
  };
}
module.exports = { createAuth };
