import { upstream } from './upstream.mjs';

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const ebmlSignature = Buffer.from('1a45dfa3', 'hex');

export async function inspectMediaLayout(url, headers, signal) {
  const timeout = AbortSignal.timeout(10_000);
  const { response } = await upstream(url, {
    headers: { ...headers, range: 'bytes=0-31' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  try {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`夸克媒体服务器返回 HTTP ${response.statusCode}，请重试以重新取流。`);
    }
    let prefix = Buffer.alloc(0);
    for await (const chunk of response) {
      prefix = Buffer.concat([prefix, chunk.subarray(0, 12 - prefix.length)]);
      if (prefix.length >= 12) break;
    }
    const offset = prefix.subarray(0, 8).equals(pngSignature) ? 8 : 0;
    if (!prefix.subarray(offset, offset + 4).equals(ebmlSignature)) return undefined;
    const range = /^bytes 0-\d+\/(\d+)$/.exec(response.headers['content-range'] ?? '');
    const length = Number(range?.[1]) - offset;
    if (response.statusCode !== 206 || !Number.isSafeInteger(length) || length <= 0) {
      throw new Error('媒体服务器未提供可用的字节范围，无法读取 Matroska 原画。');
    }
    return { offset, length, type: 'video/x-matroska' };
  } finally {
    response.destroy();
  }
}

export function mediaByteRange({ offset, length }, header) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  let start = 0;
  let end = length - 1;
  if (match) {
    if (match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    } else if (match[2]) {
      start = Math.max(0, length - Number(match[2]));
    } else {
      return null;
    }
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null;
  return {
    start: start + offset,
    end: end + offset,
    contentRange: match ? `bytes ${start}-${end}/${length}` : undefined,
    length: end - start + 1,
  };
}
