import type {
  AudioStreamInfo,
  BitrateDistribution,
  HlsCommandOptions,
  TranscodeCommand,
  VideoCodecSWConfig,
  VideoFormat,
  VideoInterfaces,
  VideoStreamInfo,
  VideoTuning,
} from 'src/types.js';
import {
  AUDIO_ENCODER,
  AV1_LEVELS,
  CodecLevel,
  H264_LEVELS,
  HEVC_LEVELS,
  SUPPORTED_HWA_CODECS,
} from 'src/constants.js';
import { ConfigFFmpegDto } from 'src/dtos/config.dto.js';
import {
  CQMode,
  ColorMatrix,
  ColorPrimaries,
  ColorTransfer,
  ToneMapping,
  TranscodeHardwareAcceleration,
  TranscodeTarget,
  VideoCodec,
} from 'src/enum.js';

export const isVideoRotated = (videoStream: VideoStreamInfo): boolean => Math.abs(videoStream.rotation) === 90;

// whether the video is portrait once its rotation is applied
export const isVideoVertical = (videoStream: VideoStreamInfo): boolean =>
  videoStream.height > videoStream.width !== isVideoRotated(videoStream);

export const getOutputSize = (videoStream: VideoStreamInfo, targetRes: number) => {
  const factor = Math.max(videoStream.height, videoStream.width) / Math.min(videoStream.height, videoStream.width);
  // Match FFmpeg's -2 scaling: round to the nearest even dimension.
  const larger = Math.round((targetRes * factor) / 2) * 2;
  return isVideoVertical(videoStream) ? { width: targetRes, height: larger } : { width: larger, height: targetRes };
};

const pickLevel = (levels: CodecLevel[], frame: number, rate: number) =>
  levels.find((level) => frame <= level.maxFrame && rate <= level.maxRate) ?? levels.at(-1)!;

export const getCodecString = (codec: VideoCodec, width: number, height: number, fps: number): string => {
  switch (codec) {
    case VideoCodec.H264: {
      const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
      return `avc1.6400${pickLevel(H264_LEVELS, macroblocks, macroblocks * fps).token}`;
    }
    case VideoCodec.Hevc: {
      const samples = width * height;
      return `hvc1.1.6.${pickLevel(HEVC_LEVELS, samples, samples * fps).token}.B0`;
    }
    case VideoCodec.Av1: {
      const samples = width * height;
      return `av01.0.${pickLevel(AV1_LEVELS, samples, samples * fps).token}.08`;
    }
    default: {
      throw new Error(`Codec '${codec}' does not support HLS codec strings`);
    }
  }
};

export class BaseConfig implements VideoCodecSWConfig {
  readonly presets = ['veryslow', 'slower', 'slow', 'medium', 'fast', 'faster', 'veryfast', 'superfast', 'ultrafast'];
  protected constructor(
    protected config: ConfigFFmpegDto,
    protected tune: VideoTuning = { strictGop: false, lowLatency: false },
  ) {}

  static create(config: ConfigFFmpegDto, interfaces: VideoInterfaces, tune?: VideoTuning) {
    if (config.accel === TranscodeHardwareAcceleration.Disabled) {
      return BaseConfig.getSWCodecConfig(config, tune);
    }
    return BaseConfig.getHWCodecConfig(config, interfaces, tune);
  }

  private static getSWCodecConfig(config: ConfigFFmpegDto, tune?: VideoTuning): VideoCodecSWConfig {
    switch (config.targetVideoCodec) {
      case VideoCodec.H264: {
        return new H264Config(config, tune);
      }
      case VideoCodec.Hevc: {
        return new HEVCConfig(config, tune);
      }
      case VideoCodec.Vp9: {
        return new VP9Config(config, tune);
      }
      case VideoCodec.Av1: {
        return new AV1Config(config, tune);
      }
      default: {
        throw new Error(`Codec '${config.targetVideoCodec}' is unsupported`);
      }
    }
  }

  private static getHWCodecConfig(config: ConfigFFmpegDto, interfaces: VideoInterfaces, tune?: VideoTuning) {
    if (!SUPPORTED_HWA_CODECS[config.accel].includes(config.targetVideoCodec)) {
      throw new Error(
        `${config.accel.toUpperCase()} acceleration does not support codec '${config.targetVideoCodec.toUpperCase()}'. Supported codecs: ${SUPPORTED_HWA_CODECS[config.accel]}`,
      );
    }

    let handler: VideoCodecSWConfig;
    switch (config.accel) {
      case TranscodeHardwareAcceleration.Nvenc: {
        handler = config.accelDecode
          ? new NvencHwDecodeConfig(config, interfaces, tune)
          : new NvencSwDecodeConfig(config, interfaces, tune);
        break;
      }
      case TranscodeHardwareAcceleration.Qsv: {
        handler = config.accelDecode
          ? new QsvHwDecodeConfig(config, interfaces, tune)
          : new QsvSwDecodeConfig(config, interfaces, tune);
        break;
      }
      case TranscodeHardwareAcceleration.Vaapi: {
        handler = config.accelDecode
          ? new VaapiHwDecodeConfig(config, interfaces, tune)
          : new VaapiSwDecodeConfig(config, interfaces, tune);
        break;
      }
      case TranscodeHardwareAcceleration.Rkmpp: {
        handler = config.accelDecode
          ? new RkmppHwDecodeConfig(config, interfaces, tune)
          : new RkmppSwDecodeConfig(config, interfaces, tune);
        break;
      }
      default: {
        throw new Error(`${config.accel.toUpperCase()} acceleration is unsupported`);
      }
    }

    return handler;
  }

  getCommand(target: TranscodeTarget, video: VideoStreamInfo, audio?: AudioStreamInfo, format?: VideoFormat) {
    const options = {
      inputOptions: this.getBaseInputOptions(video, format),
      outputOptions: [
        ...this.getBaseOutputOptions(target, video, audio),
        ...this.getPresetOptions(),
        ...this.getBitrateOptions(),
        ...this.getEncoderOptions(),
        '-movflags',
        'faststart',
        '-fps_mode',
        'passthrough',
        '-v',
        'verbose',
      ],
      twoPass: this.eligibleForTwoPass(),
      progress: { frameCount: video.frameCount, percentInterval: 5 },
    } as TranscodeCommand;
    if ([TranscodeTarget.All, TranscodeTarget.Video].includes(target)) {
      const filters = this.getFilterOptions(video);
      if (filters.length > 0) {
        options.outputOptions.push('-vf', filters.join(','));
      }
    }

    return options;
  }

  getHlsCommand(options: HlsCommandOptions, video: VideoStreamInfo, audio?: AudioStreamInfo) {
    const args: string[] = this.getBaseInputOptions(video);
    if (options.seekSeconds) {
      args.push('-ss', String(options.seekSeconds));
    }
    args.push(
      '-nostdin',
      '-nostats',
      '-i',
      options.inputPath,
      ...this.getBaseOutputOptions(options.target, video, audio),
      ...this.getPresetOptions(),
      ...this.getBitrateOptions(),
      ...this.getEncoderOptions(),
      '-copyts',
      '-r',
      `${options.packetCount * options.timeBase}/${options.totalDuration}`,
      '-avoid_negative_ts',
      'disabled',
      '-f',
      'hls',
      '-hls_time',
      String(options.segmentDuration),
      '-hls_list_size',
      '0',
      '-hls_segment_type',
      'fmp4',
      '-hls_fmp4_init_filename',
      options.initFilename,
      '-hls_segment_options',
      'movflags=+frag_discont',
      '-hls_flags',
      'temp_file',
      '-hls_segment_filename',
      options.segmentFilename,
      '-start_number',
      String(options.startSegment),
    );

    if ([TranscodeTarget.All, TranscodeTarget.Video].includes(options.target)) {
      const filters = this.getFilterOptions(video);
      if (filters.length > 0) {
        args.push('-vf', filters.join(','));
      }
    }
    args.push(options.playlistFilename);
    return args;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getBaseInputOptions(videoStream: VideoStreamInfo, format?: VideoFormat): string[] {
    return this.getInputThreadOptions();
  }

  getBaseOutputOptions(target: TranscodeTarget, videoStream: VideoStreamInfo, audioStream?: AudioStreamInfo) {
    const videoCodec = [TranscodeTarget.All, TranscodeTarget.Video].includes(target) ? this.getVideoCodec() : 'copy';
    const audioCodec = [TranscodeTarget.All, TranscodeTarget.Audio].includes(target) ? this.getAudioEncoder() : 'copy';

    const options = ['-c:v', videoCodec, '-c:a', audioCodec, '-map', `0:${videoStream.index}`, '-map_metadata', '-1'];
    if (audioStream) {
      options.push('-map', `0:${audioStream.index}`);
      // If there are more than 2 channels sometimes the channel config is broken when re-encoded
      // TODO: Store the number of channels in the db and then set it during the transcoding: -channel_layout 5.1
      if ([TranscodeTarget.All, TranscodeTarget.Audio].includes(target)) {
        options.push('-ac', '2');
      }
    }
    if (this.getBFrames() > -1) {
      options.push('-bf', String(this.getBFrames()));
    }
    if (this.getRefs() > 0) {
      options.push('-refs', String(this.getRefs()));
    }
    if (this.getGopSize() > 0) {
      options.push('-g', String(this.getGopSize()));
      if (this.tune.strictGop) {
        options.push('-keyint_min', String(this.getGopSize()));
      }
    }
    const isHvc =
      this.config.targetVideoCodec === VideoCodec.Hevc && (videoCodec !== 'copy' || videoStream.codecName === 'hevc');
    if (isHvc) {
      options.push('-tag:v', 'hvc1');
    }

    return options;
  }

  getEncoderOptions(): string[] {
    return [];
  }

  getFilterOptions(videoStream: VideoStreamInfo) {
    const options = [];
    if (this.shouldScale(videoStream)) {
      options.push(`scale=${this.getScaling(videoStream)}`);
    }

    const tonemapOptions = this.getToneMapping(videoStream);
    if (tonemapOptions.length > 0) {
      options.push(...tonemapOptions);
    } else if (!videoStream.pixelFormat.endsWith('420p')) {
      options.push('format=yuv420p');
    }

    return options;
  }

  getPresetOptions() {
    return ['-preset', this.config.preset];
  }

  getBitrateOptions() {
    const bitrates = this.getBitrateDistribution();
    if (this.eligibleForTwoPass()) {
      return [
        '-b:v',
        `${bitrates.target}${bitrates.unit}`,
        '-minrate',
        `${bitrates.min}${bitrates.unit}`,
        '-maxrate',
        `${bitrates.max}${bitrates.unit}`,
      ];
    }
    if (bitrates.max > 0) {
      // -bufsize is the peak possible bitrate at any moment, while -maxrate is the max rolling average bitrate
      return [
        `-${this.useCQP() ? 'q:v' : 'crf'}`,
        String(this.config.crf),
        '-maxrate',
        `${bitrates.max}${bitrates.unit}`,
        '-bufsize',
        `${bitrates.max * 2}${bitrates.unit}`,
      ];
    }
    return [`-${this.useCQP() ? 'q:v' : 'crf'}`, String(this.config.crf)];
  }

  getInputThreadOptions(): Array<string> {
    return [];
  }

  getOutputThreadOptions(): Array<string> {
    if (this.config.threads <= 0) {
      return [];
    }
    return ['-threads', String(this.config.threads)];
  }

  eligibleForTwoPass() {
    if (!this.config.twoPass || this.config.accel !== TranscodeHardwareAcceleration.Disabled) {
      return false;
    }

    return this.isBitrateConstrained();
  }

  getBitrateDistribution() {
    const max = this.getMaxBitrateValue();
    const target = Math.ceil(max / 1.45); // recommended by https://developers.google.com/media/vp9/settings/vod
    const min = target / 2;
    const unit = this.getBitrateUnit();

    return { max, target, min, unit } as BitrateDistribution;
  }

  getTargetResolution(videoStream: VideoStreamInfo) {
    let target;
    target =
      this.config.targetResolution === 'original'
        ? Math.min(videoStream.height, videoStream.width)
        : Number.parseInt(this.config.targetResolution);

    if (target % 2 !== 0) {
      target -= 1;
    }

    return target;
  }

  shouldScale(videoStream: VideoStreamInfo) {
    const isOddDimensions = videoStream.height % 2 !== 0 || videoStream.width % 2 !== 0;
    const isLargerThanTarget = Math.min(videoStream.height, videoStream.width) > this.getTargetResolution(videoStream);
    return isOddDimensions || isLargerThanTarget;
  }

  shouldToneMap(videoStream: VideoStreamInfo) {
    return (
      this.config.tonemap !== ToneMapping.Disabled &&
      (videoStream.colorTransfer === ColorTransfer.Smpte2084 || videoStream.colorTransfer === ColorTransfer.AribStdB67)
    );
  }

  getScaling(videoStream: VideoStreamInfo, mult = 2) {
    const targetResolution = this.getTargetResolution(videoStream);
    return this.isFrameVertical(videoStream) ? `${targetResolution}:-${mult}` : `-${mult}:${targetResolution}`;
  }

  // frames reach the filters already rotated, unless decoding with -noautorotate
  isFrameVertical(videoStream: VideoStreamInfo) {
    return isVideoVertical(videoStream);
  }

  isBitrateConstrained() {
    return this.getMaxBitrateValue() > 0;
  }

  getBitrateUnit() {
    const maxBitrate = this.getMaxBitrateValue();
    return this.config.maxBitrate.trim().slice(maxBitrate.toString().length) || 'k'; // use inputted unit if provided, else default to kbps
  }

  getMaxBitrateValue() {
    return Number.parseInt(this.config.maxBitrate) || 0;
  }

  getPresetIndex() {
    return this.presets.indexOf(this.config.preset);
  }

  getColors() {
    return {
      primaries: 'bt709',
      transfer: 'bt709',
      matrix: 'bt709',
    };
  }

  getToneMapping(videoStream: VideoStreamInfo) {
    if (!this.shouldToneMap(videoStream)) {
      return [];
    }

    const { primaries, transfer, matrix } = this.getColors();
    const options = `tonemapx=tonemap=${this.config.tonemap}:desat=0:p=${primaries}:t=${transfer}:m=${matrix}:r=pc:peak=100:format=yuv420p`;
    return [options];
  }

  getAudioEncoder(): string {
    return AUDIO_ENCODER[this.config.targetAudioCodec];
  }

  getVideoCodec(): string {
    return this.config.targetVideoCodec;
  }

  getBFrames() {
    return this.config.bframes;
  }

  getRefs() {
    return this.config.refs;
  }

  getGopSize() {
    return this.config.gopSize;
  }

  useCQP() {
    return this.config.cqMode === CQMode.Cqp;
  }
}

export class BaseHWConfig extends BaseConfig {
  protected device: string;

  constructor(
    protected config: ConfigFFmpegDto,
    protected interfaces: VideoInterfaces,
    tune?: VideoTuning,
  ) {
    super(config, tune);
    this.device = this.getDevice(interfaces);
  }

  validateDevices(devices: string[]) {
    if (devices.length === 0) {
      throw new Error('No /dev/dri devices found. If using Docker, make sure at least one /dev/dri device is mounted');
    }

    return devices.filter(function (device) {
      return device.startsWith('renderD') || device.startsWith('card');
    });
  }

  getDevice({ dri }: VideoInterfaces) {
    if (this.config.preferredHwDevice === 'auto') {
      // eslint-disable-next-line unicorn/no-array-reduce
      return `/dev/dri/${this.validateDevices(dri).reduce(function (a, b) {
        return a.localeCompare(b) < 0 ? b : a;
      })}`;
    }

    const deviceName = this.config.preferredHwDevice.replace('/dev/dri/', '');
    if (!dri.includes(deviceName)) {
      throw new Error(`Device '${deviceName}' does not exist. If using Docker, make sure this device is mounted`);
    }

    return `/dev/dri/${deviceName}`;
  }

  getVideoCodec(): string {
    return `${this.config.targetVideoCodec}_${this.config.accel}`;
  }

  getGopSize() {
    if (this.config.gopSize <= 0) {
      return 256;
    }
    return this.config.gopSize;
  }
}

export class ThumbnailConfig extends BaseConfig {
  static create(config: ConfigFFmpegDto): VideoCodecSWConfig {
    return new ThumbnailConfig(config);
  }

  getBaseInputOptions(videoStream: VideoStreamInfo, format?: VideoFormat): string[] {
    // skip_frame nointra skips all frames for some MPEG-TS files. Look at ffmpeg tickets 7950 and 7895 for more details.
    const options =
      format?.formatName === 'mpegts'
        ? ['-sws_flags', 'accurate_rnd+full_chroma_int']
        : ['-skip_frame', 'nointra', '-sws_flags', 'accurate_rnd+full_chroma_int'];

    const metadataOverrides = [];
    if (videoStream.colorPrimaries === ColorPrimaries.Reserved) {
      metadataOverrides.push('colour_primaries=1');
    }

    if (videoStream.colorMatrix === ColorMatrix.Reserved) {
      metadataOverrides.push('matrix_coefficients=1');
    }

    if (videoStream.colorTransfer === ColorTransfer.Reserved) {
      metadataOverrides.push('transfer_characteristics=1');
    }

    if (metadataOverrides.length > 0) {
      // workaround for https://fftrac-bg.ffmpeg.org/ticket/11020
      options.push(`-bsf:${videoStream.index}`, `${videoStream.codecName}_metadata=${metadataOverrides.join(':')}`);
    }

    return options;
  }

  getBaseOutputOptions() {
    return ['-fps_mode', 'vfr', '-frames:v', '1', '-update', '1'];
  }

  getFilterOptions(videoStream: VideoStreamInfo): string[] {
    return [
      'fps=12:start_time=0:eof_action=pass:round=down',
      'thumbnail=12',
      String.raw`select=gt(scene\,0.1)-eq(prev_selected_n\,n)+isnan(prev_selected_n)+gt(n\,20)`,
      'trim=end_frame=2',
      'reverse',
      ...super.getFilterOptions(videoStream),
    ];
  }

  getPresetOptions() {
    return [];
  }

  getBitrateOptions() {
    return [];
  }

  eligibleForTwoPass() {
    return false;
  }

  getScaling(videoStream: VideoStreamInfo) {
    return super.getScaling(videoStream) + ':flags=lanczos+accurate_rnd+full_chroma_int:out_range=pc';
  }
}

export class H264Config extends BaseConfig {
  getEncoderOptions(): string[] {
    const out = this.getOutputThreadOptions();
    if (this.tune.strictGop) {
      out.push('-sc_threshold:v', '0');
    }
    if (this.config.threads === 1) {
      out.push('-x264-params', 'frame-threads=1:pools=none');
    }
    return out;
  }
}

export class HEVCConfig extends BaseConfig {
  getEncoderOptions(): string[] {
    const out: string[] = this.getOutputThreadOptions();
    const params: string[] = [];
    if (this.tune.strictGop) {
      params.push('no-scenecut=1', 'no-open-gop=1');
    }
    if (this.config.threads === 1) {
      params.push('frame-threads=1', 'pools=none');
    }
    if (params.length > 0) {
      out.push('-x265-params', params.join(':'));
    }
    return out;
  }
}

export class VP9Config extends BaseConfig {
  getPresetOptions() {
    const speed = Math.min(this.getPresetIndex(), 5); // values over 5 require realtime mode, which is its own can of worms since it overrides -crf and -threads
    if (speed >= 0) {
      return ['-cpu-used', String(speed)];
    }
    return [];
  }

  getBitrateOptions() {
    const bitrates = this.getBitrateDistribution();
    if (bitrates.max > 0 && this.eligibleForTwoPass()) {
      return [
        '-b:v',
        `${bitrates.target}${bitrates.unit}`,
        '-minrate',
        `${bitrates.min}${bitrates.unit}`,
        '-maxrate',
        `${bitrates.max}${bitrates.unit}`,
      ];
    }

    return [`-${this.useCQP() ? 'q:v' : 'crf'}`, String(this.config.crf), '-b:v', `${bitrates.max}${bitrates.unit}`];
  }

  getEncoderOptions(): string[] {
    return ['-row-mt', '1', ...this.getOutputThreadOptions()];
  }

  eligibleForTwoPass() {
    return this.config.twoPass;
  }
}

export class AV1Config extends BaseConfig {
  getVideoCodec(): string {
    return 'libsvtav1';
  }

  getPresetOptions() {
    const speed = this.getPresetIndex() + 4; // Use 4 as slowest, giving us an effective range of 4-12 which is far more useful than 0-8
    if (speed >= 0) {
      return ['-preset', String(speed)];
    }
    return [];
  }

  getBitrateOptions() {
    return ['-crf', String(this.config.crf)];
  }

  getEncoderOptions(): string[] {
    const params: string[] = [];
    if (this.tune.lowLatency) {
      params.push('hierarchical-levels=3', 'lookahead=0', 'enable-tf=0');
    }
    if (this.config.threads > 0) {
      params.push(`lp=${this.config.threads}`);
    }
    const bitrates = this.getBitrateDistribution();
    if (bitrates.max > 0) {
      params.push(`mbr=${bitrates.max}${bitrates.unit}`);
    }
    return params.length > 0 ? ['-svtav1-params', params.join(':')] : [];
  }

  eligibleForTwoPass() {
    return this.config.twoPass;
  }
}

export class NvencSwDecodeConfig extends BaseHWConfig {
  getDevice() {
    return '0';
  }

  getBaseInputOptions() {
    return ['-init_hw_device', `cuda=cuda:${this.device}`, '-filter_hw_device', 'cuda'];
  }

  getBaseOutputOptions(target: TranscodeTarget, videoStream: VideoStreamInfo, audioStream?: AudioStreamInfo) {
    const options = [
      // below settings recommended from https://docs.nvidia.com/video-technologies/video-codec-sdk/12.0/ffmpeg-with-nvidia-gpu/index.html#command-line-for-latency-tolerant-high-quality-transcoding
      '-tune',
      'hq',
      '-qmin',
      '0',
      '-rc-lookahead',
      '20',
      '-i_qfactor',
      '0.75',
      ...super.getBaseOutputOptions(target, videoStream, audioStream),
    ];
    if (this.getBFrames() > 0) {
      options.push('-b_ref_mode', 'middle', '-b_qfactor', '1.1');
    }
    if (this.config.temporalAQ) {
      options.push('-temporal-aq', '1');
    }
    return options;
  }

  getFilterOptions(videoStream: VideoStreamInfo) {
    const options = this.getToneMapping(videoStream);
    options.push('hwupload_cuda');
    if (this.shouldScale(videoStream)) {
      options.push(`scale_cuda=${this.getScaling(videoStream)}:format=nv12`);
    }

    return options;
  }

  getPresetOptions() {
    let presetIndex = this.getPresetIndex();
    if (presetIndex < 0) {
      return [];
    }
    presetIndex = 7 - Math.min(6, presetIndex); // map to p1-p7; p7 is the highest quality, so reverse index
    return ['-preset', `p${presetIndex}`];
  }

  getBitrateOptions() {
    const bitrates = this.getBitrateDistribution();
    if (bitrates.max > 0 && this.config.twoPass) {
      return [
        '-b:v',
        `${bitrates.target}${bitrates.unit}`,
        '-maxrate',
        `${bitrates.max}${bitrates.unit}`,
        '-bufsize',
        `${bitrates.target}${bitrates.unit}`,
        '-multipass',
        '2',
      ];
    }
    return bitrates.max > 0
      ? [
          '-cq:v',
          String(this.config.crf),
          '-maxrate',
          `${bitrates.max}${bitrates.unit}`,
          '-bufsize',
          `${bitrates.target}${bitrates.unit}`,
        ]
      : ['-cq:v', String(this.config.crf)];
  }

  getEncoderOptions(): string[] {
    const out = this.getOutputThreadOptions();
    if (this.tune.strictGop) {
      out.push('-forced-idr', '1');
    }
    return out;
  }

  getRefs() {
    const bframes = this.getBFrames();
    if (bframes > 0 && bframes < 3 && this.config.refs < 3) {
      return 0;
    }
    return this.config.refs;
  }
}

export class NvencHwDecodeConfig extends NvencSwDecodeConfig {
  getBaseInputOptions() {
    return ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-noautorotate', ...this.getInputThreadOptions()];
  }

  // -noautorotate keeps frames in their stored orientation
  isFrameVertical(videoStream: VideoStreamInfo) {
    return videoStream.height > videoStream.width;
  }

  getFilterOptions(videoStream: VideoStreamInfo) {
    const options = [];
    const tonemapOptions = this.getToneMapping(videoStream);
    if (this.shouldScale(videoStream) || (tonemapOptions.length === 0 && !videoStream.pixelFormat.endsWith('420p'))) {
      options.push(`scale_cuda=${this.getScaling(videoStream)}`);
    }
    options.push(...tonemapOptions);
    if (options.length > 0) {
      options[options.length - 1] += ':format=nv12';
    }
    return options;
  }

  getToneMapping(videoStream: VideoStreamInfo) {
    if (!this.shouldToneMap(videoStream)) {
      return [];
    }

    const { matrix, primaries, transfer } = this.getColors();
    const tonemapOptions = [
      'desat=0',
      `matrix=${matrix}`,
      `primaries=${primaries}`,
      'range=pc',
      `tonemap=${this.config.tonemap}`,
      'tonemap_mode=lum',
      `transfer=${transfer}`,
      'peak=100',
    ];

    return [`tonemap_cuda=${tonemapOptions.join(':')}`];
  }

  getInputThreadOptions() {
    return ['-threads', '1'];
  }

  getEncoderOptions(): string[] {
    return this.tune.strictGop ? ['-forced-idr', '1'] : [];
  }
}

export class QsvSwDecodeConfig extends BaseHWConfig {
  getBaseInputOptions() {
    return ['-init_hw_device', `qsv=hw,child_device=${this.device}`, '-filter_hw_device', 'hw'];
  }

  getBaseOutputOptions(target: TranscodeTarget, videoStream: VideoStreamInfo, audioStream?: AudioStreamInfo) {
    const options = super.getBaseOutputOptions(target, videoStream, audioStream);
    // VP9 requires enabling low power mode https://git.ffmpeg.org/gitweb/ffmpeg.git/commit/33583803e107b6d532def0f9d949364b01b6ad5a
    if (this.config.targetVideoCodec === VideoCodec.Vp9) {
      options.push('-low_power', '1');
 …5761 tokens truncated…     if (keep.size === 0) {
        if (!retryWithAvc(el, assetId)) {
          console.error('No supported HLS video renditions');
          isLoading = false;
        }
        return;
      }
      for (let i = api.levels.length - 1; i >= 0; i--) {
        if (!keep.has(i)) {
          api.removeLevel(i);
        }
      }

      api.startLoad(resumeTime);
    });

    api.on(Hls.Events.FRAG_LOADED, () => (rebuildCount = 0));

    api.on(Hls.Events.ERROR, (_, data) => {
      if (el !== videoPlayer || el.api !== api || playbackAssetId !== assetId) {
        return;
      }
      if (
        isHevcDecodeFailure(data, currentVideoCodec(el, data.frag?.level)) &&
        retryWithAvc(el, assetId)
      ) {
        return;
      }
      // 404 on a fragment can mean the server-side session has expired. Refetch
      // master for a new session, but give up if it still 404s.
      if (
        !data.fatal ||
        data.details !== Hls.ErrorDetails.FRAG_LOAD_ERROR ||
        data.response?.code !== 404 ||
        rebuildCount++ >= MAX_REBUILDS
      ) {
        console.error('HLS error', JSON.stringify(data));
        return;
      }
      console.warn('Error loading segment, starting new session');
      activeSession = undefined;
      resumeTime = rememberPlayback(el, assetId);
      el.load();
      // wireHlsListeners must run after el.api is repopulated.
      queueMicrotask(() => wireHlsListeners(el, assetId, resumeTime));
    });
  };

  onMount(() => {
    showVideo = true;
  });

  $effect(() => {
    // reactive on `assetFileUrl` changes
    hasLoadedMetadata = false;
    if (videoPlayer && assetFileUrl) {
      if (playbackAssetId !== assetId) {
        playbackAssetId = assetId;
        pendingResume = undefined;
        pausedReloadAssetId = undefined;
        videoPlayer.autoplay = untrack(() => $autoPlayVideo);
      }
      hasFocused = false;
      rebuildCount = 0;
      releaseSession();
      if (isHlsElement(videoPlayer)) {
        videoPlayer.config = hlsConfig;
        videoPlayer.src = assetFileUrl;
        const el = videoPlayer;
        const resumeTime = pendingResume?.assetId === assetId ? pendingResume.currentTime : undefined;
        queueMicrotask(() => wireHlsListeners(el, assetId, resumeTime));
      } else {
        videoPlayer.load();
      }
    }
    return releaseSession;
  });

  const onPagehide = (event: PageTransitionEvent) => {
    if (!event.persisted) {
      releaseSession();
    }
  };

  $effect(() => {
    window.addEventListener('pagehide', onPagehide);
    return () => window.removeEventListener('pagehide', onPagehide);
  });

  onDestroy(() => {
    if (videoPlayer) {
      videoPlayer.src = '';
    }
  });

  const handleCanPlay = async (video: HTMLVideoElement) => {
    try {
      if (!video.paused) {
        await video.play();
        onVideoStarted();
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        await tryForceMutedPlay(video);
        return;
      }

      // auto-play failed
    } finally {
      isLoading = false;
    }
  };

  const tryForceMutedPlay = async (video: HTMLVideoElement) => {
    if (video.muted) {
      return;
    }

    try {
      video.muted = true;
      await handleCanPlay(video);
    } catch {
      // muted auto-play failed
    }
  };

  const onSwipe = (event: SwipeCustomEvent) => {
    if (event.detail.direction === 'left') {
      onNextAsset();
    } else if (event.detail.direction === 'right') {
      onPreviousAsset();
    }
  };

  let containerWidth = $state(0);
  let containerHeight = $state(0);

  $effect(() => {
    if (assetViewerManager.isFaceEditMode) {
      videoPlayer?.pause();
    }
  });

  // The time is only refreshed on HLS fragment decode by default,
  // so manually emit events on seek to update it immediately.
  const onSeeking = (event: Event) => event.currentTarget?.dispatchEvent(new Event('timeupdate'));
</script>

<svelte:body
  use:shortcuts={[
    {
      shortcut: { key: ' ' },
      onShortcut: () => (videoPlayer?.paused ? videoPlayer?.play() : videoPlayer?.pause()),
    },
    {
      shortcut: { shift: true, key: 'ArrowLeft' },
      onShortcut: () =>
        videoPlayer ? (videoPlayer.currentTime = Math.max(videoPlayer.currentTime - 0.4, 0)) : undefined,
    },
    {
      shortcut: { shift: true, key: 'ArrowRight' },
      onShortcut: () =>
        videoPlayer
          ? (videoPlayer.currentTime = Math.min(videoPlayer.currentTime + 0.4, videoPlayer.duration))
          : undefined,
    },
  ]}
/>

{#if showVideo}
  <div
    transition:fade={{ duration: assetViewerFadeDuration }}
    class="flex h-full place-content-center place-items-center select-none"
    bind:clientWidth={containerWidth}
    bind:clientHeight={containerHeight}
  >
    {#if castManager.isCasting}
      <div class="h-full place-content-center place-items-center">
        <VideoRemoteViewer
          poster={getAssetMediaUrl({ id: assetId, size: AssetMediaSize.Preview, cacheKey })}
          {onVideoStarted}
          {onVideoEnded}
          {assetFileUrl}
        />
      </div>
    {:else}
      <!-- dir=ltr based on https://github.com/videojs/video.js/issues/949 -->
      <media-controller
        dir="ltr"
        lang={$lang}
        nohotkeys
        class="dark h-full max-w-full"
        style:aspect-ratio={aspectRatio}
        defaultduration={asset.duration! / 1000}
      >
        {#if featureFlagsManager.value.realtimeTranscoding}
          <hls-video
            bind:this={videoPlayer}
            slot="media"
            loop={$loopVideoPreference && loopVideo}
            autoplay={$autoPlayVideo && pausedReloadAssetId !== assetId}
            disablePictureInPicture
            playsinline
            {...useSwipe(onSwipe)}
            class="h-full object-contain"
            oncanplay={(e: Event) => handleCanPlay(e.currentTarget as HTMLVideoElement)}
            onloadedmetadata={(e: Event) => handleLoadedMetadata(e.currentTarget as HTMLVideoElement)}
            onplay={(e: Event) => handlePlay(e.currentTarget as HTMLVideoElement)}
            onerror={handleMediaError}
            onended={onVideoEnded}
            onseeking={onSeeking}
            onplaying={(e: Event) => {
              if (hasFocused) {
                return;
              }

              (e.currentTarget as HTMLElement).focus();
              hasFocused = true;
            }}
            onclose={onClose}
            poster={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey })}
          ></hls-video>
        {:else}
          <video
            bind:this={videoPlayer}
            slot="media"
            src={assetFileUrl}
            loop={$loopVideoPreference && loopVideo}
            autoplay={$autoPlayVideo}
            disablePictureInPicture
            playsinline
            {...useSwipe(onSwipe)}
            class="h-full object-contain"
            oncanplay={(e) => handleCanPlay(e.currentTarget)}
            onloadedmetadata={() => (hasLoadedMetadata = true)}
            onended={onVideoEnded}
            onseeking={onSeeking}
            onplaying={(e) => {
              if (hasFocused) {
                return;
              }

              e.currentTarget.focus();
              hasFocused = true;
            }}
            onclose={onClose}
            poster={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey })}
          ></video>
        {/if}

        {#if extendedControls}
          <media-settings-menu hidden anchor="auto" class="min-w-3xs rounded-xl border border-light-300 shadow-sm">
            <Icon slot="checked-indicator" icon={mdiCheck} class="m-2" />
            <media-settings-menu-item class="mx-1 rounded-lg p-1 ps-2">
              {$t('media_chrome.playback_rate')}
              <Icon slot="suffix" icon={mdiChevronRight} class="m-2" />
              <media-playback-rate-menu slot="submenu" hidden rates="0.5 1 1.5 2">
                <Icon slot="back-icon" icon={mdiChevronLeft} class="m-2" />
                <span slot="title">{$t('media_chrome.playback_rate')}</span>
              </media-playback-rate-menu>
            </media-settings-menu-item>
            {#if featureFlagsManager.value.realtimeTranscoding}
              <media-settings-menu-item class="mx-1 rounded-lg p-1 ps-2">
                {$t('video_quality')}
                <Icon slot="suffix" icon={mdiChevronRight} class="m-2" />
                <media-rendition-menu slot="submenu" hidden>
                  <Icon slot="back-icon" icon={mdiChevronLeft} class="m-2" />
                  <span slot="title">{$t('video_quality')}</span>
                </media-rendition-menu>
              </media-settings-menu-item>
            {/if}
          </media-settings-menu>
        {/if}

        <div class="flex h-32 w-full flex-col justify-end bg-linear-to-b to-black/80 px-4">
          <media-control-bar part="bottom" class="flex h-10 w-full gap-2">
            <media-play-button class="shrink-0 rounded-full p-2 outline-none">
              <Icon slot="play" icon={mdiPlay} />
              <Icon slot="pause" icon={mdiPause} />
            </media-play-button>
            <media-time-display showduration class="rounded-lg p-2 outline-none"></media-time-display>

            <span class="grow"></span>

            <div
              class="volume-wrapper shrink-0 rounded-full bg-light-100/0 transition-colors duration-400 hover:bg-light-100"
            >
              <media-volume-range class="h-full bg-none outline-none"></media-volume-range>
              <media-mute-button class="bg-none p-2 outline-none">
                <Icon slot="off" icon={mdiVolumeMute} />
                <Icon slot="low" icon={mdiVolumeLow} />
                <Icon slot="medium" icon={mdiVolumeMedium} />
                <Icon slot="high" icon={mdiVolumeHigh} />
              </media-mute-button>
            </div>

            {#if extendedControls}
              <media-fullscreen-button class="shrink-0 rounded-full p-2 outline-none">
                <Icon slot="enter" icon={mdiFullscreen} />
                <Icon slot="exit" icon={mdiFullscreenExit} />
              </media-fullscreen-button>
              <media-settings-menu-button class="shrink-0 rounded-full p-2 outline-none"></media-settings-menu-button>
            {/if}
          </media-control-bar>
          <immich-time-range class="h-8 w-full rounded-lg px-2 pb-3 outline-none"></immich-time-range>
        </div>
      </media-controller>

      {#if isLoading}
        <div class="absolute flex place-content-center place-items-center">
          <LoadingSpinner />
        </div>
      {/if}

      {#if assetViewerManager.isFaceEditMode && videoPlayer && hasLoadedMetadata}
        <FaceEditor htmlElement={videoPlayer} {containerWidth} {containerHeight} {assetId} />
      {/if}
    {/if}
  </div>
{/if}

<style>
  media-controller {
    --media-control-background: none;
    --media-control-hover-background: var(--immich-ui-light-100);
    --media-focus-box-shadow: 0 0 0 2px var(--immich-ui-dark);
    --media-font-family: var(--font-sans);
    --media-font-size: var(--text-base);
    --media-font-weight: var(--font-weight-medium);
    --media-menu-border-radius: var(--radius-xl);
    --media-menu-gap: var(--spacing);
    --media-menu-item-hover-background: var(--immich-ui-light-200);
    --media-menu-item-icon-height: 1em;
    --media-menu-item-indicator-height: 1em;
    --media-primary-color: var(--immich-ui-dark);
    --media-time-range-buffered-color: var(--immich-ui-dark-400);
    --media-time-range-hover-bottom: 0;
    --media-time-range-hover-height: 100%;
    --media-range-thumb-box-shadow: none;
    --media-range-thumb-opacity: 0;
    --media-range-thumb-transition: opacity 0.15s ease;
    --media-range-track-border-radius: 2px;
    --media-range-track-height: 3.5px;
    --media-range-padding: 0;
    --media-settings-menu-background: var(--immich-ui-light-100);
    --media-text-content-height: var(--text-base--line-height);
    --media-tooltip-arrow-display: none;
    --media-tooltip-border-radius: var(--radius-lg);
    --media-tooltip-background-color: var(--immich-ui-light-200);
    --media-tooltip-distance: 8px;
    --media-tooltip-padding: calc(var(--spacing) * 2) calc(var(--spacing) * 3.5);
  }

  media-time-display {
    font-variant-numeric: tabular-nums;
  }

  immich-time-range,
  media-volume-range {
    --media-control-hover-background: none;
  }

  immich-time-range:hover,
  media-volume-range:hover {
    --media-range-thumb-opacity: 1;
  }

  *::part(tooltip) {
    --media-font-size: var(--text-xs);
    --media-text-content-height: var(--text-xs--line-height);
    color: white;
  }

  *[mediavolumeunavailable] {
    --media-volume-range-display: none;
  }

  .volume-wrapper {
    --media-control-hover-background: none;
  }

  media-volume-range:has(+ media-mute-button) {
    padding: 0;
    margin: 0;
    width: 0;
    overflow: hidden;
    transition: width 0.4s ease-out;
  }

  /* Expand volume control in all relevant states */
  .volume-wrapper:hover > media-volume-range,
  media-volume-range:has(+ media-mute-button:hover),
  media-volume-range:has(+ media-mute-button:focus),
  media-volume-range:has(+ media-mute-button:focus-within),
  media-volume-range:hover,
  media-volume-range:focus,
  media-volume-range:focus-within {
    padding: 0 calc(var(--spacing) * 2);
    margin-left: calc(var(--spacing) * 2);
    width: 70px;
  }
</style>
