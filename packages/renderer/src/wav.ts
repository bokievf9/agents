/** Duration in seconds of a PCM WAV from its header (no ffprobe). Tolerates a data size of 0 or 0xFFFFFFFF from streaming writers. */
export function wavSeconds(buf: Buffer): number {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let byteRate = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(pos + 16);
    if (id === 'data') {
      const remaining = buf.length - (pos + 8);
      const bytes = size === 0 || size === 0xffffffff || size > remaining ? remaining : size;
      if (!byteRate) throw new Error('WAV has no fmt chunk');
      return bytes / byteRate;
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}
