function cueTime(value) {
  return value.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

export function embeddedSubtitles(video, subtitles, signal) {
  const preferred = subtitles.findIndex(track => track.lang === 'zh-Hans');
  return subtitles.map(({ lang, label }, index) => {
    const element = document.createElement('track');
    element.kind = 'subtitles';
    element.srclang = lang;
    element.label = label;
    element.default = index === (preferred === -1 ? 0 : preferred);
    video.append(element);
    const track = element.track;
    track.mode = element.default ? 'showing' : 'hidden';
    // A hidden track can collect cues before the viewer switches to it.
    signal.addEventListener('abort', () => element.remove(), { once: true });
    const seen = new Set();
    return () => {
      const decoder = new TextDecoder();
      let pending = '';
      return bytes => {
        pending += decoder.decode(bytes, { stream: Boolean(bytes) });
        let end;
        while ((end = pending.indexOf('\n\n')) !== -1 || (!bytes && pending)) {
          const block = end === -1 ? pending : pending.slice(0, end);
          pending = end === -1 ? '' : pending.slice(end + 2);
          const lines = block.trim().split('\n');
          const timing = lines.findIndex(line => line.includes(' --> '));
          if (timing < 0) continue;
          const [start, finish] = lines[timing].split(' --> ');
          const from = cueTime(start);
          const to = cueTime(finish.split(' ')[0]);
          if (!(from >= 0 && to > from && Number.isFinite(to))) continue;
          const text = lines.slice(timing + 1).join('\n');
          const key = `${from}/${to}/${text}`;
          if (seen.has(key)) continue;
          track.addCue(new VTTCue(from, to, text));
          seen.add(key);
        }
      };
    };
  });
}

// Each record begins with its channel and payload length as two big-endian uint32 values.
export async function* splitMedia(reader, subtitles) {
  const header = new Uint8Array(8);
  let filled = 0;
  let remaining = 0;
  let channel = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (let offset = 0; offset < value.length;) {
      if (!remaining) {
        const size = Math.min(8 - filled, value.length - offset);
        header.set(value.subarray(offset, offset + size), filled);
        filled += size;
        offset += size;
        if (filled < 8) continue;
        const data = new DataView(header.buffer);
        channel = data.getUint32(0);
        remaining = data.getUint32(4);
        filled = 0;
        if (!remaining || channel > subtitles.length) throw new Error('原画字幕数据格式无效。');
      }
      const size = Math.min(remaining, value.length - offset);
      if (!size) continue;
      const bytes = value.subarray(offset, offset + size);
      offset += size;
      remaining -= size;
      if (channel === 0) yield bytes;
      else subtitles[channel - 1](bytes);
    }
  }
  if (filled || remaining) throw new Error('原画字幕数据传输中断。');
  for (const finish of subtitles) finish();
}
