import {
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import type { NextFunction, Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import { HLS_PLAYLIST_CONTENT_TYPE } from 'src/constants.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  HlsMainPlaylistQueryDto,
  HlsPlaylistHeaderDto,
  HlsSegmentHeaderDto,
  HlsSegmentParamDto,
  HlsSessionParamDto,
  HlsVariantParamDto,
} from 'src/dtos/streaming.dto.js';
import { ApiTag, ImmichHeader, Permission, RouteKey } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { HlsService } from 'src/services/hls.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
export class VideoStreamController {
  constructor(
    private logger: LoggingRepository,
    private service: HlsService,
  ) {}

  @Get(':id/video/stream/original-info')
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Header('Cache-Control', 'private, no-store')
  @Endpoint({
    summary: 'Get original playback capabilities',
    description: 'Returns indexed codec, container and bitrate information for a conservative direct-play decision.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getOriginalInfo(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.service.getOriginalPlaybackInfo(auth, id);
  }

  @Get(':id/video/stream/network-probe')
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Header('Cache-Control', 'private, no-store, no-transform')
  @Header('Content-Type', 'application/octet-stream')
  @Endpoint({
    summary: 'Measure direct playback network capacity',
    description: 'Returns one MiB of uncached random bytes over the authenticated media origin.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  async getOriginalProbe(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Query('bytes') bytes?: string) {
    return new StreamableFile(await this.service.getOriginalNetworkProbe(auth, id, bytes));
  }

  @Get(':id/video/stream/main.m3u8')
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Header('Cache-Control', 'no-cache')
  @Header('Content-Type', HLS_PLAYLIST_CONTENT_TYPE)
  @ApiProduces(HLS_PLAYLIST_CONTENT_TYPE)
  @Endpoint({
    summary: 'Get HLS main playlist',
    description:
      'Returns an HLS main playlist with available variants, optionally restricted to a configured video codec.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getMainPlaylist(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() { videoCodec, strategy, copy }: HlsMainPlaylistQueryDto,
  ) {
    return this.service.getMainPlaylist(auth, id, videoCodec, { strategy, copy });
  }

  @Get(':id/video/stream/:sessionId/:variantIndex/playlist.m3u8')
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Header('Cache-Control', 'no-cache')
  @Header('Content-Type', HLS_PLAYLIST_CONTENT_TYPE)
  @ApiProduces(HLS_PLAYLIST_CONTENT_TYPE)
  @Endpoint({
    summary: 'Get HLS media playlist',
    description: 'Returns an HLS media playlist for one variant of the streaming session.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getMediaPlaylist(
    @Auth() auth: AuthDto,
    @Param() { id, sessionId, variantIndex }: HlsVariantParamDto,
    @Headers() headers: HlsPlaylistHeaderDto,
    @Query('strategy') strategy?: string,
  ) {
    try {
      headers = HlsPlaylistHeaderDto.create(headers);
    } catch (error) {
      throw new ZodValidationException(error);
    }
    return this.service.getMediaPlaylist(
      auth,
      id,
      sessionId,
      variantIndex,
      headers[ImmichHeader.HlsPosition],
      strategy,
    );
  }

  @Get(':id/video/stream/:sessionId/:variantIndex/:filename')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'Get HLS segment or init file',
    description: 'Streams an HLS init segment (init.mp4) or media segment (seg_N.m4s).',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  async getSegment(
    @Auth() auth: AuthDto,
    @Param() { id, sessionId, variantIndex, filename }: HlsSegmentParamDto,
    @Headers() headers: HlsSegmentHeaderDto,
    @Res() res: Response,
    @Next() next: NextFunction,
    @Query('strategy') strategy?: string,
  ) {
    try {
      headers = HlsSegmentHeaderDto.create(headers);
    } catch (error) {
      throw new ZodValidationException(error);
    }
    await sendFile(
      res,
      next,
      () =>
        this.service.getSegment(
          auth,
          id,
          sessionId,
          variantIndex,
          filename,
          headers[ImmichHeader.HlsInitSegment],
          strategy,
        ),
      this.logger,
    );
  }

  @Delete(':id/video/stream/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'End HLS streaming session',
    description: 'Releases server resources for the streaming session.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  async endSession(@Auth() auth: AuthDto, @Param() { id, sessionId }: HlsSessionParamDto) {
    await this.service.endSession(auth, id, sessionId);
  }
}
