const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { createApp } = require('../server/app.cjs');
const { createAuth } = require('../server/auth.cjs');

async function main() {
  const { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } = await import('jose');
  const keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = 'login-regression';
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-login-ui-'));
  const config = {
    storage,
    issuer: 'https://test.cloudflareaccess.com',
    audience: 'login-regression',
    origin: 'https://flux.example.com',
  };
  const token = await new SignJWT({ email: 'login-test@example.com', type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setSubject('login-test')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(keys.privateKey);
  const authenticate = await createAuth(config, createLocalJWKSet({ keys: [jwk] }));
  const navigations = [],
    errors = [];
  const app = await createApp(config, {
    capabilities: { formats: [] },
    auth: async (req) => {
      if (req.url === '/?from=login') navigations.push(req.headers);
      // The mock edge forwards genuine browser metadata and adds a signed
      // synthetic Access assertion. The production authenticator stays in use.
      return authenticate({
        method: req.method,
        url: req.url,
        headers: {
          ...req.headers,
          host: new URL(config.origin).host,
          'cf-access-jwt-assertion': token,
        },
      });
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const identity = http.createServer((req, res) => {
    if (req.url === '/return') {
      res.writeHead(302, { Location: base + '/?from=login' });
      res.end();
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><a href="/return">Return to converter</a>');
    }
  });
  await new Promise((resolve) => identity.listen(0, '127.0.0.1', resolve));
  // localhost and 127.0.0.1 are separate sites, but both are trustworthy local
  // origins. No requests go to a real identity provider or production server.
  const login = 'http://localhost:' + identity.address().port;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.goto(login);
      await page.getByRole('link', { name: 'Return to converter' }).click();
      await page
        .getByText('login-test@example.com', { exact: true })
        .waitFor({ timeout: 10000 })
        .catch(async (error) => {
          console.error(
            JSON.stringify({
              errors,
              metadata: navigations.map((headers) => ({
                site: headers['sec-fetch-site'],
                mode: headers['sec-fetch-mode'],
                dest: headers['sec-fetch-dest'],
              })),
            }),
          );
          console.error(await page.locator('body').innerText());
          throw error;
        });
      assert.equal(page.url(), base + '/?from=login');
      assert(await page.locator('#workspace').isVisible());
    }
    assert.equal(navigations.length, 3);
    for (const headers of navigations) {
      assert.equal(headers['sec-fetch-site'], 'cross-site');
      assert.equal(headers['sec-fetch-mode'], 'navigate');
      assert.equal(headers['sec-fetch-dest'], 'document');
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(
      'Three cross-site login redirects loaded the authenticated workspace without refresh; real JWT verification and browser fetch metadata passed.',
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => identity.close(resolve));
    await app.close();
    await fs.rm(storage, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
