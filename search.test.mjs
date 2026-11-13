import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchSubscription, searchWithinSource } from './search.mjs';

test('search streams source-specific results across live and on-demand media', async () => {
  const config = {
    lives: [{ id: '0', name: '直播源', url: 'https://example.com/list' }],
    sites: [
      { id: '0', name: '站一', kind: 'android', searchable: true },
      { id: '1', name: '站二', kind: 'android', searchable: false },
      { id: '2', name: '站三', kind: 'json', searchable: true },
      { id: '3', kind: 'android', androidApi: 'csp_PanConfigGuard' },
      { id: '4', kind: '' },
    ],
  };
  const events = [];
  let runningAndroid = 0;
  let unblockAndroid;
  const gate = new Promise(resolve => { unblockAndroid = resolve; });
  await searchSubscription(config, { keyword: '测试', signal: new AbortController().signal }, async () => [
    { id: '1', name: '测试直播', lines: [{}] },
    { id: '2', name: '其他频道', lines: [{}] },
  ], event => {
    events.push(event);
    if (event.live) unblockAndroid();
  }, async (site, query) => {
    if (site.id === '2') throw new Error('fixture failure');
    assert.equal(++runningAndroid, 1);
    await gate;
    runningAndroid--;
    assert.equal(query.search, site.searchable ? '测试' : '');
    return { items: [{ id: '1', title: '测试' }, ...(site.searchable ? [] : [{ id: '2', title: '其他' }])] };
  });

  assert.deepEqual(events[0], { type: 'start', total: 4 });
  assert.deepEqual(events.at(-1), { type: 'done' });
  const batches = events.filter(event => event.type === 'source');
  const liveIndex = batches.findIndex(batch => batch.live);
  assert.equal(batches[liveIndex].items[0].lineCount, 1);
  assert(liveIndex < batches.findIndex(batch => !batch.live && !batch.failed));
  const vod = batches.filter(batch => !batch.live);
  assert.deepEqual(vod.filter(batch => !batch.failed).map(batch => [batch.source.id, batch.items.map(item => item.id)]), [
    ['0', ['1']], ['1', ['1']],
  ]);
  assert.equal(vod.find(batch => batch.source.id === '1').homepage, true);
  assert.equal(vod.find(batch => batch.source.id === '2').failed, true);
});

test('canceling a search stops the Android queue after its active job', async () => {
  const controller = new AbortController();
  const calls = [];
  const events = [];
  const config = { lives: [], sites: ['first', 'second'].map(id => ({ id, kind: 'android', searchable: true })) };
  await searchSubscription(config, { keyword: '测试', signal: controller.signal }, undefined, event => {
    events.push(event.type);
  }, async source => {
    calls.push(source.id);
    controller.abort();
    return { items: [] };
  });
  assert.deepEqual(calls, ['first']);
  assert.deepEqual(events, ['start']);
});

test('a scoped search uses only the selected source and reads its native search pages', async () => {
  const source = { id: 'second', name: '站二', searchable: true };
  const config = { sites: [{ id: 'first' }, source], lives: [] };
  const pages = [];
  const events = [];
  await searchWithinSource(config, { source, live: false, keyword: '测试', signal: new AbortController().signal },
    undefined, event => events.push(event), async (site, query) => {
      assert.equal(site, source);
      assert.equal(query.search, '测试');
      pages.push(query.page);
      return { items: [{ id: String(query.page), title: '测试' }], more: query.page < 2 };
    });
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(events.filter(event => event.type === 'page').map(event => [event.source.id, event.scope, event.items[0].id]), [
    ['second', 'search', '1'], ['second', 'search', '2'],
  ]);
  assert.equal(events.at(-1).type, 'done');
});

test('a browse-only source matches titles in later category pages and stops repeated pages', async () => {
  const source = { id: '1', name: '分类片源', searchable: false };
  const checked = [];
  const events = [];
  await searchWithinSource({}, { source, live: false, keyword: '测试', signal: new AbortController().signal },
    undefined, event => events.push(event), async (site, query) => {
      assert.equal(site, source);
      assert.equal(query.search, undefined);
      checked.push([query.category, query.page]);
      if (!query.category) return { items: [], categories: [{ id: 'a' }, { id: 'b' }] };
      if (query.category === 'a' && query.page > 1) {
        return { items: [{ id: 'match', title: '分类中的测试' }], more: true };
      }
      return { items: [{ id: 'other', title: '其他内容' }], more: query.category === 'a' };
    });
  assert.deepEqual(checked, [[undefined, 1], ['a', 1], ['b', 1], ['a', 2], ['a', 3]]);
  const matches = events.filter(event => event.items?.length);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].scope, 'catalog');
  assert.equal(matches[0].items[0].id, 'match');
});

test('a scoped live search checks only the selected playlist', async () => {
  const source = { id: '0', name: '直播源' };
  const events = [];
  await searchWithinSource({}, { source, live: true, keyword: '中央', signal: new AbortController().signal },
    async (config, id) => {
      assert.equal(id, '0');
      return [{ id: 'yes', name: '中央电视台', lines: [{}] }, { id: 'no', name: '地方台', lines: [{}] }];
    }, event => events.push(event));
  assert.deepEqual(events[1].items.map(item => item.id), ['yes']);
  assert.equal(events[1].scope, 'channels');
});
