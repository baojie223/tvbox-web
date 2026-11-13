import { load } from 'cheerio';
import { parse } from 'jsonc-parser';
import { androidSpiderEnabled, readAndroidCatalog, readAndroidDetail, readAndroidEpisode } from './android-spider.mjs';
import { readBiliCatalog, readBiliDetail, readBiliEpisode } from './bilibili.mjs';
import { readHuajuanCatalog, readHuajuanDetail, readHuajuanEpisode } from './huajuan.mjs';
import { androidProxyAddress, httpUrl, isPublicUrl, readRemote } from './upstream.mjs';

export const defaultConfig = 'http://new.王二小放牛娃.top';
export const bridgeSubscriptions = [defaultConfig, 'http://www.饭太硬.net/tv'];
const bridgeUrls = new Set(bridgeSubscriptions.map(input => new URL(input).href));
const huajuanNode = process.env.TVBOX_HUAJUAN_NODE === '1';
const subscriptionHeaders = { 'user-agent': 'okhttp/4.12.0' };
const rabbitOrigin = 'https://www.tuxiaobei.com';
const rabbitHeaders = {
  'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
};
const rabbitCategories = ['儿歌', '故事', '国学', '启蒙'].map((name, index) => ({
  id: ['2', '3', '4', '25'][index], name,
}));

function address(value, base) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = httpUrl(value.trim(), base);
    return isPublicUrl(url) ? url.href : '';
  } catch {
    return '';
  }
}

function githubRaw(value) {
  return value.replace(/^https:\/\/ghproxy\.net\/(https:\/\/raw\.githubusercontent\.com\/)/, '$1');
}

export function parseConfig(bytes) {
  // Some subscriptions append a Base64 JSONC document after a JPEG cover.
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const end = jpeg ? bytes.lastIndexOf(Buffer.from([0xff, 0xd9])) : -1;
  let text = bytes.subarray(end < 0 ? 0 : end + 2).toString('utf8').replace(/^\uFEFF/, '').trim();
  const encoded = /^[\w-]{0,64}\*\*\s*([\w+/=\s-]+)$/.exec(text);
  if (encoded) text = Buffer.from(encoded[1], 'base64').toString('utf8').replace(/^\uFEFF/, '');
  const errors = [];
  const data = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !data || (!Array.isArray(data.sites) && !Array.isArray(data.lives))) {
    throw new Error('地址没有返回可读取的 TVBox 配置。请检查订阅地址。');
  }
  return data;
}

function siteKind(site, url, biliConfig) {
  if (Number(site.type) === 3 && site.api === 'csp_BiliGuard' && biliConfig) return 'bilibili';
  if (Number(site.type) === 3 && typeof site.ext === 'string' && /\/兔小贝\.js$/i.test(decodeURI(site.ext))) return 'rabbit';
  if (Number(site.type) === 0 && url) return 'xml';
  if (Number(site.type) === 1 && url) return 'json';
  return '';
}

function androidBinding(entry, jar, base) {
  if (Number(entry.type) !== 3 || typeof entry.api !== 'string') return null;
  const [file, ...checksum] = String(entry.jar || jar || '').split(';');
  const androidJar = file ? [address(file, base), ...checksum].join(';') : '';
  const java = /^csp_[\w$]+$/.test(entry.api);
  const androidApi = java ? entry.api : githubRaw(address(entry.api, base));
  if (java ? !androidJar || androidJar.startsWith(';') : !androidApi || !/\.js$/i.test(new URL(androidApi).pathname)) return null;
  const ext = entry.ext;
  const androidExt = typeof ext === 'string' ? (/^\.\.?\//.test(ext) ? address(ext, base) : java ? ext : githubRaw(ext)) : ext == null ? '' : JSON.stringify(ext);
  return { androidApi, androidJar, androidExt };
}

export async function readConfig(input) {
  const { bytes, url } = await readRemote(httpUrl(input), subscriptionHeaders);
  const raw = parseConfig(bytes);
  const subscription = httpUrl(input).href;
  const allowAndroid = androidSpiderEnabled && bridgeUrls.has(subscription);
  const androidParsers = allowAndroid ? (raw.parses ?? []).flatMap(entry => {
    const endpoint = Number(entry?.type) === 1 && address(entry.url, url);
    return endpoint && endpoint.endsWith('=') ? [{ url: endpoint, headers: playbackHeaders(entry.ext?.header) }] : [];
  }) : [];
  const lives = (raw.lives ?? []).filter(Boolean).map((entry, index) => {
    const proxy = allowAndroid ? androidProxyAddress(entry.url, url) : '';
    return {
      id: String(index), name: String(entry.name || `直播源 ${index + 1}`),
      url: proxy || address(entry.url, url), androidProxy: Boolean(proxy),
      headers: {
        ...playbackHeaders(entry.header),
        ...playbackHeaders({ 'user-agent': entry.ua, referer: entry.referer, origin: entry.origin }),
      },
    };
  });
  const sites = (raw.sites ?? []).filter(Boolean).map((entry, index) => {
    const api = address(entry.api, url);
    const biliConfig = address(entry.ext?.json, url);
    let kind = '';
    try { kind = siteKind(entry, api, biliConfig); } catch { /* A malformed rule only affects this site. */ }
    if (huajuanNode && subscription === new URL(defaultConfig).href && entry.api === 'csp_AiNewHuaJuanGuard') kind = 'huajuan';
    const binding = !kind && allowAndroid ? androidBinding(entry, raw.spider, url) : null;
    if (binding) kind = 'android';
    return {
      id: String(index), name: String(entry.name || `点播源 ${index + 1}`), kind, api, biliConfig,
      ...binding, androidParsers: binding ? androidParsers : undefined,
      searchable: kind === 'rabbit' || Number(entry.searchable ?? 1) !== 0,
      reason: String(entry.api).startsWith('csp_') ? '需要 Android 爬虫' : '需要 TVBox 扩展运行时',
    };
  });
  return { lives, sites };
}

export function playbackHeaders(values = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(values ?? {})) {
    const key = name.toLowerCase().replace(/^referrer$/, 'referer');
    if (['user-agent', 'referer', 'origin'].includes(key) && typeof value === 'string' && /^[\x20-\x7e]{1,1024}$/.test(value)) {
      headers[key] = value;
    }
  }
  return headers;
}

export function parseChannels(text, base, androidProxy = false, defaults = {}) {
  const channels = new Map();
  const entries = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let group = '未分组';
  let info;
  let headers = {};
  for (const entry of entries) {
    const line = entry.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const match = /^#EXTINF:((?:[^",]|"[^"]*")*),(.*)$/.exec(line);
      if (!match) continue;
      const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key.toLowerCase(), value]));
      info = { name: match[2].trim() || attrs['tvg-name'], logo: address(attrs['tvg-logo'], base), group: attrs['group-title'] || '未分组' };
      headers = {};
    } else if (line.startsWith('#EXTVLCOPT:http-')) {
      const match = /^#EXTVLCOPT:http-([^=]+)=(.+)$/.exec(line);
      if (match) Object.assign(headers, playbackHeaders({ [match[1]]: match[2] }));
    } else if (line.startsWith('#EXTHTTP:')) {
      try { Object.assign(headers, playbackHeaders(JSON.parse(line.slice(9)))); } catch { /* Optional stream headers. */ }
    } else if (!line.startsWith('#')) {
      const comma = line.indexOf(',');
      const value = comma >= 0 && !info ? line.slice(comma + 1).trim() : line;
      if (!info && value === '#genre#' && comma >= 0) {
        group = line.slice(0, comma).trim();
        continue;
      }
      if (!info && comma < 0) continue;
      const item = info ?? { name: line.slice(0, comma).trim(), logo: '', group };
      const [rawUrl, options] = value.split('|', 2);
      if (options) Object.assign(headers, playbackHeaders(Object.fromEntries(new URLSearchParams(options))));
      const proxy = androidProxy ? androidProxyAddress(rawUrl, base) : '';
      const url = proxy || address(rawUrl, base);
      if (url && item.name) {
        const key = JSON.stringify([item.group, item.name]);
        if (!channels.has(key)) channels.set(key, { ...item, id: String(channels.size), lines: [] });
        const channel = channels.get(key);
        const mediaHeaders = Object.keys(headers).length ? headers : defaults;
        if (!channel.lines.some(line => line.url === url && JSON.stringify(line.headers) === JSON.stringify(mediaHeaders))) {
          channel.lines.push({ url, headers: mediaHeaders, androidProxy: Boolean(proxy) });
        }
      }
      info = undefined;
      headers = {};
    }
  }
  return [...channels.values()];
}

export async function readChannels(live) {
  const { bytes, url } = await readRemote(live.url, live.headers, { androidProxy: live.androidProxy }).catch(error => {
    const original = githubRaw(live.url);
    if (original === live.url) throw error;
    return readRemote(original, live.headers);
  });
  const channels = parseChannels(bytes.toString('utf8'), url, live.androidProxy, live.headers);
  if (!channels.length) throw new Error('此清单没有可播放的 HTTP 频道。');
  return channels;
}

async function rabbitPage(path) {
  return (await readRemote(new URL(path, rabbitOrigin), rabbitHeaders)).bytes.toString('utf8');
}

function rabbitResults(html) {
  const $ = load(html);
  return $('.list-con .items').toArray().flatMap(item => {
    const id = $(item).find('a[href]').first().attr('href')?.match(/\/play\/(\d+)/)?.[1];
    if (!id) return [];
    return [{
      id, title: $(item).find('.text').first().text().trim(),
      image: address($(item).find('mip-img, img').first().attr('src'), rabbitOrigin),
      subtitle: $(item).find('.time').first().text().trim(),
    }];
  });
}

async function rabbitCatalog({ search, page, category }) {
  if (search) return { categories: rabbitCategories, items: rabbitResults(await rabbitPage(`/search/${encodeURIComponent(search)}`)), more: false };
  const selected = rabbitCategories.find(item => item.id === category) ?? rabbitCategories[0];
  const body = (await rabbitPage(`/list/mip-data?typeId=${selected.id}&page=${page}&callback=`)).trim();
  const data = JSON.parse(body.replace(/^\(\s*|\s*\);?$/g, '')).data;
  const items = (data?.items ?? []).map(item => ({
    id: String(item.video_id), title: item.name, image: address(item.image, rabbitOrigin), subtitle: item.duration_string,
  }));
  const pageCount = Number(data?.page_count ?? data?.pageCount ?? data?.total_page);
  return { categories: rabbitCategories, items, more: Number.isFinite(pageCount) ? page < pageCount : items.length > 0 };
}

async function rabbitDetail(id) {
  if (!/^\d+$/.test(id)) throw new Error('无效的视频编号。');
  const $ = load(await rabbitPage(`/play/${id}`));
  const url = address($('#videoWrap').attr('video-src'), rabbitOrigin);
  if (!url) throw new Error('这个视频当前没有可播放的直链。');
  return {
    title: $('h1').first().text().trim() || $('title').text().trim(),
    lines: [{ name: '官方线路', episodes: [{ name: '播放', url, headers: { ...rabbitHeaders, referer: `${rabbitOrigin}/` } }] }],
  };
}

async function collection(site, params) {
  const url = httpUrl(site.api);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  const { bytes } = await readRemote(url);
  if (site.kind === 'json') return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  const $ = load(bytes.toString('utf8'), { xml: true });
  const list = $('list video').toArray().map(video => {
    const fields = Object.fromEntries(['id', 'name', 'pic', 'note', 'des', 'year', 'type', 'actor'].map(field => [`vod_${field === 'note' ? 'remarks' : field}`, $(video).children(field).text()]));
    const lines = $(video).find('dl dd').toArray();
    return { ...fields, vod_content: fields.vod_des, vod_play_from: lines.map(line => $(line).attr('flag')).join('$$$'), vod_play_url: lines.map(line => $(line).text()).join('$$$') };
  });
  return { list, pagecount: $('list').attr('pagecount'), class: $('class ty').toArray().map(item => ({ type_id: $(item).attr('id'), type_name: $(item).text() })) };
}

export async function readCatalog(site, query, signal) {
  if (site.kind === 'huajuan') return readHuajuanCatalog(query, signal);
  if (site.kind === 'rabbit') return rabbitCatalog(query);
  if (site.kind === 'bilibili') return readBiliCatalog(site, query);
  if (site.kind === 'android') return readAndroidCatalog(site, query, undefined, signal);
  const params = { ac: 'list', pg: query.page, t: query.search ? '' : query.category, wd: query.search };
  const result = await collection(site, params);
  let entries = result.list ?? [];
  if (entries.length && !entries.some(entry => entry.vod_pic)) {
    const detail = await collection(site, { ac: site.kind === 'xml' ? 'videolist' : 'detail', ids: entries.map(entry => entry.vod_id).join(',') });
    if (detail.list?.length) entries = detail.list;
  }
  return {
    categories: (result.class ?? []).map(item => ({ id: String(item.type_id), name: item.type_name })),
    items: entries.map(item => ({ id: String(item.vod_id), title: item.vod_name, image: address(item.vod_pic, site.api), subtitle: item.vod_remarks })),
    more: query.page < Number(result.pagecount),
  };
}

export async function readDetail(site, id, signal) {
  if (site.kind === 'huajuan') return readHuajuanDetail(id, signal);
  if (site.kind === 'rabbit') return rabbitDetail(id);
  if (site.kind === 'bilibili') return readBiliDetail(id);
  if (site.kind === 'android') return readAndroidDetail(site, id, undefined, signal);
  const data = await collection(site, { ac: site.kind === 'xml' ? 'videolist' : 'detail', ids: id });
  const item = data.list?.[0];
  if (!item) throw new Error('片源没有返回这部影片。');
  const names = String(item.vod_play_from ?? '').split('$$$');
  const lines = String(item.vod_play_url ?? '').split('$$$').map((line, lineIndex) => ({
    name: names[lineIndex] || `线路 ${lineIndex + 1}`,
    episodes: line.split('#').flatMap((episode, index) => {
      const split = episode.indexOf('$');
      const value = split >= 0 ? episode.slice(split + 1) : episode;
      const url = address(value);
      if (!url || !/\.(m3u8|mp4|m4v|webm|ogv|mp3|m4a|aac|ts)$/i.test(new URL(url).pathname)) return [];
      return [{ name: split >= 0 ? episode.slice(0, split) : `第 ${index + 1} 集`, url, headers: {} }];
    }),
  })).filter(line => line.episodes.length);
  const description = load(String(item.vod_content ?? '')).text().trim();
  return { title: item.vod_name, description, subtitle: [item.vod_year, item.type_name || item.vod_type].filter(Boolean).join(' · '), lines };
}

export async function readEpisode(site, id, signal) {
  if (site.kind === 'huajuan') return readHuajuanEpisode(id, signal);
  if (site.kind === 'bilibili') return readBiliEpisode(id);
  if (site.kind === 'android') {
    const episode = await readAndroidEpisode(site, id, undefined, signal);
    return { ...episode, headers: playbackHeaders(episode.headers) };
  }
  throw new Error('这条线路没有单独的分集播放接口。');
}
