import { embeddedSubtitles, splitMedia } from './embedded-subtitles.js';

function waitFor(target, event, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(event, done);
      signal.removeEventListener('abort', abort);
    };
    const done = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(signal.reason); };
    target.addEventListener(event, done, { once: true });
    signal.addEventListener('abort', abort, { once: true });
  });
}

function* mp4Boxes(data, start = 0, end = data.byteLength) {
  for (let offset = start; offset + 8 <= end;) {
    const size = data.getUint32(offset);
    if (size < 8 || offset + size > end) return;
    yield { type: data.getUint32(offset + 4), start: offset + 8, end: offset + size };
    offset += size;
  }
}

function movieStart(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const find = (type, parent) => [...mp4Boxes(data, parent?.start, parent?.end)].find(box => box.type === type);
  const movie = find(0x6d6f6f76); // moov
  if (!movie) return undefined;
  const header = find(0x6d766864, movie); // mvhd
  const track = find(0x7472616b, movie); // First track is video.
  const edit = track && find(0x65647473, track);
  const list = edit && find(0x656c7374, edit);
  if (!header || !list || list.start + 16 > list.end) return 0;
  const timescaleOffset = header.start + (data.getUint8(header.start) ? 20 : 12);
  if (timescaleOffset + 4 > header.end) return 0;
  const timescale = data.getUint32(timescaleOffset);
  if (!timescale) return 0;
  const version = data.getUint8(list.start);
  if (version === 1) {
    return list.start + 24 <= list.end && data.getBigInt64(list.start + 16) === -1n
      ? Number(data.getBigUint64(list.start + 8)) / timescale : 0;
  }
  return data.getInt32(list.start + 12) === -1 ? data.getUint32(list.start + 8) / timescale : 0;
}

export async function playCompatibleMedia(video, media, signal, play, fail) {
  const { codec, audio, subtitles } = media.compatible;
  const type = `video/mp4; codecs="${codec}${audio ? ', mp4a.40.2' : ''}"`;
  if (!window.MediaSource?.isTypeSupported(type)) {
    throw new Error('当前浏览器无法播放这条原画的 MP4 视频编码。');
  }
  const source = new MediaSource();
  const objectUrl = URL.createObjectURL(source);
  signal.addEventListener('abort', () => URL.revokeObjectURL(objectUrl), { once: true });
  const opened = waitFor(source, 'sourceopen', signal);
  video.src = objectUrl;
  play();
  await opened;
  const buffer = source.addSourceBuffer(type);
  source.duration = media.compatible.duration;
  const subtitleReaders = embeddedSubtitles(video, subtitles, signal);

  let request;
  let pending = Promise.resolve();
  let loadingStart = 0;

  function load(start) {
    loadingStart = start;
    request?.abort();
    request = new AbortController();
    const active = AbortSignal.any([signal, request.signal]);
    pending = pending.then(async () => {
      active.throwIfAborted();
      if (buffer.updating) await waitFor(buffer, 'updateend', active);
      buffer.abort();
      if (buffer.buffered.length) {
        buffer.remove(0, Infinity);
        await waitFor(buffer, 'updateend', active);
      }
      const response = await fetch(`${media.url}?start=${start}`, { signal: active });
      if (!response.ok) throw new Error(`原画音频转换失败（HTTP ${response.status}）。`);
      const reader = response.body.getReader();
      try {
        let init = new Uint8Array();
        const chunks = subtitleReaders.length
          ? splitMedia(reader, subtitleReaders.map(createReader => createReader()))
          : { [Symbol.asyncIterator]: () => ({ next: () => reader.read() }) };
        for await (let value of chunks) {
          active.throwIfAborted();
          if (init) {
            const bytes = new Uint8Array(init.length + value.length);
            bytes.set(init);
            bytes.set(value, init.length);
            const offset = movieStart(bytes);
            if (offset === undefined) {
              if (bytes.length > 1024 * 1024) throw new Error('原画转换缺少 MP4 初始化数据。');
              init = bytes;
              continue;
            }
            // Chromium uses the fragment timeline. FFmpeg puts the seek offset in an empty edit.
            buffer.timestampOffset = offset;
            value = bytes;
            init = null;
          }
          buffer.appendBuffer(value);
          await waitFor(buffer, 'updateend', active);
          while (buffer.buffered.length && buffer.buffered.end(buffer.buffered.length - 1) > video.currentTime + 12) {
            await waitFor(video, 'timeupdate', active);
          }
          const keepFrom = video.currentTime - 20;
          if (buffer.buffered.length && buffer.buffered.start(0) + 5 < keepFrom) {
            buffer.remove(0, keepFrom);
            await waitFor(buffer, 'updateend', active);
          }
        }
        if (source.readyState === 'open' && buffer.buffered.length &&
            buffer.buffered.end(buffer.buffered.length - 1) >= media.compatible.duration - 0.5) {
          source.endOfStream();
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    }).catch(error => { if (!active.aborted) fail(error.message); });
  }

  video.addEventListener('seeking', () => {
    const time = video.currentTime;
    if (!buffer.buffered.length && time === loadingStart) return;
    for (let i = 0; i < buffer.buffered.length; i++) {
      if (time >= buffer.buffered.start(i) && time <= buffer.buffered.end(i)) return;
    }
    load(Math.min(time, media.compatible.duration - 0.001));
  }, { signal });
  load(0);
}
