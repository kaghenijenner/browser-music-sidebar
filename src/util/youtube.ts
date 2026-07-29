const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/u;

const isYouTubeHost = (hostname: string): boolean =>
  hostname === 'youtube.com' ||
  hostname.endsWith('.youtube.com') ||
  hostname === 'youtube-nocookie.com' ||
  hostname.endsWith('.youtube-nocookie.com');

const isYouTubeImageHost = (hostname: string): boolean =>
  hostname === 'ytimg.com' || hostname.endsWith('.ytimg.com');

export const getYouTubeVideoId = (
  candidate: string | undefined,
): string | undefined => {
  if (candidate === undefined || candidate.length === 0) {
    return undefined;
  }

  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    let videoId: string | null | undefined;

    if (hostname === 'youtu.be') {
      videoId = url.pathname.split('/').find((part) => part.length > 0);
    } else if (isYouTubeHost(hostname)) {
      if (url.pathname === '/watch') {
        videoId = url.searchParams.get('v');
      } else {
        const parts = url.pathname.split('/').filter(Boolean);
        if (['embed', 'live', 'shorts', 'v'].includes(parts[0] ?? '')) {
          videoId = parts[1];
        }
      }
    } else if (isYouTubeImageHost(hostname)) {
      const parts = url.pathname.split('/').filter(Boolean);
      const marker = parts.findIndex(
        (part) => part === 'vi' || part === 'vi_webp',
      );
      videoId = marker >= 0 ? parts[marker + 1] : undefined;
    }

    return VIDEO_ID_PATTERN.test(videoId ?? '') ? videoId ?? undefined : undefined;
  } catch {
    return undefined;
  }
};
