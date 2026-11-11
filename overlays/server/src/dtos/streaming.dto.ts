import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { ImmichHeader } from 'src/enum.js';

const HlsMainPlaylistQuerySchema = z.object({
  // Restricts the advertised ladder without enabling a server-disabled codec.
  videoCodec: z.enum(['h264', 'hevc']).optional(),
  strategy: z.literal('memories').optional(),
  // Explicit MSE capability; the server still validates the indexed source.
  copy: z.enum(['avc', 'hevc', 'hevc10']).optional(),
});

export class HlsMainPlaylistQueryDto extends createZodDto(HlsMainPlaylistQuerySchema) {}

const HlsSessionParamSchema = z.object({
  id: z.uuidv4(),
  sessionId: z.uuidv4(),
});

export class HlsSessionParamDto extends createZodDto(HlsSessionParamSchema) {}

const HlsVariantParamSchema = z.object({
  id: z.uuidv4(),
  sessionId: z.uuidv4(),
  variantIndex: z.coerce.number().int().min(0),
});

export class HlsVariantParamDto extends createZodDto(HlsVariantParamSchema) {}

const HlsSegmentParamSchema = z.object({
  id: z.uuidv4(),
  sessionId: z.uuidv4(),
  variantIndex: z.coerce.number().int().min(0),
  filename: z.string().regex(/^(init\.mp4|seg_\d+\.m4s)$/, { error: 'Invalid HLS segment filename' }),
});

export class HlsSegmentParamDto extends createZodDto(HlsSegmentParamSchema) {}

const HlsSegmentHeaderSchema = z.object({
  // Lets the client hint at which segment will be loaded after init.mp4.
  [ImmichHeader.HlsInitSegment]: z.coerce.number().int().min(0).optional(),
});

export class HlsSegmentHeaderDto extends createZodDto(HlsSegmentHeaderSchema) {}

const HlsPlaylistHeaderSchema = z.object({
  // Lets the client hint at which segment will be loaded after the playlist.
  // A position rather than a segment index since indices aren't comparable across variants.
  [ImmichHeader.HlsPosition]: z.coerce.number().min(0).optional(),
});

export class HlsPlaylistHeaderDto extends createZodDto(HlsPlaylistHeaderSchema) {}
