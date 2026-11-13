import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAndroidCatalog, readAndroidEpisode } from './android-spider.mjs';

test('search checks the homepage when the crawler returns no matches', async () => {
  const calls = [];
  const result = await readAndroidCatalog({}, { page: 1, search: '嫁金钗' }, async method => {
    calls.push(method);
    if (method === 'searchContent') return { list: [] };
    if (method === 'homeContent') return { class: [{ type_id: '1', type_name: '剧集' }] };
    return { list: [{ vod_id: '1', vod_name: '嫁金钗' }, { vod_id: '2', vod_name: '其他影片' }], pagecount: 6 };
  });
  assert.deepEqual(calls, ['searchContent', 'homeContent', 'categoryContent']);
  assert.deepEqual(result.items.map(item => item.title), ['嫁金钗']);
  assert.equal(result.searchScope, 'home');
  assert.equal(result.more, false);
});

test('search preserves the crawler results and pagination', async () => {
  const result = await readAndroidCatalog({}, { page: 2, search: '嫁金钗' }, async (method, args) => {
    assert.equal(method, 'searchContent');
    assert.deepEqual(args, ['嫁金钗', false, '2']);
    return { list: [{ vod_id: '1', vod_name: '嫁金钗' }], pagecount: 4 };
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.searchScope, undefined);
  assert.equal(result.more, true);
});

test('playback reports a recognized cloud authorization failure without returning raw diagnostics', async () => {
  const episode = Buffer.from(JSON.stringify(['115原画', 'episode-1'])).toString('base64url');
  const raw = { list: [], msg: '115 Cookie 未配置或已失效 Cookie=private-fixture', parse: 0 };
  await assert.rejects(readAndroidEpisode({}, episode, async () => raw), {
    message: '115 网盘的登录授权缺失或已失效，请在配置中心更新授权后重试。',
    action: 'account-config',
  });
});

test('playback distinguishes an upstream HTTP error from authorization failure', async () => {
  const episode = Buffer.from(JSON.stringify(['夸克原画', 'episode-1'])).toString('base64url');
  await assert.rejects(readAndroidEpisode({}, episode, async () => ({
    msg: '[quark](download) 夸克接口异常：HTTP 404',
  })), {
    message: '夸克网盘接口返回 HTTP 404，未生成播放地址。',
  });
});
