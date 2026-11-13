import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { AndroidPlaybackError, openAndroidAccountConfig, supportsAndroidAccountConfig } from './android-spider.mjs';
import { playback, sendMedia } from './media.mjs';
import { inspectCompatibleMedia } from './media-compat.mjs';
import { clearQuarkAccount, createQuarkLogin, pollQuarkLogin, quarkAccount, quarkLoginEnabled, QuarkLoginError, restoreQuarkAccount } from './quark-auth.mjs';
import { mediaSearchSources, searchSubscription, searchWithinSource } from './search.mjs';
import { defaultConfig, readCatalog, readChannels, readConfig, readDetail, readEpisode } from './sources.mjs';
import { readBody } from './upstream.mjs';

const files = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/compatible-playback.js', ['public/compatible-playback.js', 'text/javascript; charset=utf-8']],
  ['/embedded-subtitles.js', ['public/embedded-subtitles.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/hls.js', ['node_modules/hls.js/dist/hls.min.js', 'text/javascript; charset=utf-8']],
]);
if (quarkLoginEnabled) {
  files.set('/quark-login', ['public/quark-login.html', 'text/html; charset=utf-8']);
  files.set('/quark-login.js', ['public/quark-login.js', 'text/javascript; charset=utf-8']);
}
const configs = new Map();
const port = Number(process.env.TVBOX_PORT || 4380);
const loopback = '127.0.0.1';

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
}

async function channelsFor(config, liveId) {
  const live = config.lives.find(item => item.id === liveId && item.url);
  if (!live) throw new AppError(404, '找不到这条直播清单。');
  if (!live.cache || Date.now() > live.cache.expires) {
    live.cache = { expires: Date.now() + 5 * 60_000, pending: readChannels(live) };
    try { return await live.cache.pending; }
    catch (error) { delete live.cache; throw error; }
  }
  return live.cache.pending;
}

async function api(req, res, path, params) {
  if (path.startsWith('/api/quark/')) {
    if (!quarkLoginEnabled) throw new AppError(404, '夸克扫码仅在花卷 Node 试验中启用。');
    if (path === '/api/quark/status' && req.method === 'GET') return json(res, { loggedIn: !!quarkAccount() });
    if (req.method !== 'POST') throw new AppError(405, '此操作需要 POST 请求。');
    if (path === '/api/quark/login') return json(res, await createQuarkLogin());
    if (path === '/api/quark/poll') {
      const { id } = JSON.parse((await readBody(req, 1024)).toString('utf8'));
      if (typeof id !== 'string') throw new AppError(400, '无效的扫码请求。');
      return json(res, await pollQuarkLogin(id));
    }
    if (path === '/api/quark/logout') {
      await clearQuarkAccount();
      return json(res, { loggedIn: false });
    }
    throw new AppError(404, '找不到夸克操作。');
  }
  if (path === '/api/config' && req.method === 'POST') {
    const { url } = JSON.parse((await readBody(req, 8192)).toString('utf8'));
    if (typeof url !== 'string' || url.length > 4096) throw new AppError(400, '请输入 TVBox 配置地址。');
    const config = await readConfig(url);
    const id = randomUUID();
    if (configs.size >= 24) configs.delete(configs.keys().next().value);
    configs.set(id, config);
    return json(res, {
      id,
      lives: config.lives.filter(item => item.url).map(({ id, name }) => ({ id, name })),
      sites: config.sites.filter(item => item.kind).map(site => ({
        id: site.id, name: site.name, searchable: site.searchable && !supportsAndroidAccountConfig(site),
        categoryRequired: ['rabbit', 'bilibili', 'android', 'huajuan'].includes(site.kind),
        accountConfig: supportsAndroidAccountConfig(site) || undefined,
        quarkLogin: site.kind === 'huajuan' || undefined,
      })),
      unavailable: [
        ...config.sites.filter(item => !item.kind).map(({ name, reason }) => ({ name, reason })),
        ...config.lives.filter(item => !item.url).map(({ name }) => ({ name, reason: '需要 TVBox 本机服务' })),
      ],
    });
  }
  const accountRequest = path === '/api/account-config';
  if (req.method !== (accountRequest ? 'POST' : 'GET')) throw new AppError(405, '此操作不支持该请求方式。');
  if (path === '/api/default') return json(res, { url: defaultConfig });
  const config = configs.get(params.get('config'));
  if (!config) throw new AppError(404, '订阅已过期，请重新加载。');
  if (path === '/api/search') {
    const keyword = (params.get('q') ?? '').trim().slice(0, 100);
    if (!keyword) throw new AppError(400, '请输入搜索词。');
    let target;
    if (params.has('source')) {
      const mode = params.get('mode');
      if (!['live', 'vod'].includes(mode)) throw new AppError(400, '请选择片源类型。');
      target = mediaSearchSources(config).find(({ source, live }) =>
        source.id === params.get('source') && live === (mode === 'live'));
      if (!target) throw new AppError(404, '找不到可搜索的片源。');
    }
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    const { signal } = controller;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    const emit = async event => {
      if (signal.aborted) return;
      if (!res.write(JSON.stringify(event) + '\n')) {
        await once(res, 'drain', { signal }).catch(error => {
          if (!signal.aborted) throw error;
        });
      }
    };
    if (target) await searchWithinSource(config, { ...target, keyword, signal }, channelsFor, emit);
    else await searchSubscription(config, { keyword, signal }, channelsFor, emit);
    if (!signal.aborted) res.end();
    return;
  }
  if (path === '/api/channels') {
    const channels = await channelsFor(config, params.get('source'));
    return json(res, channels.map(({ id, name, logo, group, lines }) => ({ id, name, logo, group, lineCount: lines.length })));
  }
  if (path === '/api/live') {
    const channels = await channelsFor(config, params.get('source'));
    const channel = channels.find(item => item.id === params.get('id'));
    if (!channel) throw new AppError(404, '找不到此频道。');
    const lines = channel.lines.map((line, index) => ({ name: `线路 ${index + 1}`, episodes: [{ name: '直播', ...playback(line) }] }));
    return json(res, { title: channel.name, subtitle: channel.group, lines });
  }
  const site = config.sites.find(item => item.id === params.get('source') && item.kind);
  if (!site) throw new AppError(404, '找不到这条点播线路。');
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  if (accountRequest) {
    if (!supportsAndroidAccountConfig(site)) throw new AppError(404, '这条片源没有网页扫码配置入口。');
    return json(res, await openAndroidAccountConfig(controller.signal));
  }
  if (supportsAndroidAccountConfig(site)) {
    if (path !== '/api/catalog') throw new AppError(404, '请从网页版配置中心打开账号设置。');
    return json(res, {
      categories: [],
      items: [{ id: 'web', title: '网页版配置中心', subtitle: '扫码登录与账号设置' }],
      more: false,
    });
  }
  if (path === '/api/catalog') {
    const query = {
      category: (params.get('category') ?? '').slice(0, 128),
      search: (params.get('search') ?? '').trim().slice(0, 100),
      page: Math.max(1, Math.min(1000, Math.trunc(Number(params.get('page'))) || 1)),
    };
    return json(res, await readCatalog(site, query, controller.signal));
  }
  if (path === '/api/detail') {
    const id = params.get('id') ?? '';
    if (!id || id.length > 8192) throw new AppError(400, '片源返回了无效的影片编号。');
    const detail = await readDetail(site, id, controller.signal);
    const lines = detail.lines.map(({ name, episodes }) => ({
      name,
      episodes: episodes.map(item => item.id ? { name: item.name, id: item.id } : { name: item.name, ...playback(item) }),
    }));
    return json(res, { ...detail, lines });
  }
  if (path === '/api/play') {
    const id = params.get('episode') ?? '';
    if (!id || id.length > 8192) throw new AppError(400, '片源返回了无效的分集编号。');
    const episode = await readEpisode(site, id, controller.signal);
    if (site.kind === 'huajuan' && episode.layout?.type === 'video/x-matroska') {
      const origin = `http://${loopback}:${server.address().port}`;
      episode.compatible = await inspectCompatibleMedia(origin + playback(episode).url, controller.signal) ?? undefined;
    }
    return json(res, playback(episode));
  }
  throw new AppError(404, '页面不存在。');
}

const server = createServer(async (req, res) => {
  const host = req.headers.host;
  const currentPort = server.address().port;
  const allowedHosts = [`${loopback}:${currentPort}`, `localhost:${currentPort}`];
  if (!allowedHosts.includes(host)) return res.writeHead(403).end();
  const origin = `http://${host}`;
  if ((req.headers.origin && req.headers.origin !== origin) || ['same-site', 'cross-site'].includes(req.headers['sec-fetch-site'])) {
    return res.writeHead(403).end();
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https: http: data:; media-src 'self' blob:; worker-src 'self' blob:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const { pathname, searchParams } = new URL(req.url, origin);
    if (pathname.startsWith('/api/')) return await api(req, res, pathname, searchParams);
    if (pathname.startsWith('/media/') && ['GET', 'HEAD'].includes(req.method)) {
      return await sendMedia(pathname.slice(7), req, res, `http://${loopback}:${currentPort}`, searchParams);
    }
    if (req.method !== 'GET') return res.writeHead(405).end();
    const file = files.get(pathname);
    if (!file) return res.writeHead(404).end();
    const data = await readFile(new URL(file[0], import.meta.url));
    res.writeHead(200, { 'Content-Type': file[1] }).end(data);
  } catch (error) {
    if (res.destroyed) return;
    if (res.headersSent) return res.destroy();
    if (req.url.startsWith('/media/')) return res.writeHead(502).end();
    const message = error instanceof SyntaxError ? '片源返回的数据格式有误。' : error.message;
    const action = error instanceof AndroidPlaybackError || error instanceof QuarkLoginError ? error.action : undefined;
    json(res, { error: message, action }, error.status ?? 502);
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。请检查播放器是否已启动。` : error.message);
  process.exitCode = 1;
});
await restoreQuarkAccount();
server.listen(port, loopback, () => {
  const url = `http://${loopback}:${server.address().port}`;
  console.log(`放映室已启动 · ${url}`);
  if (process.platform === 'win32' && process.env.TVBOX_OPEN === '1') {
    const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', windowsHide: true });
    browser.on('error', () => console.log(`请在浏览器中打开 ${url}`));
    browser.unref();
  }
});
