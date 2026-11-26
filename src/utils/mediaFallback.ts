import { getCachedMediaResponse } from './clipStorage';

export interface MediaFallbackResult {
  url: string;
  isObjectUrl: boolean;
}

export async function resolveMediaFallback(params: {
  url: string;
  sourceType?: 'sample' | 'upload';
  sourceId?: string;
  triedUrls: Set<string>;
}): Promise<MediaFallbackResult | null> {
  const { url, sourceType, sourceId, triedUrls } = params;

  // 1. Check local browser CacheStorage first (helps if server temp expired or offline)
  if (url) {
    try {
      const cached = await getCachedMediaResponse(url);
      if (cached && cached.ok) {
        const blob = await cached.blob();
        if (blob.size > 0) {
          const objectUrl = URL.createObjectURL(blob);
          if (!triedUrls.has(objectUrl)) {
            return { url: objectUrl, isObjectUrl: true };
          }
          URL.revokeObjectURL(objectUrl);
        }
      }
    } catch {
      // Continue to server proxy fallback
    }
  }

  // 2. For uploaded media with browser-incompatible codecs/containers (e.g. MOV/MKV/HEVC),
  //    request an H.264/AAC MP4 preview proxy from the server once.
  if (sourceType === 'upload' && sourceId) {
    const proxyUrl = `/api/preview-proxy/${encodeURIComponent(sourceId)}`;
    if (!triedUrls.has(proxyUrl) && url !== proxyUrl) {
      try {
        const res = await fetch(proxyUrl);
        if (res.ok) {
          const contentType = res.headers.get('content-type') || '';
          if (contentType.startsWith('video/')) {
            return { url: proxyUrl, isObjectUrl: false };
          }
        }
      } catch {
        // Ignore network failures
      }
    }
  }

  return null;
}
