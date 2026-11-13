import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';

const require = createRequire(import.meta.url);
const ffmpeg = process.env.TVBOX_FFMPEG || (() => {
  try { return require.resolve('@ffmpeg-installer/win32-x64/ffmpeg.exe'); }
  catch { return 'ffmpeg'; }
})();

function openMedia(url, signal, input = [], output = [], subtitleCount = 0) {
  return spawn(ffmpeg, [
    '-hide_banner', '-nostdin', '-protocol_whitelist', 'http,tcp', '-rw_timeout', '15000000',
    ...input, '-analyzeduration', '1000000', '-probesize', '1048576', '-f', 'matroska', '-i', url, ...output,
  ], { stdio: ['ignore', 'pipe', 'pipe', ...Array(subtitleCount).fill('pipe')], windowsHide: true, signal });
}

const textSubtitles = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'text', 'mov_text']);

function subtitleTracks(info) {
  const tracks = [];
  const stream = /(?:^|\n)[ \t]*Stream #0:(\d+)(?:\(([^)]+)\))?: (\w+): (\w+)[^\r\n]*([\s\S]*?)(?=\r?\n[ \t]*Stream #|$)/g;
  for (const [, index, language, type, codec, metadata] of info.matchAll(stream)) {
    if (type !== 'Subtitle' || !textSubtitles.has(codec)) continue;
    const title = /^\s*title\s*:\s*(.+)$/m.exec(metadata)?.[1]?.trim();
    const chinese = /^(?:chi|zho|cmn|zh)(?:[-_]|$)/i.test(language ?? '');
    let lang = language === 'eng' ? 'en' : language ?? 'und';
    let label = title || (language === 'eng' ? 'English' : `字幕 ${tracks.length + 1}`);
    if (chinese || /simplified|traditional|简体|繁體|繁体/i.test(title ?? '')) {
      const traditional = /traditional|繁體|繁体|hant/i.test(`${title} ${language}`);
      lang = traditional ? 'zh-Hant' : 'zh-Hans';
      label = traditional ? '繁體中文' : '简体中文';
    }
    tracks.push({ index: Number(index), lang, label });
  }
  return tracks;
}

export async function inspectCompatibleMedia(url, signal) {
  const child = openMedia(url, AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
  child.stdout.resume();
  let info = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { info = (info + chunk).slice(-32768); });
  await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', error => reject(error.code === 'ENOENT'
      ? new Error('花卷原画需要 FFmpeg 检查音轨。请运行 npm ci，或通过 TVBOX_FFMPEG 指定 FFmpeg。')
      : new Error('花卷原画音轨检查超时或中断。')));
  });
  const [, video, profile] = /Stream #\d+:\d+[^\r\n]*: Video: (\w+)(?: \(([^)]+)\))?/.exec(info) ?? [];
  if (!video) throw new Error('无法读取花卷原画的音视频轨道。');
  const audio = /Stream #\d+:\d+[^\r\n]*: Audio: (\w+)/.exec(info)?.[1];
  const subtitles = subtitleTracks(info);
  const convertAudio = audio && !['aac', 'mp3', 'opus', 'vorbis'].includes(audio);
  const time = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
  const duration = time && (Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]));
  const canRemux = duration && ['hevc', 'h264'].includes(video);
  if (!convertAudio && (!subtitles.length || !canRemux)) return null;
  if (!canRemux) throw new Error('此原画格式无法转换为浏览器兼容播放。');
  const codec = video === 'hevc'
    ? (profile === 'Main 10' ? 'hvc1.2.4.L153.B0' : 'hvc1.1.6.L153.B0')
    : ({ Main: 'avc1.4d0028', 'Constrained Baseline': 'avc1.42e028', Baseline: 'avc1.420028' })[profile] ?? 'avc1.640028';
  return { duration, video, codec, audio: audio ? (audio === 'aac' ? 'copy' : 'aac') : null, subtitles };
}

export async function sendCompatibleMedia(url, start, media, signal, res) {
  const { video, audio, subtitles } = media;
  // Reuse the original video and its timestamps so the browser can seek on the original timeline.
  const audioArgs = audio === 'copy' ? ['-map', '0:a:0', '-c:a', 'copy']
    : audio ? ['-map', '0:a:0', '-c:a', 'aac', '-ac', '2', '-b:a', '192k'] : [];
  const child = openMedia(url, signal, ['-loglevel', 'error', '-ss', String(start), '-copyts', '-noaccurate_seek'], [
    '-map', '0:v:0', ...audioArgs, '-map_chapters', '-1', '-c:v', 'copy', '-tag:v', video === 'hevc' ? 'hvc1' : 'avc1',
    '-avoid_negative_ts', 'disabled',
    '-movflags', '+delay_moov+default_base_moof+frag_keyframe', '-f', 'mp4', 'pipe:1',
    ...subtitles.flatMap(({ index }, i) => [
      '-map', `0:${index}`, '-map_chapters', '-1', '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', `pipe:${i + 3}`,
    ]),
  ], subtitles.length);
  child.stderr.resume();
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  closed.catch(() => {});
  // Wait for output before sending success, and terminate the subprocess if playback stops.
  try {
    const chunks = subtitles.length ? multiplex([child.stdout, ...child.stdio.slice(3)]) : child.stdout[Symbol.asyncIterator]();
    const first = await chunks.next();
    if (first.done) {
      await closed;
      throw new Error('原画音频转换没有产生数据。');
    }
    res.setHeader('Content-Type', subtitles.length ? 'application/octet-stream' : 'video/mp4');
    await pipeline((async function* () {
      yield first.value;
      yield* { [Symbol.asyncIterator]: () => chunks };
      if (await closed !== 0) throw new Error('原画音频转换中断。');
    })(), res, { signal });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

async function* multiplex(streams) {
  const iterators = streams.map(stream => stream[Symbol.asyncIterator]());
  const ready = [];
  let wake;
  let open = streams.length;
  function enqueue(result) {
    ready.push(result);
    wake?.();
  }
  const next = index => iterators[index].next().then(
    result => enqueue({ index, ...result }),
    error => enqueue({ error }),
  );
  iterators.forEach((_, index) => next(index));
  while (open) {
    if (!ready.length) await new Promise(resolve => { wake = resolve; });
    wake = undefined;
    const { index, done, value, error } = ready.shift();
    if (error) throw error;
    if (done) {
      open--;
      continue;
    }
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32BE(index, 0);
    header.writeUInt32BE(value.length, 4);
    yield Buffer.concat([header, value]);
    next(index);
  }
}
