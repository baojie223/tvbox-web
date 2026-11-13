import assert from 'node:assert/strict';
import { mkdtemp, readFile, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadQuarkSession, removeQuarkSession, saveQuarkSession } from './quark-store.mjs';

test('Windows protects saved Quark sessions and logout removes the saved copy', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tvbox-quark-test-'));
  const file = join(directory, 'session.dpapi');
  t.after(async () => {
    await removeQuarkSession(file);
    await rmdir(directory);
  });
  assert.equal(await loadQuarkSession(file), undefined);
  const session = { id: 'test-session', cookie: '__pus=quark-fixture-secret; __uid=1' };
  await saveQuarkSession(session, file);
  const encrypted = await readFile(file);
  assert(!encrypted.includes(session.cookie));
  assert.deepEqual(await loadQuarkSession(file), session);
  const newer = { id: 'newer-session', cookie: '__pus=another-fixture; __uid=2' };
  await saveQuarkSession(newer, file);
  assert.deepEqual(await loadQuarkSession(file), newer);
  await removeQuarkSession(file);
  assert.equal(await loadQuarkSession(file), undefined);
});
