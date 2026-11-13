import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { load } from 'cheerio';
import { androidPlaylistAddress, androidProxyAddress, httpUrl, isPublicUrl, readRemote } from './upstream.mjs';

const port = Number(process.env.TVBOX_ANDROID_PORT);
export const androidSpiderEnabled = Number.isInteger(port) && port > 0 && port <= 65535;
const adb = process.env.TVBOX_ANDROID_ADB;
const serial = process.env.TVBOX_ANDROID_SERIAL;
const execute = promisify(execFile);
let pending = Promise.resolve();
const spiderOperations = {
  homeContent: '读取首页',
  homeVideoContent: '读取推荐影片',
  categoryContent: '读取分类',
  searchContent: '搜索影片',
  detailContent: '读取影片详情',
  playerContent: '解析分集',
};

class AndroidConnectionError extends Error {}

async function request(path, body, session, method = body ? 'POST' : 'GET', signal) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) headers['X-Spider-Session'] = session;
  let response;
  try {
    const timeout = AbortSignal.timeout(7000);
    response = await fetch(`http://127.0.0.1:${port}/spider-api${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    signal?.throwIfAborted();
    throw new AndroidConnectionError('Android 爬虫服务断开，模拟器可能仍在启动或爬虫进程已退出。');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(`Android 爬虫服务返回 HTTP ${response.status}。`);
  return result;
}

async function createSession(signal) {
  try {
    return await request('', {}, undefined, 'POST', signal);
  } catch (error) {
    if (!(error instanceof AndroidConnectionError) || !adb || !/^emulator-\d+$/.test(serial ?? '')) throw error;
    // A normal launch can leave FongMi's crash activity in front of the home activity.
    await execute(adb, ['-s', serial, 'shell', 'am', 'start', '-S', '-W', '-n', 'com.fongmi.android.tv/.ui.activity.HomeActivity'], {
      windowsHide: true, timeout: 12_000, signal,
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      await delay(750, undefined, { signal });
      try { return await request('', {}, undefined, 'POST', signal); }
      catch (retryError) { if (!(retryError instanceof AndroidConnectionError)) throw retryError; }
    }
    throw error;
  }
}

function queueAndroid(work, signal) {
  const job = pending.then(() => {
    signal?.throwIfAborted();
    return work();
  });
  pending = job.catch(() => {});
  return job;
}

export function withAndroidSpider(site, work, signal) {
  return queueAndroid(() => runSpider(site, work, signal), signal);
}

async function runSpider(site, work, signal) {
  const { session } = await createSession(signal);
  if (!session) throw new Error('Android 爬虫服务未建立会话。');
  async function run(path, body, expected) {
    const deadline = Date.now() + 23_000;
    let state = await request(path, { ...body, timeout: 20 }, session, 'POST', signal);
    while (['loading', 'running'].includes(state.state) && Date.now() < deadline) {
      await delay(350, undefined, { signal });
      state = await request('', undefined, session, 'GET', signal);
    }
    if (state.state !== expected) {
      const operation = spiderOperations[body.method] || '加载';
      if (['timedout', 'loading', 'running'].includes(state.state)) {
        throw new Error(`Android 爬虫${operation}超时，请重试。`);
      }
      const exception = String(state.result ?? '').match(/\b[\w.$]+(?:Exception|Error)\b/)?.[0];
      throw new Error(`Android 爬虫${operation}失败（${exception || state.state}）。`);
    }
    return state.result ? JSON.parse(state.result) : {};
  }
  try {
    await run('/load', { api: site.androidApi, jar: site.androidJar, ext: site.androidExt }, 'loaded');
    return await work((method, args) => run('/run', { method, args }, 'done'));
  } finally {
    await request('', undefined, session, 'DELETE').catch(() => {});
  }
}

function publicAddress(value) {
  try {
    const url = httpUrl(value);
    return isPublicUrl(url) ? url.href : '';
  } catch {
    return '';
  }
}

function runFor(site, call, work, signal) {
  return call ? work(call) : withAndroidSpider(site, work, signal);
}

export function supportsAndroidAccountConfig(site) {
  return site.kind === 'android' && site.androidApi === 'csp_PanConfigGuard';
}

async function accountPageReady(url, signal) {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(1500);
  const response = await fetch(url, {
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch(() => null);
  signal?.throwIfAborted();
  const ready = response?.ok && response.headers.get('content-type')?.includes('text/html');
  await response?.body?.cancel().catch(() => {});
  return ready;
}

export function openAndroidAccountConfig(signal) {
  const url = `http://127.0.0.1:${port}/proxy?do=pan&action=config`;
  return queueAndroid(async () => {
    if (await accountPageReady(url, signal)) return { url };
    // A test session wakes FongMi if needed. Its native subscription registers the configuration proxy.
    const { session } = await createSession(signal);
    try {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        if (await accountPageReady(url, signal)) return { url };
        await delay(400, undefined, { signal });
      }
      throw new Error('Android 配置页尚未就绪。请确认模拟器的 FongMi 点播设置已加载王二小订阅，再重试。');
    } finally {
      if (session) await request('', undefined, session, 'DELETE').catch(() => {});
    }
  }, signal);
}

export function readAndroidCatalog(site, { category, page, search }, run, signal) {
  return runFor(site, run, async call => {
    let data;
    let categories = [];
    let searchScope;
    if (search) {
      data = await call('searchContent', page === 1 ? [search, false] : [search, false, String(page)]);
      if (page === 1 && !data?.list?.length) {
        try {
          const home = await readAndroidHome(call, 1, signal);
          const keyword = search.normalize('NFKC').toLowerCase();
          data = { list: (home.data?.list ?? []).filter(item => String(item.vod_name ?? '').normalize('NFKC').toLowerCase().includes(keyword)) };
          searchScope = 'home';
        } catch {
          signal?.throwIfAborted();
        }
      }
    } else if (category) {
      data = await call('categoryContent', [category, String(page), false, {}]);
    } else {
      ({ categories, data } = await readAndroidHome(call, page, signal));
    }
    const items = (data?.list ?? []).filter(item => item.vod_id != null && item.vod_id !== '').map(item => ({
      id: String(item.vod_id), title: item.vod_name, image: publicAddress(item.vod_pic), subtitle: item.vod_remarks,
    }));
    const pageCount = Number(data?.pagecount);
    return { categories, items, searchScope, more: !searchScope && (pageCount > 0 ? page < pageCount : items.length > 0) };
  }, signal);
}

async function readAndroidHome(call, page, signal) {
  let categories = [];
  let data;
  let home;
  let browseError;
  try {
    home = await call('homeContent', [false]);
    categories = (home.class ?? []).map(item => ({ id: String(item.type_id), name: item.type_name }));
    if (categories.length) data = await call('categoryContent', [categories[0].id, String(page), false, {}]);
  } catch (error) {
    signal?.throwIfAborted();
    if (page !== 1) throw error;
    browseError = error;
  }
  if (page === 1 && !data?.list?.length) {
    if (home?.list?.length) data = home;
    else {
      try {
        const videos = await call('homeVideoContent', []);
        if (videos?.list?.length || !data) data = videos;
      } catch (error) {
        signal?.throwIfAborted();
        if (!categories.length) throw browseError ?? error;
      }
      if (browseError && !data?.list?.length && !categories.length) throw browseError;
    }
  }
  return { categories, data };
}

export function readAndroidDetail(site, id, run, signal) {
  return runFor(site, run, async call => {
    const data = await call('detailContent', [[id]]);
    const item = data.list?.[0];
    if (!item) throw new Error('Android 爬虫没有返回这部影片。');
    const flags = String(item.vod_play_from ?? '').split('$$$');
    const lines = String(item.vod_play_url ?? '').split('$$$').map((line, index) => {
      const flag = flags[index] || '';
      const episodes = line.split('#').filter(Boolean).flatMap((entry, episodeIndex) => {
        const split = entry.indexOf('$');
        const id = split < 0 ? entry : entry.slice(split + 1);
        const name = split < 0 ? `第 ${episodeIndex + 1} 集` : entry.slice(0, split);
        return id.trim() ? [{ name, id: Buffer.from(JSON.stringify([flag, id])).toString('base64url') }] : [];
      });
      return { name: flag || `线路 ${index + 1}`, episodes };
    }).filter(line => line.episodes.length);
    return {
      title: item.vod_name, subtitle: [item.vod_year, item.type_name].filter(Boolean).join(' · '),
      description: load(String(item.vod_content ?? ''), null, false).text().trim(), lines,
    };
  }, signal);
}

function resultHeaders(result) {
  const header = result.header ?? result.headers;
  if (header && typeof header === 'string') return JSON.parse(header);
  return header ?? {};
}

function streamResult(raw, headers, format) {
  const playlist = androidPlaylistAddress(raw);
  if (playlist) return { url: playlist, headers, hls: true };
  const proxy = androidProxyAddress(raw);
  const url = proxy || publicAddress(raw);
  if (!url) return null;
  const hls = /mpegurl|m3u8/i.test(String(format ?? '')) || /\.m3u8(?:$|[?&#])/.test(raw);
  return { url, headers, androidProxy: Boolean(proxy), hls: hls || undefined };
}

async function parsePlayback(parsers, raw, fallbackHeaders) {
  for (const parser of parsers ?? []) {
    try {
      const { bytes } = await readRemote(parser.url + encodeURIComponent(raw), parser.headers, { timeout: 6000 });
      const result = JSON.parse(bytes.toString('utf8'));
      const url = result.url || result.data?.url;
      if (typeof url !== 'string' || Number(result.parse) > 0) continue;
      const media = streamResult(url, { ...fallbackHeaders, ...parser.headers, ...resultHeaders(result) }, result.format);
      if (media) return media;
    } catch { /* Continue to the next parser configured in the subscription. */ }
  }
  throw new Error('订阅的解析接口没有返回可播放地址。');
}

export class AndroidPlaybackError extends Error {
  constructor(message, action) {
    super(message);
    this.action = action;
  }
}

function missingPlaybackAddress(result, flag) {
  // Crawler diagnostics may contain account credentials or signed links.
  const message = String(result.msg ?? result.message ?? result.error ?? '');
  const providers = [
    [/\b115\b/, '115 网盘'], [/夸克|quark/i, '夸克网盘'], [/百度|baidu/i, '百度网盘'],
    [/阿里|aliyun/i, '阿里云盘'], [/UC原画|\buc\b/i, 'UC 网盘'], [/迅雷|thunder/i, '迅雷网盘'],
  ];
  const provider = (providers.find(([pattern]) => pattern.test(flag)) ?? providers.find(([pattern]) => pattern.test(message)))?.[1];
  if (provider && /cookie|授权|登录/i.test(message) && /配置|失效|过期|未登录|重新登录|无效|缺失|为空/i.test(message)) {
    return new AndroidPlaybackError(`${provider}的登录授权缺失或已失效，请在配置中心更新授权后重试。`, 'account-config');
  }
  const status = /\bHTTP\s*([45]\d\d)\b/i.exec(message)?.[1];
  if (status) return new AndroidPlaybackError(`${provider || '片源'}接口返回 HTTP ${status}，未生成播放地址。`);
  if (/EADDRINUSE/.test(message)) return new AndroidPlaybackError('Android 分片服务端口被占用，未生成播放地址。');
  if (/分享.{0,10}(?:已失效|已删除|不存在)|文件.{0,10}(?:已删除|不存在)/.test(message)) {
    return new AndroidPlaybackError(`${provider || '片源'}的分享或文件已失效，请换一条线路。`);
  }
  return new AndroidPlaybackError('Android 爬虫未返回播放地址，也未提供可识别的原因。');
}

export function readAndroidEpisode(site, encoded, run, signal) {
  const [flag, id] = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (typeof flag !== 'string' || typeof id !== 'string' || !id) throw new Error('无效的 Android 分集编号。');
  return runFor(site, run, async call => {
    const result = await call('playerContent', [flag, id, []]);
    const raw = typeof result.url === 'string' ? result.url : result.url?.values?.[0]?.v ?? result.url?.[1];
    if (result.drm?.license || result.drm?.licenseUrl) throw new Error('这条线路需要客户端 DRM 播放。');
    if (typeof raw !== 'string' || !raw.trim()) throw missingPlaybackAddress(result, flag);
    const headers = resultHeaders(result);
    if (Number(result.parse) > 0 || Number(result.jx) > 0) {
      if (!publicAddress(raw)) throw new Error('这条线路需要 Android 客户端解析。');
      return parsePlayback(site.androidParsers, raw, headers);
    }
    const media = streamResult(raw, headers, result.format);
    if (!media) {
      const message = /^http:\/\/127\.0\.0\.1:\d+\/chunk\?/.test(raw)
        ? '爬虫返回了 Android 内部的分片服务地址，网页桥接暂时无法读取。'
        : '爬虫返回了网页播放器无法使用的地址格式。';
      throw new AndroidPlaybackError(message);
    }
    return media;
  }, signal);
}
