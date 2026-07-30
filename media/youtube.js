(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  const elements = {
    root: document.querySelector('.youtube'),
    searchForm: byId('search-form'),
    searchInput: byId('search-input'),
    searchButton: byId('search-button'),
    nowPlaying: byId('now-playing'),
    player: byId('youtube-player'),
    playerPlaceholder: byId('player-placeholder'),
    playingTitle: byId('playing-title'),
    playingChannel: byId('playing-channel'),
    status: byId('status'),
    results: byId('results'),
  };

  const savedState = vscode.getState() || {};
  let results = Array.isArray(savedState.results) ? savedState.results : [];
  let selectedResult;
  let currentVideoId;
  let latestPlayerState;

  const playerUrl = elements.root.dataset.playerUrl;
  const playerToken = (() => {
    try {
      const parts = new URL(playerUrl).pathname.split('/').filter(Boolean);
      return parts.at(-1);
    } catch {
      return undefined;
    }
  })();

  const post = (command, value) => {
    vscode.postMessage({ command, value });
  };

  const formatDuration = (seconds) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    if (total === 0) {
      return '';
    }
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = String(total % 60).padStart(2, '0');
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`
      : `${minutes}:${remainder}`;
  };

  const saveState = () => {
    vscode.setState({
      query: elements.searchInput.value,
      results,
      selectedVideoId: selectedResult?.videoId,
    });
  };

  const setStatus = (message, isError) => {
    elements.status.textContent = message;
    elements.status.classList.toggle('error', isError === true);
  };

  const postPlayerState = () => {
    if (
      latestPlayerState === undefined ||
      elements.player.contentWindow === null
    ) {
      return;
    }
    elements.player.contentWindow.postMessage(latestPlayerState, '*');
  };

  const isSearchResult = (result) =>
    result &&
    /^[a-zA-Z0-9_-]{11}$/.test(result.videoId) &&
    typeof result.title === 'string' &&
    typeof result.channel === 'string' &&
    typeof result.thumbnailUrl === 'string';

  const playResult = (result) => {
    if (!isSearchResult(result)) {
      return;
    }
    selectedResult = result;
    currentVideoId = result.videoId;
    latestPlayerState = undefined;
    elements.nowPlaying.classList.remove('hidden');
    elements.playingTitle.textContent = result.title;
    elements.playingChannel.textContent = result.channel;
    elements.player.classList.add('hidden');
    elements.playerPlaceholder.classList.remove('hidden');
    elements.playerPlaceholder.textContent = 'Preparing video…';
    setStatus('Resolving a playable stream…');
    saveState();
    post('play', result.videoId);
  };

  const renderResults = () => {
    elements.results.replaceChildren();
    for (const result of results.filter(isSearchResult)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'result';
      button.setAttribute('aria-label', `Play ${result.title}`);
      button.addEventListener('click', () => playResult(result));

      const thumbnail = document.createElement('img');
      thumbnail.className = 'thumbnail';
      thumbnail.src = result.thumbnailUrl;
      thumbnail.alt = '';
      thumbnail.loading = 'lazy';
      thumbnail.addEventListener('error', () => {
        thumbnail.classList.add('hidden');
      });

      const details = document.createElement('span');
      details.className = 'result-details';
      const title = document.createElement('span');
      title.className = 'result-title';
      title.textContent = result.title;
      const metadata = document.createElement('span');
      metadata.className = 'result-metadata';
      const duration = formatDuration(result.durationSeconds);
      metadata.textContent =
        duration.length > 0 ? `${result.channel} · ${duration}` : result.channel;
      details.append(title, metadata);
      button.append(thumbnail, details);
      elements.results.append(button);
    }
  };

  elements.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = elements.searchInput.value.trim();
    if (query.length === 0) {
      elements.searchInput.focus();
      return;
    }
    elements.searchButton.disabled = true;
    setStatus('Searching YouTube…');
    saveState();
    post('search', query);
  });

  elements.player.addEventListener('load', () => {
    elements.player.classList.remove('hidden');
    elements.playerPlaceholder.classList.add('hidden');
    postPlayerState();
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type === 'youtube-search-started') {
      elements.searchButton.disabled = true;
      setStatus('Searching YouTube…');
    } else if (
      message?.type === 'youtube-search-results' &&
      Array.isArray(message.results)
    ) {
      elements.searchButton.disabled = false;
      results = message.results.filter(isSearchResult);
      renderResults();
      saveState();
      setStatus(
        results.length === 0
          ? `No results for “${message.query}”.`
          : `${results.length} result${results.length === 1 ? '' : 's'}`,
      );
    } else if (message?.type === 'youtube-search-error') {
      elements.searchButton.disabled = false;
      setStatus(message.message || 'YouTube search failed.', true);
    } else if (
      message?.type === 'youtube-playback-started' &&
      message.videoId === currentVideoId
    ) {
      setStatus('Resolving a playable stream…');
    } else if (
      message?.type === 'youtube-playback-ready' &&
      message.videoId === currentVideoId &&
      typeof message.videoUrl === 'string' &&
      message.videoUrl.startsWith('https://') &&
      playerToken !== undefined
    ) {
      latestPlayerState = {
        type: 'youtube-state',
        token: playerToken,
        videoId: message.videoId,
        videoUrl: message.videoUrl,
        audioUrl:
          typeof message.audioUrl === 'string' &&
          (() => {
            try {
              return (
                new URL(message.audioUrl).origin ===
                new URL(playerUrl).origin
              );
            } catch {
              return false;
            }
          })()
            ? message.audioUrl
            : undefined,
        status: 'Paused',
        muted: false,
        positionSeconds: 0,
        sampledAt: Date.now(),
      };
      if (elements.player.getAttribute('src') !== playerUrl) {
        elements.player.src = playerUrl;
      } else {
        elements.player.classList.remove('hidden');
        elements.playerPlaceholder.classList.add('hidden');
        postPlayerState();
      }
      setStatus('Starting playback…');
    } else if (
      message?.type === 'youtube-playback-error' &&
      message.videoId === currentVideoId
    ) {
      elements.playerPlaceholder.textContent = 'Video unavailable';
      setStatus(message.message || 'This video could not be played.', true);
    } else if (
      event.source === elements.player.contentWindow &&
      message?.token === playerToken &&
      message.type === 'youtube-wrapper-ready'
    ) {
      postPlayerState();
    } else if (
      event.source === elements.player.contentWindow &&
      message?.token === playerToken &&
      message.videoId === currentVideoId &&
      (message.type === 'youtube-ready' ||
        message.type === 'youtube-playing' ||
        message.type === 'youtube-autoplay-blocked' ||
        message.type === 'youtube-error' ||
        message.type === 'youtube-audio-ready' ||
        message.type === 'youtube-audio-playing' ||
        message.type === 'youtube-audio-blocked' ||
        message.type === 'youtube-audio-error' ||
        message.type === 'youtube-playback-blocked')
    ) {
      if (message.type === 'youtube-ready') {
        setStatus('Ready');
      } else if (message.type === 'youtube-playing') {
        setStatus('');
      } else if (message.type === 'youtube-autoplay-blocked') {
        setStatus('Press play in the video to start playback.');
      } else if (
        message.type === 'youtube-error' ||
        message.type === 'youtube-audio-error'
      ) {
        setStatus('YouTube could not play this video.', true);
      } else if (
        message.type === 'youtube-audio-blocked' ||
        message.type === 'youtube-playback-blocked'
      ) {
        setStatus('Playback was blocked. Press Play again.', true);
      }
      post('youtubeEvent', {
        type: message.type.replace('youtube-', ''),
        videoId: message.videoId,
        detail:
          typeof message.detail === 'string'
            ? message.detail
            : Number(message.detail),
      });
      if (message.type === 'youtube-ready') {
        postPlayerState();
      }
    }
  });

  if (typeof savedState.query === 'string') {
    elements.searchInput.value = savedState.query;
  }
  renderResults();
  if (results.length > 0) {
    setStatus(
      `${results.length} saved result${results.length === 1 ? '' : 's'}`,
    );
  }
})();
