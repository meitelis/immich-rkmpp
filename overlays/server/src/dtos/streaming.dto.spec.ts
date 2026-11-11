import { HlsMainPlaylistQueryDto } from 'src/dtos/streaming.dto.js';

describe(HlsMainPlaylistQueryDto.name, () => {
  it.each([undefined, 'h264', 'hevc'])('accepts the optional codec %s', (videoCodec) => {
    expect(HlsMainPlaylistQueryDto.create({ videoCodec }).videoCodec).toBe(videoCodec);
  });

  it.each(['av1', 'vp9', '', 'H264', ['h264', 'hevc'], null])('rejects invalid codec %j', (videoCodec) => {
    expect(() => HlsMainPlaylistQueryDto.create({ videoCodec })).toThrow();
  });

  it('allows existing authentication query parameters', () => {
    expect(HlsMainPlaylistQueryDto.create({ videoCodec: 'h264', key: 'share-key', password: 'share-password' })).toEqual({
      videoCodec: 'h264',
    });
  });
});
