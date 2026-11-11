import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { HlsMainPlaylistQueryDto } from 'src/dtos/streaming.dto.js';
import type { VideoPacketInfo, VideoStreamInfo } from 'src/types.js';
import { HLS_SEGMENT_DURATION, HLS_SEGMENT_FILENAME_REGEX, HLS_VARIANTS, HLS_VERSION } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ConfigFFmpegDto } from 'src/dtos/config.dto.js';
import { CacheControl, ImmichWorker, Permission } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { PendingEvents } from 'src/utils/event.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { getCodecString, getOutputSize } from 'src/utils/media.js';
import {
  audioSegments,
  copyCapability,
  originalVideoCodec,
  playbackPlaylist,
  type PlaybackPlan,
} from 'src/utils/hls-playback.js';

type AssetWithStreamInfo = { videoStream: VideoStreamInfo & { timeBase: number }; packets: VideoPacketInfo };
type Segmentation = { fps: number; framesPerSegment: number; segmentCount: number; segmentDuration: number };
type ApiSession = { lastRequestedSegment: number | null; lastVariantIndex: number | null; playback?: PlaybackPlan };

@Injectable()
export class HlsService extends BaseService {
  private pendingSegments = new PendingEvents<'HlsSegmentResult'>({ timeoutMs: 15_000 });
  private pendingSessions = new PendingEvents<'HlsSessionResult'>({ timeoutMs: 5000 });
  private sessions = new Map<string, ApiSession>();
  private pendingPlans = new PendingEvents<'HlsPlaybackPlanResult'>({ timeoutMs: 5000 });

  @OnEvent({ name: 'HlsPlaybackPlanResult', server: true, workers: [ImmichWorker.Api] })
  onPlaybackPlan(event: ArgOf<'HlsPlaybackPlanResult'>) {
    this.pendingPlans.complete(event.sessionId, event);
  }

  private async getPlaybackPlan(sessionId: string) {
    const session = this.trackSession(sessionId);
    if (session.playback) return session.playback;
    const pending = this.pendingPlans.wait(sessionId);
    this.websocketRepository.serverSend('HlsPlaybackPlanRequest', { sessionId });
    const result = await pending;
    if (!result.playback) throw new NotFoundException('Playback plan not found');
    session.playback = result.playback;
    return result.playback;
  }

  @OnEvent({ name: 'HlsSessionResult', server: true, workers: [ImmichWorker.Api] })
  onSessionResult(event: ArgOf<'HlsSessionResult'>) {
    this.pendingSessions.complete(event.sessionId, event);
    if (!event.error) {
      return;
    }

    this.sessions.delete(event.sessionId);
    this.pendingSegments.rejectByPrefix(`${event.sessionId}:`, event.error);
  }

  @OnEvent({ name: 'HlsSessionEnd', server: true, workers: [ImmichWorker.Api] })
  onSessionEnd({ sessionId }: ArgOf<'HlsSessionEnd'>) {
    this.sessions.delete(sessionId);
    this.pendingSegments.rejectByPrefix(`${sessionId}:`, 'Session ended');
  }

  @OnEvent({ name: 'HlsSegmentResult', server: true, workers: [ImmichWorker.Api] })
  onSegmentResult(event: ArgOf<'HlsSegmentResult'>) {
    this.pendingSegments.complete(this.getSegmentKey(event), event);
  }

  // Indexed codec metadata for the browser's Original eligibility check.
  // Reuses indexed streams; no FFprobe, no original path and no transcoder start.
  async getOriginalPlaybackInfo(auth: AuthDto, assetId: string) {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [assetId] });
    const asset = await this.videoStreamRepository.getForTranscoding(assetId);
    if (!asset) {
      throw new NotFoundException('Video metadata is not available');
    }
    const video = asset.videoStream;
    return {
      videoCodec: video.codecName,
      videoProfile: video.profile,
      videoLevel: video.level,
      pixelFormat: video.pixelFormat,
      colorTransfer: video.colorTransfer,
      dvProfile: video.dvProfile,
      rotation: video.rotation,
    };
  }

  // Incompressible same-origin response: bounded network measurement without
  // reading a private original or creating a hardware transcode session.
  async getOriginalNetworkProbe(auth: AuthDto, assetId: string, bytes?: string) {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [assetId] });
    const length = bytes === undefined ? 1024 * 1024 : Number(bytes);
    if (![65536, 131072, 393216, 1048576, 1572864].includes(length))
      throw new BadRequestException('Invalid probe size');
    return randomBytes(length);
  }

  async getMainPlaylist(
    auth: AuthDto,
    assetId: string,
    videoCodec?: HlsMainPlaylistQueryDto['videoCodec'],
    options?: Pick<HlsMainPlaylistQueryDto, 'strategy' | 'copy'>,
  ) {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [assetId] });
    const { ffmpeg } = await this.getConfig({ withCache: true });
    if (!ffmpeg.realtime.enabled) {
      throw new BadRequestException('Real-time transcoding is not enabled');
    }

    const asset = await this.videoStreamRepository.getForMainPlaylist(assetId);
    if (!asset) {
      throw new NotFoundException('Asset metadata is not yet ready for streaming');
    }

    // Sharing the sessionId allows only one microservices worker to successfully insert to the session table.
    // The microservices worker that creates a session owns the transcoding lifecycle for it.
    const sessionId = this.cryptoRepository.randomUUID();
    const playback =
      options?.strategy === 'memories' && ffmpeg.accel === 'rkmpp'
        ? await this.preparePlaybackPlan(assetId, options.copy, videoCodec)
        : undefined;
    // Validate the ladder before creating a session that would have no usable variants.
    const playlist = this.generateMainPlaylist(sessionId, ffmpeg, asset, videoCodec, playback);
    this.websocketRepository.serverSend('HlsSessionRequest', {
      sessionId,
      assetId,
      ownerId: auth.user.id,
      ...(playback ? { playback } : {}),
    });
    await this.pendingSessions.wait(sessionId);
    this.trackSession(sessionId).playback = playback;

    return playlist;
  }

  async getMediaPlaylist(
    auth: AuthDto,
    assetId: string,
    sessionId: string,
    variantIndex: number,
    position?: number,
    strategy?: string,
  ) {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [assetId] });

    const asset = await this.videoStreamRepository.getForMediaPlaylist(assetId, sessionId);
    if (!asset) {
      throw new NotFoundException('Asset not found or metadata not yet ready for streaming');
    }

    if (strategy === 'memories') {
      const plan = await this.getPlaybackPlan(sessionId);
      this.validatePlaybackVariant(plan, variantIndex);
      const isAudio = variantIndex === HLS_VARIANTS.length + 1;
      const segments = isAudio ? audioSegments(plan.duration) : plan.segments;
      if (segments) {
        // The actual upcoming fragment, sent on its init request, owns startup.
        // Prewarming here can restart a worker at the wrong grid position.
        return this.strategyUrls(playbackPlaylist(segments, !isAudio && variantIndex !== HLS_VARIANTS.length));
      }
      return this.strategyUrls(this.generateMediaPlaylist(asset, this.getSegmentation(asset)));
    }

    const segmentation = this.getSegmentation(asset);
    const hintedSegment = position === undefined ? undefined : this.positionToSegmentIndex(segmentation, position);
    this.prewarmVariant(assetId, sessionId, variantIndex, hintedSegment);

    return this.generateMediaPlaylist(asset, segmentation);
  }

  async getSegment(
    auth: AuthDto,
    assetId: string,
    sessionId: string,
    variantIndex: number,
    filename: string,
    initSegment?: number,
    strategy?: string,
  ) {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [assetId] });

    const session = await this.videoStreamRepository.getSession(sessionId);
    if (!session || session.assetId !== assetId) {
      throw new NotFoundException('Session not found');
    }

    const variantDir = StorageCore.getHlsVariantFolder({ ownerId: auth.user.id, sessionId, variantIndex });
    const path = join(variantDir, filename);
    const response = new ImmichFileResponse({
      path,
      contentType: 'video/mp4',
      cacheControl: CacheControl.PrivateWithCache,
    });

    const plan = strategy === 'memories' ? await this.getPlaybackPlan(sessionId) : undefined;
    if (plan) this.validatePlaybackVariant(plan, variantIndex);
    const isAudio = !!plan && variantIndex === HLS_VARIANTS.length + 1;
    // Memories has independent producers per rendition. Concurrent requests for
    // another quality must not invalidate this one's pending init or fragments.
    const segmentIndex = plan
      ? filename.endsWith('.mp4')
        ? (initSegment ?? 0)
        : Number(HLS_SEGMENT_FILENAME_REGEX.exec(filename)![1])
      : this.getSegmentIndex(this.trackSession(sessionId, variantIndex), filename, initSegment);
    if (plan) {
      const segments = isAudio ? audioSegments(plan.duration) : plan.segments;
      const count = segments?.length ?? Math.ceil(plan.duration / HLS_SEGMENT_DURATION);
      if (segmentIndex < 0 || segmentIndex >= count)
        throw new NotFoundException('Segment is outside the playback timeline');
    }
    this.websocketRepository.serverSend('HlsHeartbeat', { sessionId, variantIndex, segmentIndex });

    if (await this.storageRepository.checkFileExists(path, constants.R_OK)) {
      return response;
    }

    this.websocketRepository.serverSend('HlsSegmentRequest', { sessionId, assetId, variantIndex, segmentIndex });
    await this.pendingSegments.wait(this.getSegmentKey({ sessionId, variantIndex, segmentIndex }));

    return response;
  }

  async endSession(auth: AuthDto, assetId: string, sessionId: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [assetId] });

    this.websocketRepository.serverSend('HlsSessionEnd', { sessionId });
  }

  private generateMainPlaylist(
    sessionId: string,
    ffmpeg: ConfigFFmpegDto,
    asset: AssetWithStreamInfo,
    videoCodec?: HlsMainPlaylistQueryDto['videoCodec'],
    playback?: PlaybackPlan,
  ) {
    const fps = (asset.packets.packetCount * asset.videoStream.timeBase) / asset.packets.totalDuration;
    const roundedFps = fps.toFixed(3);
    const sourceResolution = Math.min(asset.videoStream.height, asset.videoStream.width);
    const lines = [
      '#EXTM3U',
      `#EXT-X-VERSION:${HLS_VERSION}`,
      ...(!playback?.original ? ['#EXT-X-INDEPENDENT-SEGMENTS'] : []),
    ];
    if (playback?.audio)
      lines.push(
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="${sessionId}/${HLS_VARIANTS.length + 1}/playlist.m3u8?strategy=memories"`,
      );
    const audio = playback ? (playback.audio ? ',mp4a.40.2' : '') : ',mp4a.40.2';
    const audioGroup = playback?.audio ? ',AUDIO="audio"' : '';
    const { videoCodecs, resolutions } = ffmpeg.realtime;
    // The highest configured rung at or above the source is a full-source
    // rendition, not an upscale. E.g. 3200x1800 uses the 2160 rung, which
    // both this playlist and the worker clamp to the true 1800p dimensions.
    // Do not change variant indices: the worker resolves them via HLS_VARIANTS.
    const enclosingResolution = HLS_VARIANTS.map(({ resolution }) => resolution).find(
      (resolution) => resolution >= sourceResolution && resolutions.includes(resolution),
    );
    const targetResolution = enclosingResolution ?? Math.max(sourceResolution, HLS_VARIANTS[0].resolution);
    for (let i = 0; i < HLS_VARIANTS.length; i++) {
      const { resolution, bitrate, codec } = HLS_VARIANTS[i];
      if (playback && codec !== 'h264' && codec !== 'hevc') continue;
      if (
        resolution > targetResolution ||
        !videoCodecs.includes(codec) ||
        !resolutions.includes(resolution) ||
        (videoCodec !== undefined && codec !== videoCodec)
      ) {
        continue;
      }
      const { width, height } = getOutputSize(asset.videoStream, Math.min(resolution, sourceResolution));
      const codecString = getCodecString(codec, width, height, fps);
      if (playback) {
        const source = playback.original?.bitrate;
        playback.bitrates[i] = source
          ? Math.max(128_000, Math.min(bitrate, source * 0.8 * (resolution / sourceResolution) ** 1.3))
          : bitrate;
      }
      const bandwidth = playback ? (playback.bitrates[i] + (playback.audio ? 192_000 : 0)) * 1.35 : bitrate * 1.35;
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(bandwidth)},RESOLUTION=${width}x${height},CODECS="${codecString}${audio}",VIDEO-RANGE=SDR,FRAME-RATE=${roundedFps}${audioGroup}`,
        `${sessionId}/${i}/playlist.m3u8${playback ? '?strategy=memories' : ''}`,
      );
    }
    if (playback?.original) {
      const bitrate = Math.max(
        playback.original.bitrate,
        ...Object.values(playback.bitrates).map((value) => value * 1.01),
      );
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${Math.ceil((bitrate + (playback.audio ? 192_000 : 0)) * 1.35)},RESOLUTION=${asset.videoStream.width}x${asset.videoStream.height},CODECS="${playback.original.codec}${audio}",VIDEO-RANGE=SDR,FRAME-RATE=${roundedFps}${audioGroup}`,
        `${sessionId}/${HLS_VARIANTS.length}/playlist.m3u8?strategy=memories&original=1`,
      );
    }
    lines.push('');

    if (!lines.some((line) => line.startsWith('#EXT-X-STREAM-INF:'))) {
      throw new NotFoundException('No supported variants for this video');
    }

    return lines.join('\n');
  }

  private strategyUrls(playlist: string) {
    return playlist
      .replace(/init\.mp4/g, 'init.mp4?strategy=memories')
      .replace(/seg_(\d+)\.m4s/g, 'seg_$1.m4s?strategy=memories');
  }

  private validatePlaybackVariant(plan: PlaybackPlan, index: number) {
    if (
      plan.bitrates[index] !== undefined ||
      (index === HLS_VARIANTS.length && plan.original) ||
      (index === HLS_VARIANTS.length + 1 && plan.audio)
    )
      return;
    throw new NotFoundException('Variant is not available in this session');
  }

  private async preparePlaybackPlan(
    assetId: string,
    copy?: HlsMainPlaylistQueryDto['copy'],
    videoCodec?: string,
  ): Promise<PlaybackPlan> {
    const asset = await this.videoStreamRepository.getForTranscoding(assetId);
    if (!asset) throw new NotFoundException('Video metadata unavailable');
    const fps = (asset.packets.packetCount * asset.videoStream.timeBase) / asset.packets.totalDuration;
    const duration = asset.packets.outputFrames / fps;
    if (!Number.isFinite(duration) || duration <= 0) throw new NotFoundException('Invalid video duration');
    const codec = originalVideoCodec(asset.videoStream);
    // An AVC-only retry must never re-advertise a failed HEVC Original.
    const eligible =
      codec && copy === copyCapability(codec) && (!videoCodec || asset.videoStream.codecName === videoCodec);
    const segments = eligible
      ? await this.mediaRepository.probePlaybackTimeline(asset.originalPath, asset.videoStream.index)
      : null;
    const sourceRate =
      asset.videoStream.bitrate || Math.max(0, asset.format.bitrate - (asset.audioStream?.bitrate ?? 0));
    const original = segments && codec && sourceRate > 0 ? { codec, bitrate: sourceRate } : undefined;
    return {
      segments: original ? segments : null,
      audio: !!asset.audioStream,
      duration: original ? segments!.at(-1)!.start + segments!.at(-1)!.duration : duration,
      original,
      bitrates: {},
    };
  }

  private getSegmentation({ videoStream, packets }: AssetWithStreamInfo): Segmentation {
    const fps = (packets.packetCount * videoStream.timeBase) / packets.totalDuration;
    const framesPerSegment = Math.ceil(HLS_SEGMENT_DURATION * fps);
    const segmentCount = Math.ceil(packets.outputFrames / framesPerSegment);
    return { fps, framesPerSegment, segmentCount, segmentDuration: framesPerSegment / fps };
  }

  private positionToSegmentIndex({ segmentDuration, segmentCount }: Segmentation, position: number) {
    return Math.min(Math.max(Math.floor(position / segmentDuration), 0), segmentCount - 1);
  }

  private generateMediaPlaylist({ packets }: AssetWithStreamInfo, segmentation: Segmentation) {
    const { fps, framesPerSegment, segmentCount, segmentDuration: fullSegmentDuration } = segmentation;
    const lastSegmentFrames = packets.outputFrames - framesPerSegment * (segmentCount - 1);
    const lastSegmentDuration = lastSegmentFrames / fps;

    const lines = [
      '#EXTM3U',
      `#EXT-X-VERSION:${HLS_VERSION}`,
      '#EXT-X-INDEPENDENT-SEGMENTS',
      `#EXT-X-TARGETDURATION:${HLS_SEGMENT_DURATION}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MAP:URI="init.mp4"',
    ];

    for (let i = 0; i < segmentCount - 1; i++) {
      lines.push(`#EXTINF:${fullSegmentDuration.toFixed(6)},`, `seg_${i}.m4s`);
    }
    lines.push(`#EXTINF:${lastSegmentDuration.toFixed(6)},`, `seg_${segmentCount - 1}.m4s`, '#EXT-X-ENDLIST', '');

    return lines.join('\n');
  }

  private prewarmVariant(assetId: string, sessionId: string, variantIndex: number, hintedSegment?: number) {
    const session = this.sessions.get(sessionId);
    if (session?.lastVariantIndex === variantIndex) {
      return;
    }

    const nextSegment = session && session.lastRequestedSegment !== null ? session.lastRequestedSegment + 1 : undefined;
    const segmentIndex = hintedSegment ?? nextSegment;
    if (segmentIndex !== undefined) {
      this.websocketRepository.serverSend('HlsSegmentRequest', { sessionId, assetId, variantIndex, segmentIndex });
    }
  }

  private getSegmentKey({ sessionId, variantIndex, segmentIndex }: ArgOf<'HlsSegmentResult'>) {
    return `${sessionId}:${variantIndex}:${segmentIndex}`;
  }

  private getSegmentIndex(session: ApiSession, filename: string, initSegment?: number) {
    if (filename.endsWith('.mp4')) {
      // We need to know where to start transcoding, but the init.mp4 has no segment number in its name.
      // We can infer this from the last requested segment, but this can be inaccurate given the client
      // can load cached segments without reaching out to the server. `initSegment` acts as a hint to
      // remove ambiguity when possible.
      return initSegment ?? (session.lastRequestedSegment ?? -1) + 1;
    }
    const segmentIndex = Number.parseInt(HLS_SEGMENT_FILENAME_REGEX.exec(filename)![1]);
    session.lastRequestedSegment = segmentIndex;
    return segmentIndex;
  }

  private trackSession(id: string, variantIndex?: number): ApiSession {
    const session = this.sessions.get(id);
    if (!session) {
      const newSession = { lastRequestedSegment: null, lastVariantIndex: variantIndex ?? null };
      this.sessions.set(id, newSession);
      return newSession;
    }

    if (variantIndex === undefined) return session;
    if (session.lastVariantIndex !== null && session.lastVariantIndex !== variantIndex) {
      this.pendingSegments.rejectByPrefix(`${id}:${session.lastVariantIndex}:`, 'Variant changed');
    }
    session.lastVariantIndex = variantIndex;
    return session;
  }
}
