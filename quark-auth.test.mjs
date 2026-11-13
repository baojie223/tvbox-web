import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearQuarkAccount, createQuarkLogin, pollQuarkLogin, quarkAccount } from './quark-auth.mjs';

test('Quark scan confirms once and keeps account credentials server-side', async t => {
  let approved = false;
  let exchanges = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.pathname.endsWith('getTokenForQrcodeLogin')) {
      return Response.json({ status: 2000000, data: { members: { token: 'qr-fixture' } } });
    }
    if (url.pathname.endsWith('getServiceTicketByQrcodeToken')) {
      assert.equal(url.searchParams.get('token'), 'qr-fixture');
      return Response.json(approved
        ? { status: 2000000, data: { members: { service_ticket: 'ticket-fixture' } } }
        : { status: 50004001 });
    }
    if (url.pathname === '/desktop/account/login') {
      exchanges++;
      assert.equal(url.searchParams.get('st'), 'ticket-fixture');
      return Response.json({ data: { pus: 'auth-fixture', uid: '1234' } });
    }
    assert.equal(url.pathname, '/1/clouddrive/auth/pc/flush');
    assert.equal(options.headers.cookie, '__pus=auth-fixture; __uid=1234');
    return Response.json({ code: 0 }, { headers: { 'Set-Cookie': '__kps=session-fixture; Domain=quark.cn; Path=/' } });
  });
  t.after(() => clearQuarkAccount());
  const login = await createQuarkLogin();
  assert.deepEqual(Object.keys(login), ['id', 'qr']);
  assert.match(login.qr, /^data:image\/png;base64,/);
  assert.deepEqual(await pollQuarkLogin(login.id), { state: 'waiting' });
  approved = true;
  const [first, second] = await Promise.all([pollQuarkLogin(login.id), pollQuarkLogin(login.id)]);
  assert.deepEqual(first, { state: 'logged-in' });
  assert.deepEqual(second, first);
  assert.equal(exchanges, 1);
  const { id, cookie } = quarkAccount();
  assert.match(cookie, /__kps=session-fixture/);
  await clearQuarkAccount();
  assert.equal(quarkAccount(id), undefined);
});
