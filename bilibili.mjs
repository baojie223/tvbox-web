import { load } from 'cheerio';
import { httpUrl, isPublicUrl, readRemote } from './upstream.mjs';

const webOrigin = 'https://www.bilibili.com/';
const apiOrigin = 'https://api.bilibili.com/';
const headers = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  referer: webOrigin,
};
const videoId = /^BV[A-Za-z0-9]{10}$/;

function publicUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = httpUrl(value, webOrigin);
    return isPublicUrl(url) ? url.href : '';
  } catch {
    return '';
  }
}

async function biliApi(path, params) {
  const url = new URL(path, apiOrigin);
  url.search = new URLSearchParams(params);
  const { bytes } = await readRemote(url, headers);
  const result = JSON.parse(bytes.toString('utf8'));
  if (result.code !== 0 || !result.data) {
    throw new Error(`哔哩哔哩暂时无法返回该内容（${result.code ?? '响应异常'}）。`);
  }
  return result.data;
}

async function loadCategories(url) {
  const { bytes } = await readRemote(url);
  const data = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  return (data.class ?? []).flatMap(item => {
    if (typeof item.type_id !== 'string' || !item.type_id || item.type_id.endsWith('/{pg}')) return [];
    return [{ id: item.type_id, name: item.type_name || item.type_id }];
  });
}

function biliCategories(site) {
  site.biliCategories ??= loadCategories(site.biliConfig).catch(error => {
    delete site.biliCategories;
    throw error;
  });
  return site.biliCategories;
}

export async function readBiliCatalog(site, { search, page, category }) {
  const categories = search ? [] : await biliCategories(site);
  const selected = categories.find(item => item.id === category) ?? categories[0];
  const keyword = search || selected?.id;
  if (!keyword) throw new Error('哔哩哔哩站点未提供可用的分类。');
  const data = await biliApi('/x/web-interface/wbi/search/type', { search_type: 'video', keyword, page });
  const items = (data.result ?? []).filter(item => videoId.test(item.bvid)).map(item => ({
    id: item.bvid,
    title: load(item.title ?? '', null, false).text().trim(),
    image: publicUrl(item.pic),
    subtitle: [item.author, item.duration].filter(Boolean).join(' · '),
  }));
  return { categories, items, more: page < Number(data.numPages) };
}

export async function readBiliDetail(id) {
  if (!videoId.test(id)) throw new Error('无效的哔哩哔哩视频编号。');
  const data = await biliApi('/x/web-interface/view', { bvid: id });
  const episodes = (data.pages ?? []).filter(page => /^\d+$/.test(page.cid)).map(page => ({
    id: `${id}:${page.cid}`,
    name: page.part || `第 ${page.page} 集`,
  }));
  return {
    title: data.title,
    subtitle: data.owner?.name,
    description: data.desc,
    lines: episodes.length ? [{ name: '哔哩哔哩', episodes }] : [],
  };
}

export async function readBiliEpisode(id) {
  const match = /^(BV[A-Za-z0-9]{10}):(\d{1,20})$/.exec(id);
  if (!match) throw new Error('无效的哔哩哔哩分集编号。');
  const [, bvid, cid] = match;
  const data = await biliApi('/x/player/playurl', { bvid, cid, qn: 16, fnval: 1 });
  const url = data.durl?.length === 1 && publicUrl(data.durl[0].url);
  if (!url || !String(data.format).startsWith('mp4')) throw new Error('该分集当前没有公开的 MP4 播放地址。');
  return { url, headers };
}
