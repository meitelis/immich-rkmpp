<script lang="ts">
  import FaceEditor from '$lib/components/asset-viewer/face-editor/FaceEditor.svelte';
  import VideoRemoteViewer from '$lib/components/asset-viewer/VideoRemoteViewer.svelte';
  import { assetViewerFadeDuration } from '$lib/constants';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { castManager } from '$lib/managers/cast-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { mediaCapabilitiesManager } from '$lib/managers/media-capabilities-manager.svelte';
  import { autoPlayVideo, lang, loopVideo as loopVideoPreference } from '$lib/stores/preferences.store';
  import { getAssetHlsSessionUrl, getAssetHlsUrl, getAssetMediaUrl, getAssetPlaybackUrl } from '$lib/utils';
  import { monitorDirectPlayback } from '$lib/utils/direct-playback';
  import { preferDirectOriginal } from '$lib/utils/auto-original';
  import {
    isHevcCodec,
    isHevcDecodeFailure,
    isMediaDecodeFailure,
    playbackPosition,
    type PlaybackPosition,
  } from '$lib/utils/video-codec';
  import { AssetMediaSize, type AssetResponseDto } from '@immich/sdk';
  import { Icon, LoadingSpinner, shortcuts } from '@immich/ui';
  import {
    mdiCheck,
    mdiChevronLeft,
    mdiChevronRight,
    mdiFullscreen,
    mdiFullscreenExit,
    mdiPause,
    mdiPlay,
    mdiVolumeHigh,
    mdiVolumeLow,
    mdiVolumeMedium,
    mdiVolumeMute,
  } from '@mdi/js';
  import 'hls-video-element';
  import type HlsVideoElement from 'hls-video-element';
  import Hls, { AbrController, Events, type FragLoadedData, type FragLoadingData, type HlsConfig } from 'hls.js';
  import 'media-chrome/media-control-bar';
  import 'media-chrome/media-controller';
  import 'media-chrome/media-fullscreen-button';
  import 'media-chrome/media-mute-button';
  import 'media-chrome/media-play-button';
  import 'media-chrome/media-playback-rate-button';
  import 'media-chrome/media-time-display';
  import 'media-chrome/media-volume-range';
  import 'media-chrome/menu/media-playback-rate-menu';
  import 'media-chrome/menu/media-rendition-menu';
  import 'media-chrome/menu/media-settings-menu';
  import 'media-chrome/menu/media-settings-menu-button';
  import 'media-chrome/menu/media-settings-menu-item';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { useSwipe, type SwipeCustomEvent } from 'svelte-gestures';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
  import './immich-time-range';

  interface Props {
    asset: AssetResponseDto;
    assetId: string;
    loopVideo: boolean;
    cacheKey: string | null;
    playOriginalVideo: boolean;
    extendedControls?: boolean;
    onPreviousAsset?: () => void;
    onNextAsset?: () => void;
    onVideoEnded?: () => void;
    onVideoStarted?: () => void;
    onClose?: () => void;
  }

  let {
    asset,
    assetId,
    loopVideo,
    cacheKey,
    playOriginalVideo,
    extendedControls = false,
    onPreviousAsset = () => {},
    onNextAsset = () => {},
    onVideoEnded = () => {},
    onVideoStarted = () => {},
    onClose = () => {},
  }: Props = $props();

  let videoPlayer: HTMLVideoElement | undefined = $state();
  let isLoading = $state(true);
  let hasLoadedMetadata = $state(false);
  let avcFallbackAssetId: string | undefined = $state();
  let directFallbackAssetId: string | undefined = $state();
  let pausedReloadAssetId: string | undefined = $state();
  // Explicit Original continues to override Auto. Auto checks codec and
  // measured capacity before requesting either file or HLS, so no unnecessary
  // RKMPP encoder is started on a fast, compatible connection.
  let automaticOriginal = $state(true);
  let autoOriginalDecision: { assetId: string; direct: boolean } | undefined = $state();
  let autoOriginalPending = $derived(featureFlagsManager.value.realtimeTranscoding &&
    !playOriginalVideo && automaticOriginal && directFallbackAssetId !== assetId &&
    autoOriginalDecision?.assetId !== assetId);
  let autoOriginalDirect = $derived(featureFlagsManager.value.realtimeTranscoding &&
    !playOriginalVideo && automaticOriginal && directFallbackAssetId !== assetId &&
    autoOriginalDecision?.assetId === assetId && autoOriginalDecision.direct);
  let useHls = $derived(featureFlagsManager.value.realtimeTranscoding &&
    (!playOriginalVideo || directFallbackAssetId === assetId) && !autoOriginalDirect);
  let assetFileUrl = $derived.by(() => {
    if (autoOriginalPending) return '';
    if (useHls) {
      return getAssetHlsUrl(assetId, avcFallbackAssetId === assetId ? 'h264' : undefined);
    }

    if (playOriginalVideo || autoOriginalDirect) {
      return getAssetMediaUrl({ id: assetId, size: AssetMediaSize.Original, cacheKey });
    }

    return getAssetPlaybackUrl({ id: assetId, cacheKey });
  });
  const aspectRatio = $derived(asset.width && asset.height ? `${asset.width} / ${asset.height}` : undefined);
  let showVideo = $state(false);
  let hasFocused = $state(false);
  let activeSession: { assetId: string; id: string } | undefined;
  let rebuildCount = 0;
  let playbackAssetId: string | undefined;
  let pendingResume: (PlaybackPosition & { assetId: string }) | undefined;

  const MAX_REBUILDS = 1;
  const SESSION_ID_REGEX = /\/video\/stream\/([0-9a-f-]{36})\//;

  // hls.js can abandon fetching an in-flight fragment if it thinks it'll take too long, in which case
  // it emergency switches to a different variant. This extends the delay even further due to
  // cold starting another transcode, so let the fragment finish and have steady ABR decide the next level.
  //
  // It can also emergency switch between fragments: while a switch's first segment is still loading,
  // it can run out of buffer and drop to a lower level for just one segment before continuing at the switched quality.
  // This can cause multiple redundant transcoding restarts when it occurs.
  // Hold the committed level until its first fragment lands, then resume normal ABR.
  class NoAbandonAbrController extends AbrController {
    private switchTarget = -1;

    protected override onFragLoading(_event: Events.FRAG_LOADING, data: FragLoadingData) {
      if (data.frag.sn === 'initSegment') {
        this.switchTarget = data.frag.level;
      }
    }

    protected override onFragLoaded(event: Events.FRAG_LOADED, data: FragLoadedData) {
      if (data.frag.sn !== 'initSegment') {
        this.switchTarget = -1;
      }
      super.onFragLoaded(event, data);
    }

    override get nextAutoLevel(): number {
      const level = super.nextAutoLevel;
      const target = this.hls.levels[this.switchTarget];
      // Hold the committed level, but only while hls.js still considers it healthy.
      if (target && level < this.switchTarget && target.loadError === 0 && target.fragmentError === 0) {
        return this.switchTarget;
      }
      return level;
    }

    override set nextAutoLevel(level: number) {
      super.nextAutoLevel = level;
    }
  }

  let hlsPositionHint: { api: Hls; position: number } | undefined;
  const hlsConfig: Partial<HlsConfig> = {
    abrController: NoAbandonAbrController,
    highBufferWatchdogPeriod: 10,
    detectStallWithCurrentTimeMs: 10_000,
    maxBufferHole: 0.5,
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    fragLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 30_000,
        maxLoadTimeMs: 60_000,
        timeoutRetry: { maxNumRetry: 5, retryDelayMs: 100, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
      },
    },
    useMediaCapabilities: false,
    xhrSetup: (xhr: XMLHttpRequest, url: string) => {
      const authenticatedUrl = new URL(url, location.origin);
      for (const [key, value] of Object.entries(authManager.params)) {
        if (value) {
          authenticatedUrl.searchParams.set(key, value as string);
        }
      }
      xhr.open('GET', authenticatedUrl.href);
      const api = isHlsElement(videoPlayer) ? videoPlayer.api : undefined;
      const frag = api?.inFlightFragments?.main.frag;
      // During init loading hls.js exposes the associated media fragment. Its
      // sequence number is exact; a server guess can be far ahead after a seek
      // or an immediate quality switch with a full playback buffer.
      if (typeof frag?.sn === 'number' && frag.initSegment?.url === url) {
        xhr.setRequestHeader('x-immich-hls-msn', String(frag.sn));
      }
      const hint = hlsPositionHint;
      if (hint && hint.api === api && authenticatedUrl.pathname.endsWith('/playlist.m3u8') &&
        authenticatedUrl.pathname.match(SESSION_ID_REGEX)?.[1] === activeSession?.id) {
        xhr.setRequestHeader('x-immich-hls-pos', String(hint.position));
        hlsPositionHint = undefined;
      }
    },
  };

  const releaseSession = () => {
    hlsPositionHint = undefined;
    const session = activeSession;
    if (!session) {
      return;
    }
    activeSession = undefined;
    const url = getAssetHlsSessionUrl(session.assetId, session.id);
    void fetch(url, { method: 'DELETE' }).catch(() => console.warn('Failed to release HLS session', session));
  };

  const isHlsElement = (el: HTMLVideoElement | undefined): el is HlsVideoElement => {
    return el?.tagName === 'HLS-VIDEO';
  };

  const rememberPlayback = (el: HTMLVideoElement, id: string) => {
    pendingResume = pendingResume?.assetId === id ? pendingResume : { assetId: id, ...playbackPosition(el) };
    if (pendingResume.paused) {
      pausedReloadAssetId = id;
      // hls-video-element checks autoplay in its own manifest callback. Set the
      // public property before changing src/load; keep the hold after metadata.
      el.autoplay = false;
    }
    return pendingResume.currentTime;
  };

  const handlePlay = (el: HTMLVideoElement) => {
    if (el !== videoPlayer) {
      return;
    }
    if (pendingResume?.assetId === assetId) {
      pendingResume.paused = false;
    }
    if (pausedReloadAssetId === assetId) {
      pausedReloadAssetId = undefined;
      el.autoplay = $autoPlayVideo;
    }
  };

  const retryWithAvc = (el: HlsVideoElement, id: string) => {
    if (videoPlayer !== el || assetId !== id || avcFallbackAssetId === id) {
      return false;
    }
    rememberPlayback(el, id);
    isLoading = true;
    // Changing the source releases the old session and creates an AVC-only one.
    // The server filters the master too, which also covers native HLS players.
    avcFallbackAssetId = id;
    return true;
  };

  const currentVideoCodec = (el: HlsVideoElement, level?: number) => {
    const api = el.api;
    if (!api) {
      return undefined;
    }
    const index = level ?? (api.currentLevel >= 0 ? api.currentLevel : api.loadLevel);
    return api.levels[index]?.videoCodec ??
      (api.levels.length === 0 || api.levels.some((item) => isHevcCodec(item.videoCodec)) ? undefined : 'avc1');
  };

  const handleMediaError = (event: Event) => {
    const el = event.currentTarget as HTMLVideoElement;
    if (!isHlsElement(el)) {
      if (isMediaDecodeFailure(el.error?.code)) retryWithHls(el, assetId);
      return;
    }
    if (
      isMediaDecodeFailure(el.error?.code) &&
      (!el.api || isHevcCodec(currentVideoCodec(el)))
    ) {
      retryWithAvc(el, assetId);
    }
  };

  const retryWithHls = (el: HTMLVideoElement, id: string) => {
    if (videoPlayer !== el || assetId !== id || !featureFlagsManager.value.realtimeTranscoding ||
      (!playOriginalVideo && !autoOriginalDirect) || directFallbackAssetId === id) return;
    rememberPlayback(el, id);
    isLoading = true;
    directFallbackAssetId = id;
  };

  const handleLoadedMetadata = (el: HTMLVideoElement) => {
    hasLoadedMetadata = true;
    const resume = pendingResume;
    if (!resume || resume.assetId !== assetId || el !== videoPlayer) {
      return;
    }
    pendingResume = undefined;
    el.currentTime = resume.currentTime;
    if (resume.paused) {
      el.pause();
    } else {
      void el.play().catch(() => {});
    }
  };

  const wireHlsListeners = (el: HlsVideoElement, assetId: string, resumeTime?: number) => {
    const api = el.api;
    if (!api) {
      return;
    }
    if (resumeTime !== undefined) hlsPositionHint = { api, position: resumeTime };

    // This is a hack to make the rendition menu use `api.currentLevel` instead of `api.nextLevel`.
    // `api.nextLevel` makes the player request the next segment followed by the current segment.
    // That backward request causes the server to restart transcoding for no reason.
    Object.defineProperty(api, 'nextLevel', {
      configurable: true,
      get: () => api.currentLevel,
      set: (level: number) => {
        hlsPositionHint = { api, position: playbackPosition(el).currentTime };
        api.currentLevel = level;
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    api.on(Hls.Events.MANIFEST_PARSED, async () => {
      if (el !== videoPlayer || el.api !== api || playbackAssetId !== assetId) {
        return;
      }
      // Defer hls.js's first fragment load until we filter out suboptimal variants
      api.stopLoad();
      const id = api.levels[0]?.url[0]?.match(SESSION_ID_REGEX)?.[1];
      if (id) {
        activeSession = { assetId, id };
      }

      if (avcFallbackAssetId === assetId) {
        for (let i = api.levels.length - 1; i >= 0; i--) {
          if (!api.levels[i].videoCodec?.startsWith('avc1')) {
            api.removeLevel(i);
          }
        }
      }
      const keep = await mediaCapabilitiesManager.efficientLevels(api.levels);
      // Capability queries can finish after the source or viewer has changed.
      if (el !== videoPlayer || el.api !== api || playbackAssetId !== assetId) {
        return;
      }
      if (keep.size === 0) {
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

  let displayedMode: { assetId: string; original: boolean } | undefined;
  $effect.pre(() => {
    const previous = displayedMode;
    displayedMode = { assetId, original: playOriginalVideo };
    if (previous?.assetId === assetId && previous.original !== playOriginalVideo && videoPlayer) {
      untrack(() => rememberPlayback(videoPlayer!, assetId));
      // A fresh explicit Original selection may retry after an earlier fallback.
      if (playOriginalVideo) directFallbackAssetId = undefined;
    }
    if (previous && previous.assetId !== assetId) directFallbackAssetId = undefined;
  });

  $effect(() => {
    // reactive on `assetFileUrl` changes
    hasLoadedMetadata = false;
    if (videoPlayer && !assetFileUrl) {
      // Avoid continuing the previous asset while an Auto decision is pending.
      videoPlayer.pause();
      videoPlayer.src = '';
      releaseSession();
    }
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
        videoPlayer.src = assetFileUrl;
        const el = videoPlayer;
        const id = assetId;
        const stopMonitor = featureFlagsManager.value.realtimeTranscoding && (playOriginalVideo || autoOriginalDirect)
          ? monitorDirectPlayback(el, () => retryWithHls(el, id))
          : undefined;
        return () => {
          stopMonitor?.();
          releaseSession();
        };
      }
    }
    return releaseSession;
  });

  // Cancel probes on navigation, mode changes and teardown; late decisions
  // must never re-enable the old asset or bounce back after a fallback.
  $effect(() => {
    const id = assetId;
    if (!featureFlagsManager.value.realtimeTranscoding || playOriginalVideo ||
      !automaticOriginal || directFallbackAssetId === id || typeof document === 'undefined') return;
    const controller = new AbortController();
    const decoder = document.createElement('video');
    void preferDirectOriginal({
      masterUrl: getAssetHlsUrl(id),
      authParams: authManager.params,
      canPlay: (mime) => decoder.canPlayType(mime),
      signal: controller.signal,
    }).then((direct) => {
      if (!controller.signal.aborted && assetId === id) autoOriginalDecision = { assetId: id, direct };
    });
    return () => controller.abort();
  });

  const setAutomaticOriginal = (enabled: boolean) => {
    if (enabled === automaticOriginal) return;
    if (videoPlayer && assetFileUrl) rememberPlayback(videoPlayer, assetId);
    automaticOriginal = enabled;
    autoOriginalDecision = undefined;
    directFallbackAssetId = undefined;
  };

  // media-chrome handles checkable menu-item clicks itself and dispatches a
  // `change` event from the parent menu. A click listener on the item does
  // not reliably fire or update its Svelte state.
  const handleOriginalMenuChange = (event: Event) => {
    if (event.target !== event.currentTarget) return;
    const menu = event.currentTarget as HTMLElement;
    const checkbox = menu.querySelector('media-settings-menu-item[type="checkbox"][value="auto-original"]');
    if (!checkbox) return;
    setAutomaticOriginal(checkbox.getAttribute('aria-checked') === 'true');
  };

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

  const handleControlKeydown = (event: KeyboardEvent) => {
    if (event.key !== ' ') return;
    // Space activates the focused control. Do not also let the body shortcut
    // toggle video playback; controls inside shadow roots appear in this path.
    if (event.composedPath().some((target) => target instanceof HTMLElement && target !== event.currentTarget &&
      (target.tagName.startsWith('MEDIA-') || target.matches('button, input, select, textarea, [role="button"], [role="slider"], [role^="menuitem"]')))) {
      event.stopPropagation();
    }
  };

  const controlShortcuts = (controller: HTMLElement, media: HTMLVideoElement | undefined) => {
    let generation = 0;
    let disposed = false;
    const updateMedia = (next: HTMLVideoElement | undefined) => {
      const version = ++generation;
      // media-chrome 4.19.2 can process an added replacement before the removed
      // old media and then clear its store. Rebind after that mutation batch,
      // preserving this controller (and its fullscreen element and controls).
      queueMicrotask(() => {
        if (disposed || version !== generation || !next || !controller.isConnected ||
          controller.querySelector(':scope > [slot=media]') !== next) return;
        (controller as HTMLElement & { mediaSetCallback: (el: HTMLVideoElement) => void }).mediaSetCallback(next);
      });
    };
    controller.addEventListener('keydown', handleControlKeydown);
    updateMedia(media);
    return {
      update: updateMedia,
      destroy: () => {
        disposed = true;
        controller.removeEventListener('keydown', handleControlKeydown);
      },
    };
  };
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
        use:controlShortcuts={videoPlayer}
      >
        {#if useHls}
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
            loop={$loopVideoPreference && loopVideo}
            autoplay={$autoPlayVideo && pausedReloadAssetId !== assetId}
            disablePictureInPicture
            playsinline
            {...useSwipe(onSwipe)}
            class="h-full object-contain"
            oncanplay={(e) => handleCanPlay(e.currentTarget)}
            onloadedmetadata={(e) => handleLoadedMetadata(e.currentTarget)}
            onplay={(e) => handlePlay(e.currentTarget)}
            onerror={handleMediaError}
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
          <media-settings-menu hidden anchor="auto" class="min-w-3xs rounded-xl border border-light-300 shadow-sm" onchange={handleOriginalMenuChange}>
            <Icon slot="checked-indicator" icon={mdiCheck} class="m-2" />
            <media-settings-menu-item class="mx-1 rounded-lg p-1 ps-2">
              {$t('media_chrome.playback_rate')}
              <Icon slot="suffix" icon={mdiChevronRight} class="m-2" />
              <media-playback-rate-menu slot="submenu" hidden rates="0.5 1 1.5 2">
                <Icon slot="back-icon" icon={mdiChevronLeft} class="m-2" />
                <span slot="title">{$t('media_chrome.playback_rate')}</span>
              </media-playback-rate-menu>
            </media-settings-menu-item>
            {#if featureFlagsManager.value.realtimeTranscoding && !playOriginalVideo}
              <media-settings-menu-item
                class="mx-1 rounded-lg p-1 ps-2"
                type="checkbox"
                value="auto-original"
                checked={automaticOriginal}
                aria-checked={automaticOriginal}
              >
                Auto: prefer original ({automaticOriginal ? 'on' : 'off'})
              </media-settings-menu-item>
            {/if}
            {#if useHls}
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
