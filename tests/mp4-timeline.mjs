// Read composition timestamps directly. FFprobe applies decoder reorder offsets
// to an isolated B-frame fragment, which is not its browser presentation clock.
export function mp4Presentation(buffer, type) {
  function boxes(start = 0, end = buffer.length) {
    const result = [];
    while (start + 8 <= end) {
      let size = buffer.readUInt32BE(start), header = 8;
      if (size === 1) { size = Number(buffer.readBigUInt64BE(start + 8)); header = 16; }
      if (size === 0) size = end - start;
      if (size < header || start + size > end) throw new Error('Invalid MP4 box');
      result.push({ type: buffer.toString('ascii', start + 4, start + 8), data: start + header, end: start + size });
      start += size;
    }
    return result;
  }
  const children = (box) => boxes(box.data, box.end);
  const root = boxes();
  const tracks = new Map();
  for (const trak of children(root.find((box) => box.type === 'moov')).filter((box) => box.type === 'trak')) {
    const childrenTrak = children(trak);
    const tkhd = childrenTrak.find((box) => box.type === 'tkhd');
    const id = buffer.readUInt32BE(tkhd.data + (buffer[tkhd.data] === 1 ? 20 : 12));
    const mdia = children(childrenTrak.find((box) => box.type === 'mdia'));
    const mdhd = mdia.find((box) => box.type === 'mdhd');
    const timescale = buffer.readUInt32BE(mdhd.data + (buffer[mdhd.data] === 1 ? 20 : 12));
    const hdlr = mdia.find((box) => box.type === 'hdlr');
    tracks.set(id, { timescale, type: buffer.toString('ascii', hdlr.data + 8, hdlr.data + 12) });
  }
  const ranges = [];
  for (const moof of root.filter((box) => box.type === 'moof')) {
    for (const traf of children(moof).filter((box) => box.type === 'traf')) {
      const items = children(traf);
      const tfhd = items.find((box) => box.type === 'tfhd');
      const tfhdFlags = buffer.readUIntBE(tfhd.data + 1, 3);
      const track = tracks.get(buffer.readUInt32BE(tfhd.data + 4));
      if (track.type !== (type === 'video' ? 'vide' : 'soun')) continue;
      let p = tfhd.data + 8;
      if (tfhdFlags & 1) p += 8;
      if (tfhdFlags & 2) p += 4;
      const defaultDuration = tfhdFlags & 8 ? buffer.readUInt32BE(p) : 0;
      const tfdt = items.find((box) => box.type === 'tfdt');
      let dts = buffer[tfdt.data] === 1 ? Number(buffer.readBigUInt64BE(tfdt.data + 4)) : buffer.readUInt32BE(tfdt.data + 4);
      for (const trun of items.filter((box) => box.type === 'trun')) {
        const flags = buffer.readUIntBE(trun.data + 1, 3);
        const count = buffer.readUInt32BE(trun.data + 4);
        p = trun.data + 8;
        if (flags & 1) p += 4;
        if (flags & 4) p += 4;
        for (let i = 0; i < count; i++) {
          const duration = flags & 0x100 ? buffer.readUInt32BE(p) : defaultDuration;
          if (flags & 0x100) p += 4;
          if (flags & 0x200) p += 4;
          if (flags & 0x400) p += 4;
          const offset = flags & 0x800 ? (buffer[trun.data] === 1 ? buffer.readInt32BE(p) : buffer.readUInt32BE(p)) : 0;
          if (flags & 0x800) p += 4;
          ranges.push({ start: (dts + offset) / track.timescale, end: (dts + offset + duration) / track.timescale });
          dts += duration;
        }
      }
    }
  }
  return { start: Math.min(...ranges.map((range) => range.start)), end: Math.max(...ranges.map((range) => range.end)), count: ranges.length };
}
