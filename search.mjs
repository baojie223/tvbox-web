import { supportsAndroidAccountConfig } from './android-spider.mjs';
import { readCatalog } from './sources.mjs';

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase();
}

export function mediaSearchSources(config) {
  return [
    ...config.lives.filter(source => source.url).map(source => ({ source, live: true })),
    ...config.sites.filter(site => site.kind && !supportsAndroidAccountConfig(site)).map(source => ({ source, live: false })),
  ];
}

function batch(source, live, type = 'source') {
  return { type, live, source: { id: source.id, name: source.name } };
}

async function matchingChannels(config, source, term, channelsFor) {
  const channels = await channelsFor(config, source.id);
  return channels.filter(channel => normalized(channel.name).includes(term))
    .map(({ id, name, logo, group, lines }) => ({ id, name, logo, group, lineCount: lines.length }));
}

export async function searchSubscription(config, { keyword, signal }, channelsFor, emit, catalog = readCatalog) {
  const sources = mediaSearchSources(config);
  const term = normalized(keyword);
  await emit({ type: 'start', total: sources.length });

  async function searchSource({ source, live }) {
    const base = batch(source, live);
    try {
      if (live) {
        return { ...base, items: await matchingChannels(config, source, term, channelsFor) };
      }
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
      const result = await catalog(source, { search: source.searchable ? keyword : '', page: 1 }, timeout);
      const homepage = !source.searchable || result.searchScope === 'home';
      const items = homepage ? result.items.filter(item => normalized(item.title).includes(term)) : result.items;
      return { ...base, items, homepage };
    } catch {
      return { ...base, items: [], failed: true };
    }
  }

  async function worker(queue) {
    while (!signal.aborted && queue.length) {
      const result = await searchSource(queue.shift());
      if (!signal.aborted) await emit(result);
    }
  }

  // FongMi shares one crawler runtime. Submit one job at a time so playback can join the queue.
  const android = sources.filter(({ source }) => source.kind === 'android');
  const other = sources.filter(({ source }) => source.kind !== 'android');
  await Promise.all([worker(android), ...Array.from({ length: Math.min(4, other.length) }, () => worker(other))]);
  if (!signal.aborted) await emit({ type: 'done' });
}

export async function searchWithinSource(config, { source, live, keyword, signal }, channelsFor, emit, catalog = readCatalog) {
  const base = batch(source, live, 'page');
  const term = normalized(keyword);
  const seen = new Set();
  await emit({ type: 'start', total: 1 });

  async function publish(items, scope, failed = false) {
    if (signal.aborted) return;
    const fresh = items.filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    await emit({ ...base, items: fresh, scope, failed });
  }

  async function readPage(query) {
    if (signal.aborted) return null;
    try {
      return await catalog(source, query, AbortSignal.any([signal, AbortSignal.timeout(45_000)]));
    } catch {
      return null;
    }
  }

  if (live) {
    let items;
    try { items = await matchingChannels(config, source, term, channelsFor); } catch {}
    await publish(items ?? [], 'channels', !items);
  } else {
    const first = source.searchable ? await readPage({ search: keyword, page: 1 }) : null;
    if (first?.items.length && first.searchScope !== 'home') {
      let page = 1;
      let result = first;
      while (!signal.aborted && result) {
        const before = seen.size;
        await publish(result.items, 'search');
        if (!result.more || seen.size === before) break;
        result = await readPage({ search: keyword, page: ++page });
        if (!result) await publish([], 'search', true);
      }
    } else {
      const matches = items => items.filter(item => normalized(item.title).includes(term));
      if (first?.items.length) await publish(matches(first.items), 'home');
      const home = await readPage({ page: 1 });
      await publish(home ? matches(home.items) : [], 'catalog', !home);
      // Check every category's first page before moving deeper into any category.
      const queue = (home?.categories ?? []).map(category => ({ category: category.id, page: 1, ids: new Set() }));
      if (!queue.length && home?.more) {
        queue.push({ page: 2, ids: new Set(home.items.map(item => item.id)) });
      }
      while (!signal.aborted && queue.length) {
        const next = queue.shift();
        const result = await readPage({ category: next.category, page: next.page });
        await publish(result ? matches(result.items) : [], 'catalog', !result);
        if (!result?.more || !result.items.some(item => !next.ids.has(item.id))) continue;
        for (const item of result.items) next.ids.add(item.id);
        queue.push({ ...next, page: next.page + 1 });
      }
    }
  }
  if (!signal.aborted) await emit({ type: 'done' });
}
