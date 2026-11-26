import type { StoredProcessedClip, StudioSettings } from '../types/media';

export const SETTINGS_STORAGE_KEY = 'clearreel_settings_v1';
export const PROCESSED_CLIPS_STORAGE_KEY = 'clearreel_processed_clips_v1';
export const PROCESSED_CLIPS_CACHE_NAME = 'clearreel-processed-clips-v1';
export const AUTO_CLEANUP_HOURS = 24;
export const AUTO_CLEANUP_MAX_AGE_MS = AUTO_CLEANUP_HOURS * 60 * 60 * 1000;
export const STORAGE_UPDATED_EVENT = 'clearreel:storage-updated';
export const CLIPS_PRUNED_EVENT = 'clearreel:clips-pruned';

const MAX_BROWSER_CACHE_CLIP_BYTES = 120 * 1024 * 1024; // 120 MB safety cap per cached blob

const DEFAULT_SETTINGS: StudioSettings = {
  autoCleanup: true,
  cleanupAfterHours: AUTO_CLEANUP_HOURS,
};

function notifyStorageUpdated(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(STORAGE_UPDATED_EVENT));
  }
}

function notifyClipsPruned(outputIds: string[]): void {
  if (typeof window !== 'undefined' && outputIds.length > 0) {
    window.dispatchEvent(new CustomEvent(CLIPS_PRUNED_EVENT, { detail: { outputIds } }));
  }
}

export function loadSettings(): StudioSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<StudioSettings>;
    return {
      autoCleanup: typeof parsed.autoCleanup === 'boolean' ? parsed.autoCleanup : DEFAULT_SETTINGS.autoCleanup,
      cleanupAfterHours:
        typeof parsed.cleanupAfterHours === 'number' && parsed.cleanupAfterHours > 0
          ? parsed.cleanupAfterHours
          : AUTO_CLEANUP_HOURS,
      lastCleanupAt: typeof parsed.lastCleanupAt === 'number' ? parsed.lastCleanupAt : undefined,
      lastCleanupDeletedCount:
        typeof parsed.lastCleanupDeletedCount === 'number' ? parsed.lastCleanupDeletedCount : undefined,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(next: StudioSettings): StudioSettings {
  const normalized: StudioSettings = {
    autoCleanup: Boolean(next.autoCleanup),
    cleanupAfterHours: next.cleanupAfterHours > 0 ? next.cleanupAfterHours : AUTO_CLEANUP_HOURS,
    lastCleanupAt: next.lastCleanupAt,
    lastCleanupDeletedCount: next.lastCleanupDeletedCount,
  };

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // Ignore storage quota / private mode errors
    }
    notifyStorageUpdated();
  }

  return normalized;
}

export function loadProcessedClips(): StoredProcessedClip[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PROCESSED_CLIPS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is StoredProcessedClip =>
          Boolean(item) &&
          typeof item.id === 'string' &&
          typeof item.outputId === 'string' &&
          typeof item.createdAt === 'number'
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

function writeProcessedClips(clips: StoredProcessedClip[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PROCESSED_CLIPS_STORAGE_KEY, JSON.stringify(clips));
  } catch {
    // If localStorage is full, keep only the most recent 25 records and retry
    try {
      window.localStorage.setItem(PROCESSED_CLIPS_STORAGE_KEY, JSON.stringify(clips.slice(0, 25)));
    } catch {
      // Ignore unrecoverable storage errors
    }
  }
}

async function removeClipFromBrowserCache(clip: Pick<StoredProcessedClip, 'previewUrl' | 'downloadUrl'>): Promise<void> {
  if (typeof window === 'undefined' || !('caches' in window)) return;
  try {
    const cache = await window.caches.open(PROCESSED_CLIPS_CACHE_NAME);
    await Promise.all([
      clip.previewUrl ? cache.delete(clip.previewUrl) : Promise.resolve(false),
      clip.downloadUrl ? cache.delete(clip.downloadUrl) : Promise.resolve(false),
    ]);
  } catch {
    // Ignore cache deletion errors
  }
}

export async function getCachedMediaResponse(url: string): Promise<Response | undefined> {
  if (typeof window === 'undefined' || !('caches' in window) || !url) return undefined;
  try {
    const cache = await window.caches.open(PROCESSED_CLIPS_CACHE_NAME);
    const match = await cache.match(url);
    return match || undefined;
  } catch {
    return undefined;
  }
}

export async function saveProcessedClip(
  clip: Omit<StoredProcessedClip, 'id' | 'cachedInBrowser'>
): Promise<StoredProcessedClip[]> {
  const id = `${clip.tool}_${clip.outputId}`;
  let cachedInBrowser = false;

  if (
    typeof window !== 'undefined' &&
    'caches' in window &&
    clip.sizeBytes > 0 &&
    clip.sizeBytes <= MAX_BROWSER_CACHE_CLIP_BYTES
  ) {
    try {
      const response = await fetch(clip.downloadUrl);
      if (response.ok) {
        const cache = await window.caches.open(PROCESSED_CLIPS_CACHE_NAME);
        await cache.put(clip.downloadUrl, response.clone());
        if (clip.previewUrl && clip.previewUrl !== clip.downloadUrl) {
          await cache.put(clip.previewUrl, response);
        }
        cachedInBrowser = true;
      }
    } catch {
      // Cache quota exceeded or network unavailable; metadata still persists
      cachedInBrowser = false;
    }
  }

  const nextRecord: StoredProcessedClip = {
    ...clip,
    id,
    cachedInBrowser,
  };

  const existing = loadProcessedClips().filter((item) => item.id !== id);
  const updated = [nextRecord, ...existing].slice(0, 60);
  writeProcessedClips(updated);

  const settings = loadSettings();
  if (settings.autoCleanup) {
    const cleanupResult = await cleanupExpiredClips(settings.cleanupAfterHours * 60 * 60 * 1000);
    notifyStorageUpdated();
    return cleanupResult.remaining;
  }

  notifyStorageUpdated();
  return updated;
}

export async function deleteProcessedClip(clipId: string): Promise<StoredProcessedClip[]> {
  const existing = loadProcessedClips();
  const target = existing.find((item) => item.id === clipId);
  const remaining = existing.filter((item) => item.id !== clipId);

  if (target) {
    await removeClipFromBrowserCache(target);
    notifyClipsPruned([target.outputId]);
  }
  writeProcessedClips(remaining);
  notifyStorageUpdated();
  return remaining;
}

export async function cleanupExpiredClips(
  maxAgeMs = AUTO_CLEANUP_MAX_AGE_MS
): Promise<{
  deletedCount: number;
  freedBytes: number;
  remaining: StoredProcessedClip[];
  expiredOutputIds: string[];
}> {
  const now = Date.now();
  const clips = loadProcessedClips();
  const expired = clips.filter((item) => now - item.createdAt >= maxAgeMs);
  const remaining = clips.filter((item) => now - item.createdAt < maxAgeMs);

  if (expired.length === 0) {
    return { deletedCount: 0, freedBytes: 0, remaining, expiredOutputIds: [] };
  }

  await Promise.all(expired.map((item) => removeClipFromBrowserCache(item)));
  writeProcessedClips(remaining);

  const freedBytes = expired.reduce((acc, item) => acc + (item.cachedInBrowser ? item.sizeBytes : 0), 0);
  const settings = loadSettings();
  saveSettings({
    ...settings,
    lastCleanupAt: now,
    lastCleanupDeletedCount: expired.length,
  });

  const expiredOutputIds = expired.map((item) => item.outputId);
  notifyClipsPruned(expiredOutputIds);

  return {
    deletedCount: expired.length,
    freedBytes,
    remaining,
    expiredOutputIds,
  };
}

export async function clearAllProcessedClips(): Promise<{
  deletedCount: number;
  freedBytes: number;
}> {
  const clips = loadProcessedClips();
  const freedBytes = clips.reduce((acc, item) => acc + (item.cachedInBrowser ? item.sizeBytes : 0), 0);
  const removedOutputIds = clips.map((item) => item.outputId);

  if (typeof window !== 'undefined' && 'caches' in window) {
    try {
      await window.caches.delete(PROCESSED_CLIPS_CACHE_NAME);
    } catch {
      // Ignore cache delete errors
    }
  }

  writeProcessedClips([]);
  notifyClipsPruned(removedOutputIds);
  notifyStorageUpdated();

  return {
    deletedCount: clips.length,
    freedBytes,
  };
}

export async function getBrowserStorageSummary(): Promise<{
  clipCount: number;
  cachedClipCount: number;
  cachedBytes: number;
  browserUsageBytes?: number;
  browserQuotaBytes?: number;
}> {
  const clips = loadProcessedClips();
  const cachedClips = clips.filter((item) => item.cachedInBrowser);
  const cachedBytes = cachedClips.reduce((acc, item) => acc + (item.sizeBytes || 0), 0);

  let browserUsageBytes: number | undefined;
  let browserQuotaBytes: number | undefined;

  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      if (typeof estimate.usage === 'number') browserUsageBytes = estimate.usage;
      if (typeof estimate.quota === 'number') browserQuotaBytes = estimate.quota;
    } catch {
      // Ignore estimate errors
    }
  }

  return {
    clipCount: clips.length,
    cachedClipCount: cachedClips.length,
    cachedBytes,
    browserUsageBytes,
    browserQuotaBytes,
  };
}
