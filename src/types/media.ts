export type RemovalMode = 'delogo' | 'blur' | 'pixelate';
export type OutputFormat = 'mp4' | 'webm' | 'mov' | 'mp3' | 'gif';
export type OutputResolution = 'original' | '1080p' | '720p' | '480p';

export interface WatermarkRegion {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  mode: RemovalMode;
}

export interface SampleClip {
  id: string;
  filename: string;
  title: string;
  subtitle: string;
  thumbnail: string;
  width: number;
  height: number;
  duration: number;
  defaultRegion: {
    x: number;
    y: number;
    w: number;
    h: number;
    mode: RemovalMode;
  };
}

export interface LoadedVideo {
  sourceType: 'sample' | 'upload';
  sourceId: string;
  title: string;
  previewUrl: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
  sizeBytes?: number;
}

export interface ProcessResult {
  outputId: string;
  previewUrl: string;
  downloadUrl: string;
  sizeBytes: number;
  durationMs: number;
  regionsProcessed: number;
  outputFormat: OutputFormat;
  processedAt?: number;
}

export interface FormatOption {
  id: string;
  label: string;
  container: string;
  codec: string;
  estimatedSize: string;
  type: 'video' | 'audio';
}

export interface InspectedLink {
  platform: string;
  videoId?: string;
  canonicalUrl: string;
  title: string;
  author: string;
  thumbnail: string;
  aspect: string;
  directMediaSupported: boolean;
  formats: FormatOption[];
}

export type BatchClipStatus = 'queued' | 'processing' | 'done' | 'error' | 'cancelled';

export interface BatchClipItem {
  id: string;
  video: LoadedVideo;
  regions: WatermarkRegion[];
  cropMarginPercent: number;
  trimStart: number;
  trimEnd: number;
  outputFormat: OutputFormat;
  resolution: OutputResolution;
  status: BatchClipStatus;
  progress: number;
  stage?: string;
  speed?: string;
  processedSeconds?: number;
  totalSeconds?: number;
  jobId?: string;
  result?: ProcessResult;
  error?: string;
}

export type ClipOutputFormat = 'mp4' | 'webm' | 'mov' | 'mp3';

export interface ClipSegmentResult {
  outputId: string;
  filename: string;
  previewUrl: string;
  downloadUrl: string;
  sizeBytes: number;
  durationMs: number;
  durationSec: number;
  outputFormat: ClipOutputFormat;
  processedAt?: number;
}

export interface HighlightMoment {
  title: string;
  start: number;
  end: number;
  reason: string;
  score: number;
}

export interface ClipSegmentItem {
  id: string;
  label: string;
  start: number;
  end: number;
  status: BatchClipStatus;
  reason?: string;
  score?: number;
  isAiHighlight?: boolean;
  result?: ClipSegmentResult;
  error?: string;
}

export interface StudioSettings {
  autoCleanup: boolean;
  cleanupAfterHours: number;
  lastCleanupAt?: number;
  lastCleanupDeletedCount?: number;
}

export interface StoredProcessedClip {
  id: string;
  outputId: string;
  title: string;
  filename: string;
  tool: 'studio' | 'clipper';
  outputFormat: string;
  sizeBytes: number;
  previewUrl: string;
  downloadUrl: string;
  createdAt: number;
  cachedInBrowser: boolean;
}
