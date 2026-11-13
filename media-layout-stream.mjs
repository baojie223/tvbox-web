import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mediaByteRange } from './media-layout.mjs';
import { upstream } from './upstream.mjs';

const chunkSize = 4 * 1024 * 1024;

export async function sendLayoutMedia(url, options, layout, req, res) {
  const range = mediaByteRange(layout, req.headers.range);
  if (!range) return res.writeHead(416, { 'Content-Range': `bytes */${layout.length}` }).end();
  const total = layout.length + layout.offset;
  const lastByte = start => Math.min(start + chunkSize - 1, range.end);

  async function part(start, end) {
    const { response } = await upstream(url, {
      ...options, headers: { ...options.headers, range: `bytes=${start}-${end}` },
    });
    if (response.statusCode === 206 && response.headers['content-range'] === `bytes ${start}-${end}/${total}`) {
      return { response };
    }
    const status = [403, 404, 410, 412].includes(response.statusCode) ? response.statusCode : 502;
    response.destroy();
    return { status };
  }

  const head = req.method === 'HEAD';
  const first = await part(range.start, head ? range.start : lastByte(range.start));
  if (!first.response) return res.writeHead(first.status).end();
  let current = first.response;
  try {
    res.setHeader('Content-Type', layout.type);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', range.length);
    if (range.contentRange) res.setHeader('Content-Range', range.contentRange);
    res.writeHead(range.contentRange ? 206 : 200);
    if (head) return res.end();
    const source = Readable.from((async function* () {
      for (let start = range.start; start <= range.end; start += chunkSize) {
        if (!current) {
          const next = await part(start, lastByte(start));
          if (!next.response) throw new Error(`原画分段请求失败（HTTP ${next.status}）。`);
          current = next.response;
        }
        yield* current;
        current = undefined;
      }
    })());
    await pipeline(source, res);
  } finally {
    current?.destroy();
  }
}
