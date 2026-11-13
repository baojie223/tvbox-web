import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { androidSpiderEnabled, readAndroidCatalog, readAndroidDetail, readAndroidEpisode, withAndroidSpider } from './android-spider.mjs';
import { playback, sendMedia } from './media.mjs';
import { bridgeSubscriptions, playbackHeaders, readConfig } from './sources.mjs';

const base = new URL(`http://127.0.0.1:${process.env.TVBOX_AUDIT_PORT || 4382}/`);
const filter = new RegExp(process.env.TVBOX_AUDIT_FILTER || '');
const subscriptionFilter = process.env.TVBOX_AUDIT_SUBSCRIPTION;
const reportPath = process.argv[2];
const timeout = Number(process.env.TVBOX_AUDIT_TIMEOUT || 48_000);
const deep = process.env.TVBOX_AUDIT_DEEP === '1';

const mediaServer = createServer((req, res) => {
  sendMedia(req.url.slice(7), req, res).catch(() => {
    if (res.headersSent) res.destroy();
    else if (!res.destroyed) res.writeHead(502).end();
  });
});
await new Promise(resolve => mediaServer.listen(0, '127.0.0.1', resolve));
const androidMediaBase = new URL(`http://127.0.0.1:${mediaServer.address().port}/`);
mediaServer.unref();

async function json(path, params = {}, init = {}) {
  const url = new URL(path, base);
  url.search = new URLSearchParams(params);
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function probeMedia(path, origin, depth = 0) {
  if (depth > 4 || !path.startsWith('/media/')) throw new Error('媒体清单没有可验证的地址。');
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`媒体 HTTP ${response.status}`);
  const stream = response.body.getReader();
  try {
    const first = Buffer.from((await stream.read()).value ?? []);
    if (first.subarray(0, 32).toString().trimStart().startsWith('#EXTM3U')) {
      let manifest = first.toString();
      while (manifest.length < 2 * 1024 * 1024) {
        const { value, done } = await stream.read();
        if (done) break;
        manifest += Buffer.from(value).toString();
      }
      const child = manifest.split(/\r?\n/).find(line => line.startsWith('/media/') && line !== '/media/unavailable');
      if (!child) throw new Error('HLS 清单没有视频分片。');
      await probeMedia(child, origin, depth + 1);
      return 'HLS';
    }
    const type = response.headers.get('content-type') ?? '';
    if (first.length >= 16 && (/^(?:audio|video)\//.test(type) || first[0] === 0x47 || ['ftyp', 'moof', 'styp'].includes(first.subarray(4, 8).toString()))) {
      return type.startsWith('audio/') ? '音频' : '媒体字节';
    }
    throw new Error('媒体响应未识别为音视频。');
  } finally {
    await stream.cancel().catch(() => {});
  }
}

async function mediaOptions(lines, params, resolveEpisode, origin = base) {
  let issue = '详情未提供可播放的分集。';
  for (const line of (lines ?? []).slice(0, deep ? 3 : 2)) {
    for (const episode of line.episodes.slice(0, deep ? 2 : 1)) {
      try {
        const media = episode.id ? await (resolveEpisode?.(episode.id) ?? json('/api/play', { ...params, episode: episode.id })) : episode;
        return { episode: episode.name, format: await probeMedia(media.url, origin) };
      } catch (error) { issue = error.message; }
    }
  }
  throw new Error(issue);
}

async function checkVod(site, params, row, android, call) {
  const loadCatalog = query => call ? readAndroidCatalog(android, { page: 1, ...query }, call) : json('/api/catalog', { ...params, ...query });
  let catalogIssue;
  const browse = async query => {
    try { return await loadCatalog(query); }
    catch (error) {
      catalogIssue ??= error;
      return { items: [], categories: [] };
    }
  };
  const catalog = await browse({});
  row.categories = catalog.categories.length;
  let items = catalog.items;
  if (!items.length) {
    for (const category of catalog.categories.slice(1, deep ? 3 : 2)) {
      items = (await browse({ category: category.id })).items;
      if (items.length) break;
    }
  }
  if (!items.length && site.searchable) {
    const keywords = /体育/.test(site.name) ? ['足球', '篮球'] :
      /听书/.test(site.name) ? ['三体', '西游'] :
      /儿歌|教育/.test(site.name) ? ['儿歌', '故事'] : ['西游', '三体', '哪吒'];
    for (const search of keywords.slice(0, deep ? keywords.length : 1)) {
      items = (await browse({ search })).items;
      if (items.length) break;
    }
  }
  row.items = items.length;
  if (!items.length) throw catalogIssue ?? new Error('分类和样本查询没有可选内容。');
  let issue = '详情未返回可选集数。';
  for (const item of items.slice(0, deep ? 3 : 1)) {
    row.sample = item.title;
    try {
      const detail = call ? await readAndroidDetail(android, item.id, call) : await json('/api/detail', { ...params, id: item.id });
      row.details = (row.details ?? 0) + 1;
      const resolveEpisode = call ? async id => {
        const result = await readAndroidEpisode(android, id, call);
        return playback({ ...result, headers: playbackHeaders(result.headers) });
      } : undefined;
      Object.assign(row, await mediaOptions(detail.lines, params, resolveEpisode, call ? androidMediaBase : base), { sample: item.title });
      return;
    } catch (error) { issue = error.message; }
  }
  throw new Error(issue);
}

async function checkLive(params, row) {
  const channels = await json('/api/channels', params);
  row.items = channels.length;
  let issue = '直播清单没有频道。';
  const samples = channels.filter(item => !/更新时间|测试|广告/.test(item.name) && !/\d{4}-\d{2}-\d{2}/.test(item.name));
  const groups = new Map();
  for (const channel of samples) if (!groups.has(channel.group)) groups.set(channel.group, channel);
  const candidates = deep ? [...new Set([...groups.values(), ...samples])].slice(0, 10) : samples.slice(0, 4);
  for (const channel of candidates) {
    row.sample = channel.name;
    try {
      const detail = await json('/api/live', { ...params, id: channel.id });
      Object.assign(row, await mediaOptions(detail.lines, params), { sample: channel.name });
      return;
    } catch (error) { issue = error.message; }
  }
  throw new Error(issue);
}

const queue = [];
const report = [];
for (const [index, url] of bridgeSubscriptions.entries()) {
  const subscription = ['王二小', '饭太硬'][index];
  if (subscriptionFilter && subscription !== subscriptionFilter) continue;
  const config = await json('/api/config', {}, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
  });
  const direct = androidSpiderEnabled ? await readConfig(url) : null;
  const bindings = new Map((direct?.sites ?? []).filter(site => site.kind === 'android').map(site => [site.id, site]));
  for (const [type, entries] of [['点播', config.sites], ['直播', config.lives]]) {
    for (const item of entries) {
      if (filter.test(item.name)) queue.push({ subscription, type, item, config: config.id, android: type === '点播' ? bindings.get(item.id) : undefined });
    }
  }
  for (const item of config.unavailable) {
    if (filter.test(item.name)) report.push({ subscription, name: item.name, status: '未接入', issue: item.reason });
  }
}

const total = queue.length;
queue.sort((left, right) => Number(Boolean(left.android)) - Number(Boolean(right.android)));
const requestedWorkers = Math.max(1, Math.min(6, Number(process.env.TVBOX_AUDIT_WORKERS) || 4));
let next = 0;
let done = 0;
await Promise.all(Array.from({ length: requestedWorkers }, async () => {
  while (next < total) {
    const { subscription, type, item, config, android } = queue[next++];
    const row = { subscription, type, name: item.name };
    const params = { config, source: item.id };
    try {
      if (android) await withAndroidSpider(android, call => checkVod(item, params, row, android, call));
      else if (type === '点播') await checkVod(item, params, row);
      else await checkLive(params, row);
      row.status = '样本取流成功';
    } catch (error) {
      row.status = row.items ? '可浏览' : '无样本';
      row.issue = error.message;
    }
    report.push(row);
    console.log(`${++done}/${total} ${subscription} ${item.name} ${row.status}${row.issue ? ` · ${row.issue}` : ''}`);
    if (reportPath && done % 5 === 0) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
}));

report.sort((a, b) => a.subscription.localeCompare(b.subscription) || a.name.localeCompare(b.name));
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
for (const [status, rows] of Object.entries(Object.groupBy(report, row => row.status))) console.log(`${status} ${rows.length}`);
