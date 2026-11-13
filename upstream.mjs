import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

const nonPublic = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 3],
]) nonPublic.addSubnet(address, bits);
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

function publicAddress(address, family) {
  return family === 4 ? !nonPublic.check(address) : globalV6.check(address, 'ipv6');
}

export function httpUrl(value, base) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('请输入有效的 HTTP 或 HTTPS 地址。');
  }
  return url;
}

export function isPublicUrl(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const family = isIP(host);
  return family ? publicAddress(host, family) : host.includes('.') && !host.endsWith('.localhost');
}

const androidProxyPort = Number(process.env.TVBOX_ANDROID_PORT);
const unsetAndroidProxyPort = /^(http:\/\/(?:localhost|127\.0\.0\.1|10\.0\.2\.16)):-1(?=\/proxy(?:[?#]|$))/i;

export function isAndroidProxyUrl(url) {
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) === androidProxyPort && url.pathname === '/proxy';
}

export function androidProxyAddress(value, base) {
  if (!Number.isInteger(androidProxyPort) || androidProxyPort < 1 || androidProxyPort > 65535) return '';
  try {
    // Some crawlers use -1 for the local port when called through the test API.
    const input = typeof value === 'string'
      ? value.trim().replace(unsetAndroidProxyPort, '$1:9978')
      : value;
    const url = httpUrl(input, base);
    if (isAndroidProxyUrl(url)) return url.href;
    if (url.protocol !== 'http:' || url.port !== '9978' || url.pathname !== '/proxy' || !['localhost', '127.0.0.1', '10.0.2.16'].includes(url.hostname)) return '';
    url.host = `127.0.0.1:${androidProxyPort}`;
    return url.href;
  } catch { return ''; }
}

export function androidPlaylistAddress(value) {
  if (typeof value !== 'string' || !unsetAndroidProxyPort.test(value.trim())) return '';
  const proxy = androidProxyAddress(value);
  if (!proxy) return '';
  const params = new URL(proxy).searchParams;
  if (params.size !== 2 || params.get('do') !== 'm3u8' || !params.get('url')) return '';
  try {
    const url = httpUrl(params.get('url'));
    return isPublicUrl(url) ? url.href : '';
  } catch {
    return '';
  }
}

function publicLookup(host, options, callback) {
  lookup(host, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const allowed = addresses.filter(({ address, family }) => publicAddress(address, family));
    if (!allowed.length) return callback(new Error('该地址指向本机或内网。'));
    if (options.all) return callback(null, allowed);
    callback(null, allowed[0].address, allowed[0].family);
  });
}

export async function upstream(value, { headers = {}, signal, androidProxy = false } = {}, redirects = 0) {
  const url = httpUrl(value);
  if (!isPublicUrl(url) && !(androidProxy && isAndroidProxyUrl(url))) throw new Error('该线路需要本机或内网服务。');
  const transport = url.protocol === 'https:' ? https : http;
  const connect = () => new Promise((resolve, reject) => {
    const request = transport.get(url, {
      headers: { 'user-agent': 'TVBox-Web/1.0', ...headers },
      lookup: publicLookup,
      signal,
    }, resolve);
    request.setTimeout(15_000, () => request.destroy(new Error('片源响应超时。')));
    request.on('error', reject);
  });
  let response;
  try { response = await connect(); }
  catch (error) {
    if (signal?.aborted || !['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code)) throw error;
    response = await connect();
  }
  if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
    response.destroy();
    if (redirects >= 5) throw new Error('片源跳转次数过多。');
    const next = httpUrl(response.headers.location, url);
    const nextHeaders = next.origin === url.origin
      ? headers
      : Object.fromEntries(Object.entries(headers).filter(([key]) => !['cookie', 'authorization'].includes(key.toLowerCase())));
    return upstream(next, { headers: nextHeaders, signal, androidProxy }, redirects + 1);
  }
  return { response, url };
}

export async function readBody(response, maxBytes = 4 * 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('片源数据超过大小限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readRemote(url, headers = {}, { timeout = 18_000, androidProxy = false, signal: parentSignal } = {}) {
  const deadline = AbortSignal.timeout(timeout);
  const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;
  try {
    const { response, url: finalUrl } = await upstream(url, { headers, signal, androidProxy });
    if (response.statusCode >= 400) {
      response.destroy();
      throw new Error(`片源返回 HTTP ${response.statusCode}。`);
    }
    return { bytes: await readBody(response), url: finalUrl };
  } catch (error) {
    parentSignal?.throwIfAborted();
    if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') throw new Error('无法解析片源域名。');
    if (signal.aborted) throw new Error('连接片源超时。');
    throw error;
  }
}
