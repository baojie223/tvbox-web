import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { quarkAccount } from './quark-auth.mjs';
import { androidPlaylistAddress, androidProxyAddress, httpUrl, isPublicUrl, readBody, upstream } from './upstream.mjs';

const secret = randomBytes(32);
const cookieKey = randomBytes(32);
const sign = payload => createHmac('sha256', secret).update(payload).digest('base64url');
const mediaTypes = new Map([
  ['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['webm', 'video/webm'], ['ogv', 'video/ogg'],
  ['mp3', 'audio/mpeg'], ['m4a', 'audio/mp4'], ['aac', 'audio/aac'], ['ts', 'video/mp2t'], ['vtt', 'text/vtt'],
]);

function encryptCookie(cookie) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cookieKey, nonce);
  const encrypted = Buffer.concat([cipher.update(cookie, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function decryptCookie(value) {
  const bytes = Buffer.from(value, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', cookieKey, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
}

function mediaPath(url, headers, expires, androidProxy, encryptedCookie, quarkSession, layout, compatible) {
  const payload = Buffer.from(JSON.stringify({ url, headers, expires, androidProxy, encryptedCookie, quarkSession, layout, compatible })).toString('base64url');
  return `/media/${payload}.${sign(payload)}`;
}

export function playback({ url, headers, androidProxy, hls, privateCookie, quarkSession, layout, compatible }) {
  const extension = httpUrl(url).pathname.split('.').at(-1).toLowerCase();
  return {
    url: mediaPath(url, headers, Date.now() + 12 * 60 * 60 * 1000, androidProxy, privateCookie ? encryptCookie(privateCookie) : undefined, quarkSession, layout, compatible),
    hls: hls ?? (extension === 'm3u8' ? true : mediaTypes.has(extension) ? false : null),
    compatible,
  };
}

function decodeToken(token) {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const actual = Buffer.from(signature);
  const expected = Buffer.from(sign(payload));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return grant.expires > Date.now() ? grant : null;
}

export function rewritePlaylist(text, base, wrap, androidProxy = false) {
  function rewrite(value) {
    if (/^(?:data|skd):/i.test(value)) return value;
    const proxy = androidProxy && (androidPlaylistAddress(value) || androidProxyAddress(value, base));
    if (proxy) return wrap(proxy);
    try {
      const url = httpUrl(value, base);
      return isPublicUrl(url) ? wrap(url.href) : '/media/unavailable';
    } catch {
      return '/media/unavailable';
    }
  }
  return text.split(/\r?\n/).map(line => {
    if (line.startsWith('#')) return line.replace(/([:,]URI=")([^"]+)(")/g, (_, before, value, after) => before + rewrite(value) + after);
    return line.trim() ? rewrite(line.trim()) : line;
  }).join('\n');
}

export async function sendMedia(token, req, res, origin, params) {
  const grant = decodeToken(token);
  if (!grant) return res.writeHead(404).end();
  const { url, headers, expires, androidProxy, encryptedCookie, quarkSession, layout } = grant;
  const outgoing = { ...headers };
  if (encryptedCookie) outgoing.cookie = decryptCookie(encryptedCookie);
  if (quarkSession) {
    if (!quarkAccount(quarkSession)) return res.writeHead(403).end();
    const target = httpUrl(url);
    if (target.protocol !== 'https:' || !target.hostname.endsWith('.quark.cn')) return res.writeHead(403).end();
  }
  if (req.headers.range && /^bytes=\d*-\d*$/.test(req.headers.range)) outgoing.range = req.headers.range;
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once('close', abort);
  try {
    if (grant.compatible) {
      const start = Number(params?.get('start') ?? 0);
      if (!Number.isFinite(start) || start < 0 || start >= grant.compatible.duration) return res.writeHead(400).end();
      if (req.method === 'HEAD') return res.writeHead(200, {
        'Content-Type': grant.compatible.subtitles.length ? 'application/octet-stream' : 'video/mp4',
      }).end();
      const input = mediaPath(url, headers, expires, androidProxy, encryptedCookie, quarkSession, layout);
      const { sendCompatibleMedia } = await import('./media-compat.mjs');
      return await sendCompatibleMedia(origin + input, start, grant.compatible, controller.signal, res);
    }
    const options = { headers: outgoing, signal: controller.signal, androidProxy };
    if (layout) {
      const { sendLayoutMedia } = await import('./media-layout-stream.mjs');
      return await sendLayoutMedia(url, options, layout, req, res);
    }
    const { response, url: finalUrl } = await upstream(url, options);
    const status = response.statusCode;
    if (status < 200 || status >= 300) {
      const range = response.headers['content-range'];
      response.destroy();
      if (status === 416 && range) res.setHeader('Content-Range', range);
      const mediaStatus = [403, 404, 410, 412, 416].includes(status) ? status : 502;
      return res.writeHead(mediaStatus).end();
    }
    const type = String(response.headers['content-type'] ?? '').split(';')[0].toLowerCase();
    const extension = finalUrl.pathname.split('.').at(-1).toLowerCase();
    const chunks = response[Symbol.asyncIterator]();
    const initialChunks = [];
    let length = 0;
    while (length < 32) {
      const { done, value } = await chunks.next();
      if (done) break;
      initialChunks.push(value);
      length += value.length;
    }
    const prefix = Buffer.concat(initialChunks, Math.min(32, length));
    const isPlaylist = prefix.toString('utf8').trimStart().startsWith('#EXTM3U');
    const source = () => Readable.from((async function* () {
      yield* initialChunks;
      yield* { [Symbol.asyncIterator]: () => chunks };
    })());
    if (isPlaylist && status === 200) {
      if (req.method === 'HEAD') {
        response.destroy();
        return res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end();
      }
      const manifest = (await readBody(source(), 2 * 1024 * 1024)).toString('utf8').replace(/^\uFEFF/, '');
      const rewritten = rewritePlaylist(manifest, finalUrl, next => mediaPath(next, headers, expires, androidProxy), androidProxy);
      return res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8' }).end(rewritten);
    }
    if (extension === 'm3u8' || /(?:mpegurl|html|json)/.test(type)) {
      response.destroy();
      return res.writeHead(502).end();
    }
    const detectedType = prefix.subarray(4, 8).toString('ascii') === 'ftyp' ? 'video/mp4' : 'application/octet-stream';
    const contentType = /^(?:audio|video)\//.test(type) ? type : mediaTypes.get(extension) ?? detectedType;
    res.setHeader('Content-Type', contentType);
    for (const key of ['content-length', 'content-range', 'accept-ranges']) {
      if (response.headers[key]) res.setHeader(key, response.headers[key]);
    }
    res.writeHead(status);
    if (req.method === 'HEAD') {
      response.destroy();
      return res.end();
    }
    await pipeline(source(), res);
  } finally {
    res.off('close', abort);
  }
}
