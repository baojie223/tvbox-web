import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';

test('the proxy handles HLS, byte ranges, upstream errors and private media cookies', async t => {
  const segment = Buffer.concat([Buffer.from('....ftyp'), Buffer.alloc(40)]);
  const chunkSize = 4 * 1024 * 1024;
  const matroska = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.alloc(chunkSize + 40, 1)]);
  const wrapped = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), matroska]);
  const wrappedRanges = [];
  const upstream = createServer(async (req, res) => {
    const part = new URL(req.url, 'http://127.0.0.1').searchParams.get('part');
    if (part === 'missing') return res.writeHead(404).end();
    if (part === 'session') return res.writeHead(412).end();
    if (part === 'cookie') {
      if (req.headers.cookie !== '__pugs=fixture-session') return res.writeHead(403).end();
      return res.writeHead(200, { 'Content-Type': 'video/mp4' }).end(segment);
    }
    if (part === 'wrapped') {
      wrappedRanges.push(req.headers.range);
      const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range) ?? [];
      if (!first || !last) return res.writeHead(416).end();
      const bytes = wrapped.subarray(Number(first), Number(last) + 1);
      return res.writeHead(206, { 'Content-Range': `bytes ${first}-${last}/${wrapped.length}` }).end(bytes);
    }
    if (part === 'segment') {
      if (req.headers.range === 'bytes=0-15') {
        return res.writeHead(206, { 'Content-Range': 'bytes 0-15/48' }).end(segment.subarray(0, 16));
      }
      return res.end(segment);
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write('#EX');
    await setTimeout(25);
    res.end('TM3U\n#EXTINF:4,\n/proxy?part=segment\n');
  }).listen(0, '127.0.0.1');
  t.after(() => upstream.close());
  await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  process.env.TVBOX_ANDROID_PORT = String(upstreamPort);
  const { playback, sendMedia } = await import('./media.mjs');
  const proxy = createServer((req, res) => {
    sendMedia(req.url.slice(7), req, res).catch(error => res.destroy(error));
  }).listen(0, '127.0.0.1');
  t.after(() => proxy.close());
  await once(proxy, 'listening');
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const media = part => playback({ url: `http://127.0.0.1:${upstreamPort}/proxy?part=${part}`, androidProxy: true });

  const playlist = media('playlist');
  assert.equal(playlist.hls, null);
  const head = await fetch(origin + playlist.url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.match(head.headers.get('content-type'), /mpegurl/);
  assert.equal(await head.text(), '');

  const manifest = await fetch(origin + playlist.url).then(res => res.text());
  const rewrittenSegment = manifest.split('\n').find(line => line.startsWith('/media/'));
  assert(rewrittenSegment);
  const range = await fetch(origin + rewrittenSegment, { headers: { Range: 'bytes=0-15' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-type'), 'video/mp4');
  assert.equal(range.headers.get('content-range'), 'bytes 0-15/48');
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), segment.subarray(0, 16));

  const missing = await fetch(origin + media('missing').url, { method: 'HEAD' });
  assert.equal(missing.status, 404);
  const rejectedSession = await fetch(origin + media('session').url, { method: 'HEAD' });
  assert.equal(rejectedSession.status, 412);

  const privateMedia = playback({
    url: `http://127.0.0.1:${upstreamPort}/proxy?part=cookie`,
    androidProxy: true,
    privateCookie: '__pugs=fixture-session',
  });
  const payload = JSON.parse(Buffer.from(privateMedia.url.slice(7).split('.')[0], 'base64url').toString('utf8'));
  assert(payload.encryptedCookie);
  assert(!JSON.stringify(payload).includes('fixture-session'));
  const authorized = await fetch(origin + privateMedia.url);
  assert.equal(authorized.status, 200);
  assert.deepEqual(Buffer.from(await authorized.arrayBuffer()), segment);

  const virtual = playback({
    url: `http://127.0.0.1:${upstreamPort}/proxy?part=wrapped`, androidProxy: true,
    layout: { offset: 8, length: matroska.length, type: 'video/x-matroska' },
  });
  const ranged = await fetch(origin + virtual.url, { headers: { Range: 'bytes=0-7' } });
  assert.equal(ranged.headers.get('content-range'), `bytes 0-7/${matroska.length}`);
  assert.equal(ranged.headers.get('content-type'), 'video/x-matroska');
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), matroska.subarray(0, 8));
  const suffix = await fetch(origin + virtual.url, { headers: { Range: 'bytes=-4' } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), matroska.subarray(-4));
  const whole = await fetch(origin + virtual.url);
  assert.equal(whole.status, 200);
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), matroska);
  assert.deepEqual(wrappedRanges.slice(-2), [`bytes=8-${chunkSize + 7}`, `bytes=${chunkSize + 8}-${wrapped.length - 1}`]);
});
