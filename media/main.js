(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);

  const elements = {
    artworkFrame: byId('artwork-frame'),
    artwork: byId('artwork'),
    artworkPlaceholder: byId('artwork-placeholder'),
    youtubeVideo: byId('youtube-video'),
    title: byId('title'),
    artist: byId('artist'),
    album: byId('album'),
    status: byId('status'),
    playerName: byId('player-name'),
    progress: byId('progress'),
    position: byId('position'),
    duration: byId('duration'),
    previous: byId('previous'),
    seekBack: byId('seek-back'),
    playPause: byId('play-pause'),
    seekForward: byId('seek-forward'),
    next: byId('next'),
    shuffle: byId('shuffle'),
    repeat: byId('repeat'),
    refresh: byId('refresh'),
    mute: byId('mute'),
    volume: byId('volume'),
    volumeValue: byId('volume-value'),
    message: byId('message'),
  };

  let seeking = false;
  let changingVolume = false;
  let currentYoutubeVideoId;
  let failedYoutubeVideoId;
  let latestYoutubeState;
  let youtubeMessage = '';

  const youtubePlayerUrl = elements.artworkFrame.dataset.youtubePlayerUrl;
  const youtubePlayerToken = (() => {
    try {
      const parts = new URL(youtubePlayerUrl).pathname.split('/').filter(Boolean);
      return parts.at(-1);
    } catch {
      return undefined;
    }
  })();

  const post = (command, value) => {
    vscode.postMessage(value === undefined ? { command } : { command, value });
  };

  const formatTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return '0:00';
    }
    const rounded = Math.floor(seconds);
    const minutes = Math.floor(rounded / 60);
    const remainder = String(rounded % 60).padStart(2, '0');
    return `${minutes}:${remainder}`;
  };

  const setArtwork = (url) => {
    if (typeof url === 'string' && url.length > 0) {
      elements.artwork.src = url;
      elements.artwork.classList.remove('hidden');
      elements.artworkPlaceholder.classList.add('hidden');
    } else {
      elements.artwork.removeAttribute('src');
      elements.artwork.classList.add('hidden');
      elements.artworkPlaceholder.classList.remove('hidden');
    }
  };

  const postYoutubeState = () => {
    if (
      latestYoutubeState === undefined ||
      elements.youtubeVideo.contentWindow === null
    ) {
      return;
    }
    elements.youtubeVideo.contentWindow.postMessage(latestYoutubeState, '*');
  };

  const hideYoutubeVideo = () => {
    currentYoutubeVideoId = undefined;
    latestYoutubeState = undefined;
    elements.youtubeVideo.classList.add('hidden');
    elements.youtubeVideo.removeAttribute('src');
  };

  const setYoutubeVideo = (state) => {
    const videoId = /^[a-zA-Z0-9_-]{11}$/.test(state.youtubeVideoId ?? '')
      ? state.youtubeVideoId
      : undefined;
    const videoUrl =
      typeof state.youtubeVideoUrl === 'string' &&
      state.youtubeVideoUrl.startsWith('https://')
        ? state.youtubeVideoUrl
        : undefined;
    if (
      state.showYouTubeVideo !== true ||
      youtubePlayerUrl.length === 0 ||
      youtubePlayerToken === undefined ||
      videoId === undefined ||
      videoUrl === undefined ||
      videoId === failedYoutubeVideoId
    ) {
      hideYoutubeVideo();
      return;
    }

    if (failedYoutubeVideoId !== undefined && failedYoutubeVideoId !== videoId) {
      failedYoutubeVideoId = undefined;
      youtubeMessage = '';
    }
    latestYoutubeState = {
      type: 'youtube-state',
      token: youtubePlayerToken,
      videoId,
      videoUrl,
      status: state.status,
      positionSeconds:
        Number(state.youtubePositionSeconds) ||
        Number(state.positionSeconds) ||
        0,
      sampledAt: Date.now(),
    };

    if (currentYoutubeVideoId !== videoId) {
      currentYoutubeVideoId = videoId;
      youtubeMessage = 'Loading muted video…';
      elements.message.textContent = youtubeMessage;
      elements.youtubeVideo.src = youtubePlayerUrl;
    }
    elements.youtubeVideo.classList.remove('hidden');
    postYoutubeState();
  };

  const setControlsDisabled = (disabled) => {
    [
      elements.previous,
      elements.seekBack,
      elements.playPause,
      elements.seekForward,
      elements.next,
      elements.shuffle,
      elements.repeat,
      elements.mute,
      elements.volume,
      elements.progress,
    ].forEach((element) => {
      element.disabled = disabled;
    });
  };

  const applyCapabilities = (active, capabilities) => {
    const supported = capabilities || {};
    elements.previous.disabled = !active || supported.previous !== true;
    elements.next.disabled = !active || supported.next !== true;
    elements.seekBack.disabled = !active || supported.seek !== true;
    elements.seekForward.disabled = !active || supported.seek !== true;
    elements.volume.disabled = !active || supported.volume !== true;
    elements.mute.disabled = !active || supported.mute !== true;
    elements.shuffle.disabled = !active || supported.shuffle !== true;
    elements.repeat.disabled = !active || supported.repeat !== true;
  };

  const renderState = (state) => {
    const active = state.active === true;
    elements.title.textContent = active ? state.title : 'No active media';
    elements.artist.textContent = active ? state.artist : '';
    elements.album.textContent = active ? state.album : '';
    elements.status.textContent = active
      ? state.status
      : state.installed === false
        ? 'Unavailable'
        : 'Waiting for a media player';
    elements.playerName.textContent =
      active && state.playerName ? `Player: ${state.playerName}` : '';
    elements.message.textContent = state.message || youtubeMessage;

    setArtwork(active ? state.artworkUrl : undefined);
    if (active) {
      setYoutubeVideo(state);
    } else {
      hideYoutubeVideo();
    }
    setControlsDisabled(!active);
    applyCapabilities(active, state.capabilities);

    const isPlaying = state.status === 'Playing';
    elements.playPause.textContent = isPlaying ? '⏸' : '▶';
    elements.playPause.title = isPlaying ? 'Pause' : 'Play';

    const length = Number(state.lengthSeconds) || 0;
    const position = Number(state.positionSeconds) || 0;
    if (!seeking) {
      elements.progress.max = String(Math.max(0, length));
      elements.progress.value = String(Math.min(position, length || position));
      elements.position.textContent = formatTime(position);
    }
    elements.duration.textContent = formatTime(length);
    elements.progress.disabled =
      !active || state.capabilities?.seek !== true || length <= 0;

    const volume = Number(state.volume) || 0;
    if (!changingVolume) {
      elements.volume.value = String(volume);
      elements.volumeValue.textContent = `${Math.round(volume * 100)}%`;
    }
    elements.mute.textContent = state.muted ? '🔇' : '🔊';
    elements.mute.title = state.muted ? 'Unmute' : 'Mute';

    elements.shuffle.classList.toggle('active', state.shuffle === true);
    elements.shuffle.textContent =
      state.shuffle === null
        ? 'Shuffle'
        : state.shuffle
          ? 'Shuffle: On'
          : 'Shuffle: Off';
    elements.repeat.classList.toggle(
      'active',
      state.repeat === 'Track' || state.repeat === 'Playlist',
    );
    elements.repeat.textContent =
      state.repeat === 'Unknown' ? 'Repeat' : `Repeat: ${state.repeat}`;
  };

  elements.artwork.addEventListener('error', () => setArtwork(undefined));
  elements.youtubeVideo.addEventListener('load', postYoutubeState);
  elements.previous.addEventListener('click', () => post('previous'));
  elements.seekBack.addEventListener('click', () => post('seekRelative', -10));
  elements.playPause.addEventListener('click', () => post('playPause'));
  elements.seekForward.addEventListener('click', () => post('seekRelative', 10));
  elements.next.addEventListener('click', () => post('next'));
  elements.shuffle.addEventListener('click', () => post('toggleShuffle'));
  elements.repeat.addEventListener('click', () => post('cycleRepeat'));
  elements.refresh.addEventListener('click', () => post('refresh'));
  elements.mute.addEventListener('click', () => post('toggleMute'));

  elements.progress.addEventListener('input', () => {
    seeking = true;
    elements.position.textContent = formatTime(Number(elements.progress.value));
  });
  elements.progress.addEventListener('change', () => {
    post('seekTo', Number(elements.progress.value));
    seeking = false;
  });

  elements.volume.addEventListener('input', () => {
    changingVolume = true;
    elements.volumeValue.textContent = `${Math.round(Number(elements.volume.value) * 100)}%`;
  });
  elements.volume.addEventListener('change', () => {
    post('setVolume', Number(elements.volume.value));
    changingVolume = false;
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.type === 'state' && message.state) {
      renderState(message.state);
    } else if (
      event.source === elements.youtubeVideo.contentWindow &&
      message?.token === youtubePlayerToken &&
      (message.type === 'youtube-wrapper-ready' ||
        message.type === 'youtube-ready' ||
        message.type === 'youtube-playing')
    ) {
      if (message.type === 'youtube-ready' || message.type === 'youtube-playing') {
        const type = message.type === 'youtube-ready' ? 'ready' : 'playing';
        if (type === 'playing') {
          youtubeMessage = '';
          elements.message.textContent = '';
        }
        post('youtubeEvent', {
          type,
          videoId: message.videoId,
          detail: Number(message.detail),
        });
      }
      postYoutubeState();
    } else if (
      event.source === elements.youtubeVideo.contentWindow &&
      message?.type === 'youtube-autoplay-blocked' &&
      message.token === youtubePlayerToken &&
      message.videoId === currentYoutubeVideoId
    ) {
      youtubeMessage = 'Click the video to start muted playback';
      elements.message.textContent = youtubeMessage;
      post('youtubeEvent', {
        type: 'autoplay-blocked',
        videoId: message.videoId,
      });
    } else if (
      event.source === elements.youtubeVideo.contentWindow &&
      message?.type === 'youtube-error' &&
      message.token === youtubePlayerToken &&
      message.videoId === currentYoutubeVideoId
    ) {
      failedYoutubeVideoId = currentYoutubeVideoId;
      const errorCode = Number(message.detail);
      youtubeMessage = Number.isFinite(errorCode)
        ? `YouTube video unavailable (error ${errorCode})`
        : 'YouTube video unavailable';
      elements.message.textContent = youtubeMessage;
      post('youtubeEvent', {
        type: 'error',
        videoId: message.videoId,
        detail: errorCode,
      });
      hideYoutubeVideo();
    }
  });

  post('refresh');
})();
