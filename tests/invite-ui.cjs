const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../server/app.cjs');
async function main() {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-invite-ui-'));
  const owner = { id: 'a'.repeat(64), email: 'owner@example.com' },
    guest = { id: 'b'.repeat(64), email: 'guest@example.com' };
  const app = await createApp(
    {
      storage,
      ownerEmail: owner.email,
      origin: 'https://flux.example.com',
      issuer: 'https://test.cloudflareaccess.com',
    },
    {
      auth: async (req) => (req.headers['x-test-owner'] === '1' ? owner : guest),
      capabilities: { formats: [] },
    },
  );
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port,
    browser = await chromium.launch({ headless: true });
  try {
    const ownerContext = await browser.newContext({ extraHTTPHeaders: { 'x-test-owner': '1' } }),
      guestContext = await browser.newContext();
    const admin = await ownerContext.newPage(),
      visitor = await guestContext.newPage();
    await admin.goto(base);
    await admin.getByRole('button', { name: '＋ Invite people' }).click();
    await admin.getByRole('button', { name: 'Create invite link', exact: true }).click();
    await admin.locator('#new-invite').waitFor();
    const link = await admin.locator('#invite-link').inputValue(),
      token = new URL(link).searchParams.get('invite');
    assert.equal(token.length, 43);
    await visitor.goto(base);
    await visitor.locator('#invitation-required').waitFor();
    assert.equal(await visitor.locator('#workspace').isVisible(), false);
    await visitor.goto(base + '/?invite=' + token);
    await visitor.getByText(guest.email, { exact: true }).waitFor();
    await visitor.locator('#workspace').waitFor();
    assert.equal(visitor.url(), base + '/');
    assert.equal(await visitor.locator('#access-nav').isVisible(), false);
    await admin.reload();
    await admin.getByRole('button', { name: '＋ Invite people' }).click();
    const revoked = admin.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' && response.url().includes('/api/members/'),
    );
    await admin.getByRole('button', { name: 'Revoke access', exact: true }).click();
    assert.equal((await revoked).status(), 200);
    await visitor.reload();
    await visitor.locator('#invitation-required').waitFor();
    await visitor.goto(base + '/?invite=' + token);
    await visitor
      .getByText('This invitation is invalid, expired, or already used.', { exact: true })
      .waitFor();
    console.log(
      'Owner invite creation, first-guest claim, hidden owner controls, URL removal and revocation passed.',
    );
  } finally {
    await browser.close();
    await app.close();
    await fs.rm(storage, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
