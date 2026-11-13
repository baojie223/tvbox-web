import { load } from 'cheerio';
import { clearQuarkAccount, quarkAccount, quarkDesktopAgent, QuarkLoginError } from './quark-auth.mjs';
import { httpUrl, isPublicUrl, readRemote } from './upstream.mjs';

const origins = ['https://www.huanjuanwp.shop', 'https://www.hjzhencai.top'];
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const quarkOrigin = 'https://pan.quark.cn';
const catalogId = /^\d+$/;
const shareId = /^[A-Za-z0-9_-]{1,128}$/;
const detailLink = /\/vod\/detail\/id\/(\d+)\.html(?:$|[?#])/;
const videoFile = /\.(?:mp4|m4v|webm|mkv|mov|ts)$/i;
let preferredOrigin = origins[0];

async function html(path, signal) {
  let failure;
  for (const origin of new Set([preferredOrigin, ...origins])) {
    try {
      const { bytes, url } = await readRemote(new URL(path, origin), { 'user-agent': userAgent, referer: origin + '/' }, { timeout: 8_000, signal });
      const $ = load(bytes.toString('utf8'));
      if (!$('.navbar-item, .module, .module-item, .module-info').length) {
        throw new Error('花卷返回了无法识别的页面。');
      }
      preferredOrigin = origin;
      return { $, url };
    } catch (error) {
      signal?.throwIfAborted();
      failure = error;
    }
  }
  throw failure;
}

function imageAddress(value, base) {
  try {
    const url = httpUrl(value, base);
    return isPublicUrl(url) ? url.href : '';
  } catch {
    return '';
  }
}

function cards($, url) {
  const items = new Map();
  for (const element of $('a[href*="/vod/detail/"]').toArray()) {
    const link = $(element);
    const id = detailLink.exec(link.attr('href') ?? '')?.[1];
    const card = link.closest('.module-item, .module-search-item, .module-card-item');
    const image = card.find('img').first();
    const title = link.attr('title') || image.attr('alt') || link.text().trim();
    if (!id || !title) continue;
    const prior = items.get(id);
    const src = image.attr('data-original') || image.attr('data-src') || image.attr('src');
    items.set(id, {
      id, title: prior?.title || title,
      image: prior?.image || (src ? imageAddress(src, url) : ''),
      subtitle: prior?.subtitle || card.find('.module-item-note, .video-serial').first().text().trim(),
    });
  }
  return [...items.values()];
}

export async function readHuajuanCatalog({ category, page, search }, signal) {
  let categories = [];
  if (!category && !search) {
    const { $ } = await html('/', signal);
    const names = new Map();
    for (const element of $('a[href*="/vod/type/id/"]').toArray()) {
      const link = $(element);
      const id = /\/vod\/type\/id\/(\d+)\.html/.exec(link.attr('href') ?? '')?.[1];
      if (id && link.text().trim()) names.set(id, link.text().trim());
    }
    categories = [...names].map(([id, name]) => ({ id, name }));
    category = categories[0]?.id;
  }
  if (!search && !catalogId.test(category ?? '')) throw new Error('花卷没有返回有效分类。');
  const path = search
    ? `/index.php/vod/search.html?${new URLSearchParams({ wd: search, page: String(page) })}`
    : `/index.php/vod/show/id/${category}/page/${page}.html`;
  const { $, url } = await html(path, signal);
  const term = search?.normalize('NFKC').toLowerCase();
  const items = cards($, url).filter(item => !term || item.title.normalize('NFKC').toLowerCase().includes(term));
  const more = $('a[href]').toArray().some(element => {
    const href = $(element).attr('href');
    return search
      ? href.includes('/vod/search') && Number(/[?&]page=(\d+)/.exec(href)?.[1]) > page
      : href.includes(`/vod/show/id/${category}/`) && Number(/\/page\/(\d+)/.exec(href)?.[1]) > page;
  });
  return { categories, items, more };
}

class QuarkGuest {
  #cookies = new Map();

  constructor(id, passcode, signal) {
    this.id = id;
    this.passcode = passcode;
    this.signal = signal;
  }

  get cookie() {
    return [...this.#cookies.values()].join('; ');
  }

  async call(path, params = {}, body, account) {
    const host = path === 'file/download' ? 'https://drive-pc.quark.cn' : 'https://drive.quark.cn';
    const url = new URL('/1/clouddrive/' + path, host);
    url.search = new URLSearchParams({ pr: 'ucpro', fr: 'pc', uc_param_str: '', ...params });
    const headers = { 'user-agent': account ? quarkDesktopAgent : userAgent, referer: quarkOrigin + '/', origin: quarkOrigin, 'content-type': 'application/json' };
    const cookie = [account?.cookie, this.cookie].filter(Boolean).join('; ');
    if (cookie) headers.cookie = cookie;
    const timeout = AbortSignal.timeout(10_000);
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    const response = await fetch(url, {
      headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
      redirect: 'error', signal,
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';').map(value => value.trim());
      const name = /^(__sdid|__pugs|__puus)=[\x21-\x7e]+$/.exec(pair)?.[1];
      if (name && attributes.some(value => /^domain=\.?quark\.cn$/i.test(value))) this.#cookies.set(name, pair);
    }
    const result = await response.json().catch(() => ({}));
    if (Number(result.code) === 23018) {
      if (account) throw new Error('夸克在登录后仍拒绝直接下载该文件大小（23018）。');
      throw new QuarkLoginError('夸克游客下载接口拒绝该文件大小（23018），请先扫码登录。');
    }
    if (response.status === 401 || Number(result.code) === 31001) {
      if (account) await clearQuarkAccount(account.id);
      throw new QuarkLoginError('夸克要求有效的登录会话，请扫码登录后重试。');
    }
    if (!response.ok || result.code !== 0) throw new Error(`夸克${path === 'file/download' ? '生成下载地址' : '读取分享'}失败（HTTP ${response.status}${Number.isInteger(result.code) ? `，代码 ${result.code}` : ''}）。`);
    return result.data;
  }

  async init() {
    const data = await this.call('share/sharepage/token', {}, {
      pwd_id: this.id, passcode: this.passcode, support_visit_limit_private_share: true,
    });
    if (!data?.stoken) throw new Error('夸克分享没有返回访客令牌。');
    this.token = data.stoken;
  }

  async *folder(folderId) {
    const seen = new Set();
    for (let page = 1; ; page++) {
      const data = await this.call('share/sharepage/detail', {
        pwd_id: this.id, stoken: this.token, pdir_fid: folderId,
        _page: page, _size: 50, _fetch_total: 1, _sort: 'file_type:asc,file_name:asc', ver: 2,
      });
      const items = data?.list ?? [];
      let fresh = 0;
      for (const item of items) {
        if (typeof item.fid !== 'string' || !shareId.test(item.fid) || seen.has(item.fid)) continue;
        seen.add(item.fid);
        fresh++;
        yield item;
      }
      if (items.length < 50 || !fresh) return;
    }
  }

  async episodes() {
    await this.init();
    const folders = new Set(['0']);
    const episodes = [];
    for (const folderId of folders) {
      for await (const file of this.folder(folderId)) {
        if (file.dir) folders.add(file.fid);
        else if (videoFile.test(file.file_name ?? '')) {
          episodes.push({
            name: file.file_name,
            id: Buffer.from(JSON.stringify([this.id, this.passcode, folderId, file.fid])).toString('base64url'),
          });
        }
      }
    }
    return episodes.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  }
}

export async function readHuajuanDetail(id, signal) {
  if (!catalogId.test(id)) throw new Error('无效的花卷影片编号。');
  const { $ } = await html(`/index.php/vod/detail/id/${id}.html`, signal);
  const title = $('h1').first().text().trim();
  if (!title) throw new Error('花卷没有返回影片详情。');
  const shares = new Map();
  for (const element of $('a[href^="https://pan.quark.cn/s/"], [data-clipboard-text]').toArray()) {
    const value = $(element).attr('data-clipboard-text') || $(element).attr('href');
    if (!value?.startsWith(quarkOrigin + '/s/')) continue;
    const url = new URL(value);
    const share = url.pathname.split('/')[2];
    if (shareId.test(share ?? '')) shares.set(share, url.searchParams.get('pwd') || shares.get(share) || '');
  }
  const lines = [];
  for (const [share, passcode] of shares) {
    const episodes = await new QuarkGuest(share, passcode, signal).episodes();
    if (episodes.length) lines.push({ name: shares.size > 1 ? `夸克原画 ${lines.length + 1}` : '夸克原画', episodes });
  }
  const synopsis = $('.module-info-introduction').first().text().trim();
  const description = lines.length ? synopsis : [synopsis, '这个条目没有可由当前 Node 试验读取的夸克视频分享。'].filter(Boolean).join('\n');
  return { title, subtitle: $('.module-info-tag-link').slice(0, 3).text().trim(), description, lines };
}

export async function readHuajuanEpisode(id, signal) {
  const values = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
  if (!Array.isArray(values) || values.length !== 4 || values.some(value => typeof value !== 'string')) {
    throw new Error('无效的花卷分集编号。');
  }
  const [share, passcode, folderId, fid] = values;
  if (![share, folderId, fid].every(value => shareId.test(value)) || passcode.length > 32) {
    throw new Error('无效的花卷分集编号。');
  }
  const guest = new QuarkGuest(share, passcode, signal);
  await guest.init();
  for await (const file of guest.folder(folderId)) {
    if (file.fid !== fid || !videoFile.test(file.file_name ?? '')) continue;
    const body = {
      fids: [fid], pwd_id: share, stoken: guest.token, share_fid_token: file.share_fid_token,
    };
    let account = quarkAccount();
    let result;
    try {
      result = await guest.call('file/download', {}, body, account);
    } catch (error) {
      signal?.throwIfAborted();
      if (!account) throw error;
      // A file that supports guest playback can still play if account resolution fails.
      result = await guest.call('file/download', {}, body).catch(() => { throw error; });
      account = undefined;
    }
    const raw = result?.[0]?.download_url;
    if (!raw) throw new Error('夸克没有返回原画下载地址。');
    const url = httpUrl(raw);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.quark.cn') || !(account || guest.cookie)) {
      throw new Error('夸克返回了无法使用的原画地址或会话。');
    }
    const headers = { 'user-agent': account ? quarkDesktopAgent : userAgent, referer: quarkOrigin + '/' };
    const { inspectMediaLayout } = await import('./media-layout.mjs');
    const layout = await inspectMediaLayout(url, { ...headers, cookie: guest.cookie }, signal);
    return {
      url: url.href, headers, layout, privateCookie: guest.cookie, quarkSession: account?.id, hls: false,
    };
  }
  throw new Error('夸克分享中找不到该视频文件。');
}
