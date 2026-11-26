import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Clapperboard,
  Download,
  Eraser,
  FastForward,
  Film,
  Loader2,
  Pause,
  Play,
  Plus,
  Rewind,
  Scissors,
  SplitSquareHorizontal,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  ClipOutputFormat,
  ClipSegmentItem,
  HighlightMoment,
  LoadedVideo,
  OutputResolution,
  SampleClip,
} from '../types/media';
import { CLIPS_PRUNED_EVENT, saveProcessedClip } from '../utils/clipStorage';
import { triggerBlobDownload } from '../utils/download';
import { resolveMediaFallback } from '../utils/mediaFallback';
import { parseJsonResponse, uploadVideoFile } from '../utils/upload';

interface VideoClipperProps {
  sourceVideo: LoadedVideo | null;
  availableVideos: LoadedVideo[];
  samples: SampleClip[];
  onSelectSourceVideo: (video: LoadedVideo) => void;
  onSelectSample: (sample: SampleClip) => void;
  onSendClipToStudio: (video: LoadedVideo) => void;
}

type ClipperPanelMode = 'highlights' | 'split';

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00.0';
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const rem = sec % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${rem.toFixed(1).padStart(4, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${rem.toFixed(1).padStart(4, '0')}`;
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const VideoClipper: React.FC<VideoClipperProps> = ({
  sourceVideo,
  availableVideos,
  samples,
  onSelectSourceVideo,
  onSelectSample,
  onSendClipToStudio,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stopBatchRef = useRef(false);
  const segmentPlayEndRef = useRef<number | null>(null);

  const [duration, setDuration] = useState<number>(sourceVideo?.duration || 0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const [segments, setSegments] = useState<ClipSegmentItem[]>([]);
  const [selectedSegId, setSelectedSegId] = useState<string | null>(null);
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  const [panelMode, setPanelMode] = useState<ClipperPanelMode>('highlights');
  const [splitIntervalSec, setSplitIntervalSec] = useState<number>(30);
  const [splitPartsCount, setSplitPartsCount] = useState<number>(4);

  const [fastCopy, setFastCopy] = useState<boolean>(true);
  const [outputFormat, setOutputFormat] = useState<ClipOutputFormat>('mp4');
  const [resolution, setResolution] = useState<OutputResolution>('original');

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [clipError, setClipError] = useState<string | null>(null);
  const [downloadingAll, setDownloadingAll] = useState(false);

  const [highlightCount, setHighlightCount] = useState<'3' | '5' | '8' | 'auto'>('5');
  const [highlightFocus, setHighlightFocus] = useState('');
  const [highlightApplyMode, setHighlightApplyMode] = useState<'replace' | 'append'>('replace');
  const [analyzingHighlights, setAnalyzingHighlights] = useState(false);
  const [highlightError, setHighlightError] = useState<string | null>(null);

  const [sourcePreviewOverride, setSourcePreviewOverride] = useState<string | null>(null);
  const [sourcePreviewError, setSourcePreviewError] = useState<string | null>(null);
  const [exportPreviewOverride, setExportPreviewOverride] = useState<string | null>(null);
  const [exportPreviewError, setExportPreviewError] = useState<string | null>(null);
  const sourceTriedUrlsRef = useRef<Set<string>>(new Set());
  const exportTriedUrlsRef = useRef<Set<string>>(new Set());
  const objectUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      for (const objUrl of objectUrlsRef.current) {
        URL.revokeObjectURL(objUrl);
      }
      objectUrlsRef.current = [];
    };
  }, []);

  const activeSegment = segments.find((s) => s.id === selectedSegId) || segments[0] || null;

  useEffect(() => {
    const dur = sourceVideo?.duration || 0;
    setDuration(dur);
    setCurrentTime(0);
    setIsPlaying(false);
    segmentPlayEndRef.current = null;
    setClipError(null);
    setHighlightError(null);
    setStatusMessage(null);
    setSourcePreviewOverride(null);
    setSourcePreviewError(null);
    sourceTriedUrlsRef.current.clear();

    if (sourceVideo && dur > 0) {
      const defaultEnd = Math.round(Math.min(dur, Math.max(3, dur > 60 ? 30 : dur)) * 10) / 10;
      const initialSeg: ClipSegmentItem = {
        id: `seg_${Date.now()}`,
        label: 'Clip 1',
        start: 0,
        end: defaultEnd,
        status: 'queued',
      };
      setSegments([initialSeg]);
      setSelectedSegId(initialSeg.id);
    } else {
      setSegments([]);
      setSelectedSegId(null);
    }
  }, [sourceVideo?.sourceId, sourceVideo?.sourceType]);

  useEffect(() => {
    const handlePruned = (evt: Event) => {
      const outputIds = (evt as CustomEvent<{ outputIds?: string[] }>).detail?.outputIds;
      if (!outputIds?.length) return;
      const prunedSet = new Set(outputIds);
      setSegments((prev) =>
        prev.map((seg) =>
          seg.status === 'done' && seg.result && prunedSet.has(seg.result.outputId)
            ? { ...seg, status: 'queued', result: undefined }
            : seg
        )
      );
    };
    window.addEventListener(CLIPS_PRUNED_EVENT, handlePruned);
    return () => {
      window.removeEventListener(CLIPS_PRUNED_EVENT, handlePruned);
    };
  }, []);

  useEffect(() => {
    setExportPreviewOverride(null);
    setExportPreviewError(null);
    exportTriedUrlsRef.current.clear();
  }, [activeSegment?.result?.outputId, activeSegment?.result?.previewUrl]);

  const resolvedSourceUrl = sourcePreviewOverride || sourceVideo?.previewUrl || '';
  const resolvedExportUrl = exportPreviewOverride || activeSegment?.result?.previewUrl || '';

  const handleSourceMediaError = async () => {
    if (!sourceVideo || !resolvedSourceUrl) return;
    sourceTriedUrlsRef.current.add(resolvedSourceUrl);
    const fallback = await resolveMediaFallback({
      url: resolvedSourceUrl,
      sourceType: sourceVideo.sourceType,
      sourceId: sourceVideo.sourceId,
      triedUrls: sourceTriedUrlsRef.current,
    });
    if (fallback) {
      if (fallback.isObjectUrl) objectUrlsRef.current.push(fallback.url);
      setSourcePreviewOverride(fallback.url);
      setSourcePreviewError(null);
      return;
    }
    setIsPlaying(false);
    setSourcePreviewError('Video preview stream is unavailable or uses an unsupported codec. You can still analyze or cut clips, or re-upload the video.');
  };

  const handleExportMediaError = async () => {
    const result = activeSegment?.result;
    if (!result || !resolvedExportUrl) return;
    exportTriedUrlsRef.current.add(resolvedExportUrl);
    const fallback = await resolveMediaFallback({
      url: resolvedExportUrl,
      triedUrls: exportTriedUrlsRef.current,
    });
    if (fallback) {
      if (fallback.isObjectUrl) objectUrlsRef.current.push(fallback.url);
      setExportPreviewOverride(fallback.url);
      setExportPreviewError(null);
      return;
    }
    setExportPreviewError('In-browser preview unavailable for this file — click Save above to download.');
  };

  const effectiveDuration = duration > 0 ? duration : sourceVideo?.duration || 0;

  const seekTo = (sec: number) => {
    const clamped = Math.max(0, Math.min(effectiveDuration || sec, sec));
    setCurrentTime(clamped);
    if (videoRef.current) {
      videoRef.current.currentTime = clamped;
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    segmentPlayEndRef.current = null;
    if (video.paused) {
      void video.play();
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  const previewSegment = (seg: ClipSegmentItem) => {
    const video = videoRef.current;
    if (!video) return;
    setSelectedSegId(seg.id);
    if (isPlaying && selectedSegId === seg.id && segmentPlayEndRef.current !== null) {
      video.pause();
      setIsPlaying(false);
      segmentPlayEndRef.current = null;
      return;
    }
    segmentPlayEndRef.current = seg.end;
    video.currentTime = seg.start;
    setCurrentTime(seg.start);
    void video.play();
    setIsPlaying(true);
  };

  const handleUploadLongVideo = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    setClipError(null);
    try {
      const data = await uploadVideoFile(file);
      const loaded: LoadedVideo = {
        sourceType: 'upload',
        sourceId: data.fileId,
        title: data.filename,
        previewUrl: data.previewUrl,
        width: data.width,
        height: data.height,
        duration: data.duration,
        fps: data.fps,
        hasAudio: data.hasAudio,
        sizeBytes: data.sizeBytes,
      };
      onSelectSourceVideo(loaded);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Could not upload video.');
    } finally {
      setUploading(false);
    }
  };

  const addSegmentAtPlayhead = () => {
    if (!effectiveDuration || segments.length >= 30) return;
    const start = Math.round(Math.min(Math.max(0, currentTime), Math.max(0, effectiveDuration - 0.5)) * 10) / 10;
    const span = effectiveDuration > 120 ? 30 : Math.min(10, effectiveDuration - start);
    const end = Math.round(Math.min(effectiveDuration, Math.max(start + 1, start + span)) * 10) / 10;
    const nextIdx = segments.length + 1;
    const newSeg: ClipSegmentItem = {
      id: `seg_${Date.now()}_${nextIdx}`,
      label: `Clip ${nextIdx}`,
      start,
      end,
      status: 'queued',
    };
    setSegments((prev) => [...prev, newSeg]);
    setSelectedSegId(newSeg.id);
    setStatusMessage(null);
  };

  const setInAtPlayhead = () => {
    if (!activeSegment) {
      addSegmentAtPlayhead();
      return;
    }
    const nextStart = Math.round(Math.min(currentTime, activeSegment.end - 0.5) * 10) / 10;
    setSegments((prev) =>
      prev.map((seg) =>
        seg.id === activeSegment.id
          ? { ...seg, start: Math.max(0, nextStart), status: 'queued', result: undefined, error: undefined }
          : seg
      )
    );
  };

  const setOutAtPlayhead = () => {
    if (!activeSegment) {
      addSegmentAtPlayhead();
      return;
    }
    const nextEnd = Math.round(Math.max(currentTime, activeSegment.start + 0.5) * 10) / 10;
    setSegments((prev) =>
      prev.map((seg) =>
        seg.id === activeSegment.id
          ? { ...seg, end: Math.min(effectiveDuration || nextEnd, nextEnd), status: 'queued', result: undefined, error: undefined }
          : seg
      )
    );
  };

  const handleSplitByInterval = (secondsInput?: number) => {
    const interval = Math.max(1, secondsInput ?? splitIntervalSec);
    if (!effectiveDuration) return;

    const rawCount = Math.ceil(effectiveDuration / interval);
    if (rawCount > 30) {
      setClipError(`Interval of ${interval}s produces ${rawCount} clips (max 30 per batch). Choose a longer interval.`);
      return;
    }
    setClipError(null);

    const generated: ClipSegmentItem[] = [];
    for (let i = 0; i < rawCount; i++) {
      const start = Math.round(i * interval * 10) / 10;
      const end = Math.round(Math.min(effectiveDuration, (i + 1) * interval) * 10) / 10;
      if (end - start < 0.2) continue;
      generated.push({
        id: `seg_${Date.now()}_${i}`,
        label: `Part ${i + 1}`,
        start,
        end,
        status: 'queued',
      });
    }
    setSegments(generated);
    setSelectedSegId(generated[0]?.id || null);
    setStatusMessage(`Created ${generated.length} clip segments (${interval}s each).`);
  };

  const handleSplitIntoParts = () => {
    if (!effectiveDuration) return;
    const count = Math.max(2, Math.min(30, Math.round(splitPartsCount)));
    const step = effectiveDuration / count;
    if (step < 0.3) {
      setClipError('Video is too short to split into that many parts.');
      return;
    }
    setClipError(null);

    const generated: ClipSegmentItem[] = [];
    for (let i = 0; i < count; i++) {
      const start = Math.round(i * step * 10) / 10;
      const end = i === count - 1 ? Math.round(effectiveDuration * 10) / 10 : Math.round((i + 1) * step * 10) / 10;
      generated.push({
        id: `seg_${Date.now()}_${i}`,
        label: `Part ${i + 1} of ${count}`,
        start,
        end,
        status: 'queued',
      });
    }
    setSegments(generated);
    setSelectedSegId(generated[0]?.id || null);
    setStatusMessage(`Split video evenly into ${generated.length} parts.`);
  };

  const handleFindBestMoments = async () => {
    if (!sourceVideo || analyzingHighlights || batchRunning) return;

    setAnalyzingHighlights(true);
    setHighlightError(null);
    setClipError(null);
    setStatusMessage(null);

    try {
      const res = await fetch('/api/analyze-highlights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceType: sourceVideo.sourceType,
          sourceId: sourceVideo.sourceId,
          maxMoments: highlightCount === 'auto' ? 'auto' : Number(highlightCount),
          focusPrompt: highlightFocus.trim(),
        }),
      });
      const data = await parseJsonResponse<{ moments: HighlightMoment[]; duration: number }>(res);
      const moments = Array.isArray(data.moments) ? data.moments : [];

      if (moments.length === 0) {
        throw new Error('No highlight moments were detected in this video.');
      }

      const mapped: ClipSegmentItem[] = moments.map((m, idx) => ({
        id: `seg_${Date.now()}_${idx}`,
        label: m.title || `Highlight ${idx + 1}`,
        start: m.start,
        end: m.end,
        status: 'queued',
        reason: m.reason,
        score: m.score,
        isAiHighlight: true,
      }));

      setSegments((prev) => (highlightApplyMode === 'append' ? [...prev, ...mapped].slice(0, 30) : mapped));
      setSelectedSegId(mapped[0].id);
      seekTo(mapped[0].start);
      setStatusMessage(
        `Detected ${mapped.length} best moment${mapped.length === 1 ? '' : 's'} via visual & speech analysis. Preview or fine-tune timestamps below before cutting.`
      );
    } catch (err) {
      setHighlightError(err instanceof Error ? err.message : 'Could not analyze video highlights.');
    } finally {
      setAnalyzingHighlights(false);
    }
  };

  const cutSingleSegmentOnServer = async (seg: ClipSegmentItem) => {
    if (!sourceVideo) throw new Error('No source video selected.');
    const baseName =
      sourceVideo.title.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'clearreel';
    const labelSlug = seg.label.replace(/[^a-zA-Z0-9_-]/g, '_') || 'clip';

    const res = await fetch('/api/clip-segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceType: sourceVideo.sourceType,
        sourceId: sourceVideo.sourceId,
        start: seg.start,
        end: seg.end,
        label: `${baseName}-${labelSlug}`,
        outputFormat,
        resolution,
        fastCopy: outputFormat === 'mp4' ? fastCopy : false,
      }),
    });
    const data = await parseJsonResponse<NonNullable<ClipSegmentItem['result']>>(res);
    const processedAt = Date.now();
    const enriched = { ...data, processedAt };
    void saveProcessedClip({
      outputId: enriched.outputId,
      title: `${sourceVideo.title} (${seg.label})`,
      filename: enriched.filename,
      tool: 'clipper',
      outputFormat: enriched.outputFormat,
      sizeBytes: enriched.sizeBytes,
      previewUrl: enriched.previewUrl,
      downloadUrl: enriched.downloadUrl,
      createdAt: processedAt,
    });
    return enriched;
  };

  const handleCutAll = async () => {
    const pending = segmentsRef.current.filter((s) => s.status !== 'done');
    if (!pending.length || !sourceVideo) return;

    stopBatchRef.current = false;
    setBatchRunning(true);
    setClipError(null);
    setStatusMessage(null);

    let doneCount = 0;
    for (let i = 0; i < pending.length; i++) {
      if (stopBatchRef.current) break;
      const target = pending[i];
      setSelectedSegId(target.id);
      setBatchProgress({ current: i + 1, total: pending.length, label: target.label });

      setSegments((prev) =>
        prev.map((s) => (s.id === target.id ? { ...s, status: 'processing', error: undefined } : s))
      );

      try {
        const result = await cutSingleSegmentOnServer(target);
        doneCount++;
        setSegments((prev) =>
          prev.map((s) => (s.id === target.id ? { ...s, status: 'done', result, error: undefined } : s))
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to cut clip.';
        setSegments((prev) =>
          prev.map((s) => (s.id === target.id ? { ...s, status: 'error', error: msg } : s))
        );
      }
    }

    setBatchRunning(false);
    setBatchProgress(null);
    if (stopBatchRef.current) {
      setStatusMessage(`Stopped after extracting ${doneCount} clip(s).`);
    } else {
      setStatusMessage(`Extracted ${doneCount} of ${pending.length} clip(s) cleanly.`);
    }
  };

  const handleCutSingle = async (seg: ClipSegmentItem) => {
    setClipError(null);
    setSelectedSegId(seg.id);
    setSegments((prev) =>
      prev.map((s) => (s.id === seg.id ? { ...s, status: 'processing', error: undefined } : s))
    );
    try {
      const result = await cutSingleSegmentOnServer(seg);
      setSegments((prev) =>
        prev.map((s) => (s.id === seg.id ? { ...s, status: 'done', result, error: undefined } : s))
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to cut clip.';
      setClipError(msg);
      setSegments((prev) =>
        prev.map((s) => (s.id === seg.id ? { ...s, status: 'error', error: msg } : s))
      );
    }
  };

  const handleSaveAllClips = async () => {
    const finished = segments.filter((s) => s.status === 'done' && s.result);
    if (!finished.length) return;
    setDownloadingAll(true);
    setClipError(null);
    try {
      for (let i = 0; i < finished.length; i++) {
        const item = finished[i];
        if (!item.result) continue;
        await triggerBlobDownload(item.result.downloadUrl, item.result.filename);
        if (i < finished.length - 1) {
          await new Promise((r) => setTimeout(r, 350));
        }
      }
      setStatusMessage(`Saved ${finished.length} clip file(s) to your device.`);
    } catch (err) {
      setClipError(err instanceof Error ? err.message : 'Batch download failed.');
    } finally {
      setDownloadingAll(false);
    }
  };

  const pendingCount = segments.filter((s) => s.status !== 'done').length;
  const completedCount = segments.filter((s) => s.status === 'done' && s.result).length;

  return (
    <div className="space-y-5">
      {/* Compact Dark Source Bar */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void handleUploadLongVideo(file);
        }}
        className={`flex flex-col gap-3 rounded-xl border p-3.5 transition-colors sm:flex-row sm:items-center sm:justify-between sm:px-4 ${
          isDragOver ? 'border-rose-500 bg-rose-950/30' : 'border-slate-800 bg-[#111622]'
        }`}
      >
        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv,.m4v"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUploadLongVideo(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || batchRunning}
            className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-rose-500 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            <span>{uploading ? 'Uploading Video...' : 'Load Video'}</span>
          </button>

          <p className="text-xs text-slate-400">
            <span className="font-semibold text-slate-200">Drop any MP4, MOV, WebM, or MKV up to 500 MB</span>
            <span className="hidden md:inline text-slate-500"> · Detect AI best moments or mark In/Out segments</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {availableVideos.length > 0 && (
            <>
              <span className="mr-1 text-xs font-medium text-slate-500">Loaded:</span>
              {availableVideos.slice(0, 3).map((vid) => {
                const isActive =
                  sourceVideo?.sourceId === vid.sourceId && sourceVideo?.sourceType === vid.sourceType;
                return (
                  <button
                    key={`${vid.sourceType}_${vid.sourceId}`}
                    type="button"
                    onClick={() => onSelectSourceVideo(vid)}
                    className={`max-w-[150px] truncate rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                      isActive
                        ? 'border-rose-500/70 bg-rose-500/15 text-rose-300'
                        : 'border-slate-700 bg-slate-800/70 text-slate-300 hover:bg-slate-800 hover:text-white'
                    }`}
                  >
                    {vid.title}
                  </button>
                );
              })}
            </>
          )}

          {availableVideos.length === 0 && samples.length > 0 && (
            <>
              <span className="mr-1 text-xs font-medium text-slate-500">Samples:</span>
              {samples.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSelectSample(s)}
                  className="rounded-lg border border-slate-700 bg-slate-800/70 px-2.5 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white whitespace-nowrap cursor-pointer"
                >
                  {s.title}
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      {uploadError && (
        <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-950/60 px-4 py-3 text-sm text-rose-200">
          {uploadError}
        </div>
      )}

      {sourceVideo ? (
        <div className="grid gap-6 lg:grid-cols-12 lg:items-start">
          {/* Left: Dark Video Player + Visual Multi-Segment Timeline + Clip Queue */}
          <div className="lg:col-span-8 space-y-5">
            <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#070A10]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-[#111622] px-4 py-2.5 text-xs text-slate-300">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="truncate font-semibold text-white">{sourceVideo.title}</span>
                  <span className="text-slate-600" aria-hidden="true">·</span>
                  <span className="font-mono text-slate-400 tabular-nums">
                    {sourceVideo.width}×{sourceVideo.height}
                  </span>
                  <span className="text-slate-600" aria-hidden="true">·</span>
                  <span className="font-mono text-slate-400 tabular-nums">
                    {formatClock(effectiveDuration)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={setInAtPlayhead}
                    className="rounded-md bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-100 hover:bg-slate-700 whitespace-nowrap cursor-pointer"
                  >
                    Set Start [
                  </button>
                  <button
                    type="button"
                    onClick={setOutAtPlayhead}
                    className="rounded-md bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-100 hover:bg-slate-700 whitespace-nowrap cursor-pointer"
                  >
                    Set End ]
                  </button>
                  <button
                    type="button"
                    onClick={addSegmentAtPlayhead}
                    disabled={segments.length >= 30}
                    className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-40 whitespace-nowrap cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>New Clip</span>
                  </button>
                </div>
              </div>

              <div className="relative flex aspect-video w-full items-center justify-center bg-[#070A10]">
                {sourcePreviewError || !resolvedSourceUrl ? (
                  <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center text-xs text-slate-400">
                    <Film className="h-7 w-7 text-slate-500" />
                    <p className="font-semibold text-slate-200">{sourceVideo.title}</p>
                    <p>{sourcePreviewError || 'No preview stream available.'}</p>
                  </div>
                ) : (
                  <video
                    key={resolvedSourceUrl}
                    ref={videoRef}
                    src={resolvedSourceUrl}
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={(e) => {
                      const realDur = e.currentTarget.duration || sourceVideo.duration || 0;
                      if (realDur > 0) setDuration(realDur);
                    }}
                    onTimeUpdate={(e) => {
                      const t = e.currentTarget.currentTime;
                      setCurrentTime(t);
                      if (segmentPlayEndRef.current !== null && t >= segmentPlayEndRef.current) {
                        e.currentTarget.pause();
                        setIsPlaying(false);
                        segmentPlayEndRef.current = null;
                      }
                    }}
                    onEnded={() => {
                      setIsPlaying(false);
                      segmentPlayEndRef.current = null;
                    }}
                    onError={() => {
                      void handleSourceMediaError();
                    }}
                    onClick={togglePlay}
                    className="max-h-full max-w-full cursor-pointer"
                  />
                )}
              </div>

              {/* Scrubber & Multi-Segment Range Track */}
              <div className="space-y-3 border-t border-slate-800 bg-[#0D121D] px-4 py-3.5">
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-[11px] text-slate-400">
                    <span>Clip Timeline ({segments.length} marked)</span>
                    {activeSegment && (
                      <span className="font-mono tabular-nums text-rose-400">
                        {activeSegment.label} ({formatClock(activeSegment.start)} – {formatClock(activeSegment.end)})
                      </span>
                    )}
                  </div>
                  <div
                    onClick={(e) => {
                      if (!effectiveDuration) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                      seekTo(ratio * effectiveDuration);
                    }}
                    className="relative h-7 w-full cursor-pointer overflow-hidden rounded-md border border-slate-800 bg-[#070A10]"
                    title="Click anywhere on the timeline to jump playhead"
                  >
                    {effectiveDuration > 0 &&
                      segments.map((seg) => {
                        const leftPct = (seg.start / effectiveDuration) * 100;
                        const widthPct = Math.max(1.2, ((seg.end - seg.start) / effectiveDuration) * 100);
                        const isSel = seg.id === activeSegment?.id;
                        return (
                          <button
                            key={seg.id}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedSegId(seg.id);
                              seekTo(seg.start);
                            }}
                            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                            className={`absolute top-1 bottom-1 flex items-center justify-center overflow-hidden rounded-xs px-1 text-[10px] font-semibold transition-colors cursor-pointer ${
                              isSel
                                ? 'bg-rose-600 text-white ring-1 ring-white/80 z-10'
                                : seg.status === 'done'
                                ? 'bg-emerald-600/80 text-white hover:bg-emerald-500'
                                : 'bg-slate-700 text-slate-100 hover:bg-slate-600'
                            }`}
                          >
                            <span className="truncate">{seg.label}</span>
                          </button>
                        );
                      })}

                    {effectiveDuration > 0 && (
                      <div
                        style={{ left: `${Math.min(100, (currentTime / effectiveDuration) * 100)}%` }}
                        className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 bg-white"
                      />
                    )}
                  </div>
                </div>

                {/* Transport Row */}
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={togglePlay}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-600 text-white hover:bg-rose-500 cursor-pointer"
                    aria-label={isPlaying ? 'Pause' : 'Play'}
                  >
                    {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 pl-0.5" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => seekTo(currentTime - 5)}
                    className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-2 py-1.5 font-mono text-xs text-slate-200 hover:bg-slate-700 cursor-pointer"
                    title="Rewind 5 seconds"
                  >
                    <Rewind className="h-3.5 w-3.5" />
                    <span>5s</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => seekTo(currentTime + 5)}
                    className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-2 py-1.5 font-mono text-xs text-slate-200 hover:bg-slate-700 cursor-pointer"
                    title="Forward 5 seconds"
                  >
                    <span>5s</span>
                    <FastForward className="h-3.5 w-3.5" />
                  </button>

                  <span className="font-mono text-xs text-slate-300 tabular-nums">
                    {formatClock(currentTime)}
                  </span>

                  <input
                    type="range"
                    min={0}
                    max={effectiveDuration || 6}
                    step={0.1}
                    value={currentTime}
                    onChange={(e) => seekTo(Number(e.target.value))}
                    aria-label="Seek long video timeline"
                    className="h-1.5 min-w-[120px] flex-1 cursor-pointer accent-rose-500"
                  />

                  <span className="font-mono text-xs text-slate-400 tabular-nums">
                    {formatClock(effectiveDuration)}
                  </span>

                  {activeSegment && (
                    <button
                      type="button"
                      onClick={() => previewSegment(activeSegment)}
                      className="rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 whitespace-nowrap cursor-pointer"
                    >
                      Preview Clip
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Marked Clips Queue & Individual / Batch Export */}
            <div className="rounded-xl border border-slate-800 bg-[#111622]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3.5 sm:px-5">
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Clip Queue ({segments.length} {segments.length === 1 ? 'segment' : 'segments'})
                  </h3>
                  {batchProgress && (
                    <p className="mt-0.5 font-mono text-xs font-medium text-rose-400">
                      Cutting {batchProgress.current}/{batchProgress.total}: {batchProgress.label}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {batchRunning ? (
                    <button
                      type="button"
                      onClick={() => {
                        stopBatchRef.current = true;
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-700 whitespace-nowrap cursor-pointer"
                    >
                      <Square className="h-3 w-3 fill-current" />
                      <span>Stop After Current</span>
                    </button>
                  ) : (
                    pendingCount > 0 && (
                      <button
                        type="button"
                        onClick={() => void handleCutAll()}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500 whitespace-nowrap cursor-pointer"
                      >
                        <Scissors className="h-3.5 w-3.5" />
                        <span>Cut All Clips ({pendingCount})</span>
                      </button>
                    )
                  )}

                  {completedCount > 1 && (
                    <button
                      type="button"
                      disabled={downloadingAll}
                      onClick={() => void handleSaveAllClips()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-3.5 py-2 text-xs font-semibold text-slate-900 hover:bg-white disabled:opacity-50 whitespace-nowrap cursor-pointer"
                    >
                      {downloadingAll ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                      <span>Save All ({completedCount})</span>
                    </button>
                  )}
                </div>
              </div>

              {statusMessage && (
                <div className="border-b border-slate-800 bg-[#0D121D] px-4 py-2 text-xs font-medium text-slate-300 sm:px-5">
                  {statusMessage}
                </div>
              )}

              {clipError && (
                <div role="alert" className="border-b border-rose-500/30 bg-rose-950/50 px-4 py-2.5 text-xs text-rose-200 sm:px-5">
                  {clipError}
                </div>
              )}

              {segments.length === 0 ? (
                <div className="px-5 py-10 text-center text-xs text-slate-400">
                  No clip segments marked yet. Click <strong className="text-slate-200">Find Best Moments</strong> on the right or <strong className="text-slate-200">New Clip</strong> above the player.
                </div>
              ) : (
                <div className="divide-y divide-slate-800">
                  {segments.map((seg, idx) => {
                    const isSelected = seg.id === activeSegment?.id;
                    const isPreviewingThis = isSelected && isPlaying && segmentPlayEndRef.current !== null;
                    const segDur = Math.max(0, seg.end - seg.start);
                    return (
                      <div
                        key={seg.id}
                        onClick={() => {
                          setSelectedSegId(seg.id);
                          seekTo(seg.start);
                        }}
                        className={`flex flex-col gap-3 px-4 py-3 text-xs transition-colors cursor-pointer sm:flex-row sm:items-center sm:justify-between sm:px-5 ${
                          isSelected ? 'bg-rose-500/10' : 'hover:bg-slate-800/35'
                        }`}
                      >
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2.5">
                            <span className="font-mono text-slate-500 tabular-nums w-5 shrink-0">
                              {String(idx + 1).padStart(2, '0')}
                            </span>

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                previewSegment(seg);
                              }}
                              className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors cursor-pointer ${
                                isPreviewingThis
                                  ? 'border-rose-500 bg-rose-600 text-white'
                                  : 'border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700'
                              }`}
                              title={isPreviewingThis ? 'Pause preview' : 'Preview this moment'}
                              aria-label={`${isPreviewingThis ? 'Pause' : 'Preview'} ${seg.label}`}
                            >
                              {isPreviewingThis ? (
                                <Pause className="h-3.5 w-3.5" />
                              ) : (
                                <Play className="h-3.5 w-3.5 pl-0.5" />
                              )}
                            </button>

                            <input
                              type="text"
                              value={seg.label}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => {
                                const nextLabel = e.target.value;
                                setSegments((prev) =>
                                  prev.map((s) => (s.id === seg.id ? { ...s, label: nextLabel } : s))
                                );
                              }}
                              aria-label={`Clip ${idx + 1} label`}
                              className="w-36 sm:w-44 rounded-md border border-slate-700 bg-[#090D16] px-2 py-1 text-xs font-semibold text-white focus:border-rose-500 focus:outline-none"
                            />

                            <div
                              className="flex items-center gap-1.5 font-mono tabular-nums"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="number"
                                min={0}
                                max={Math.max(0, seg.end - 0.2)}
                                step={0.1}
                                value={seg.start}
                                onChange={(e) => {
                                  const val = Math.max(0, Math.min(seg.end - 0.2, Number(e.target.value) || 0));
                                  setSegments((prev) =>
                                    prev.map((s) =>
                                      s.id === seg.id
                                        ? { ...s, start: val, status: 'queued', result: undefined }
                                        : s
                                    )
                                  );
                                }}
                                aria-label="Clip start seconds"
                                className="w-20 rounded-md border border-slate-700 bg-[#090D16] px-2 py-1 text-xs text-slate-100 focus:border-rose-500 focus:outline-none"
                              />
                              <span className="text-slate-500">to</span>
                              <input
                                type="number"
                                min={seg.start + 0.2}
                                max={effectiveDuration || 14400}
                                step={0.1}
                                value={seg.end}
                                onChange={(e) => {
                                  const val = Math.min(
                                    effectiveDuration || 14400,
                                    Math.max(seg.start + 0.2, Number(e.target.value) || seg.start + 1)
                                  );
                                  setSegments((prev) =>
                                    prev.map((s) =>
                                      s.id === seg.id
                                        ? { ...s, end: val, status: 'queued', result: undefined }
                                        : s
                                    )
                                  );
                                }}
                                aria-label="Clip end seconds"
                                className="w-20 rounded-md border border-slate-700 bg-[#090D16] px-2 py-1 text-xs text-slate-100 focus:border-rose-500 focus:outline-none"
                              />
                              <span className="ml-1 text-slate-400">({formatClock(segDur)})</span>
                            </div>
                          </div>

                          {seg.reason && (
                            <p className="pl-14 text-[11px] leading-relaxed text-slate-400">
                              {seg.score !== undefined && (
                                <>
                                  <span className="font-mono font-semibold text-rose-400 tabular-nums">
                                    {seg.score}/100
                                  </span>
                                  <span aria-hidden="true" className="mx-1.5 text-slate-600">·</span>
                                </>
                              )}
                              <span>{seg.reason}</span>
                            </p>
                          )}
                        </div>

                        <div
                          className="flex flex-wrap items-center gap-2 shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {seg.status === 'processing' && (
                            <span className="inline-flex items-center gap-1 font-medium text-rose-400">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              <span>Cutting...</span>
                            </span>
                          )}

                          {seg.status === 'error' && (
                            <span className="font-medium text-rose-400">{seg.error || 'Failed'}</span>
                          )}

                          {seg.status === 'done' && seg.result ? (
                            <>
                              <span className="font-mono text-emerald-400 tabular-nums">
                                {formatBytes(seg.result.sizeBytes)}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  void triggerBlobDownload(seg.result!.downloadUrl, seg.result!.filename)
                                }
                                className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-rose-500 whitespace-nowrap cursor-pointer"
                              >
                                <Download className="h-3 w-3" />
                                <span>Save {seg.result.outputFormat.toUpperCase()}</span>
                              </button>
                              {seg.result.outputFormat !== 'mp3' && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    onSendClipToStudio({
                                      sourceType: 'upload',
                                      sourceId: seg.result!.outputId,
                                      title: seg.result!.filename,
                                      previewUrl: seg.result!.previewUrl,
                                      width: sourceVideo.width,
                                      height: sourceVideo.height,
                                      duration: seg.result!.durationSec,
                                      fps: sourceVideo.fps,
                                      hasAudio: sourceVideo.hasAudio,
                                      sizeBytes: seg.result!.sizeBytes,
                                    })
                                  }
                                  className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-700 whitespace-nowrap cursor-pointer"
                                  title="Open this cut clip in Watermark Studio"
                                >
                                  <Eraser className="h-3 w-3 text-rose-400" />
                                  <span>Remove Watermark</span>
                                </button>
                              )}
                            </>
                          ) : (
                            seg.status !== 'processing' && (
                              <button
                                type="button"
                                disabled={batchRunning}
                                onClick={() => void handleCutSingle(seg)}
                                className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-40 whitespace-nowrap cursor-pointer"
                              >
                                <Scissors className="h-3 w-3 text-rose-400" />
                                <span>Cut Clip</span>
                              </button>
                            )
                          )}

                          <button
                            type="button"
                            disabled={batchRunning && seg.status === 'processing'}
                            onClick={() => {
                              setSegments((prev) => {
                                const next = prev.filter((item) => item.id !== seg.id);
                                if (activeSegment?.id === seg.id) {
                                  setSelectedSegId(next[0]?.id || null);
                                }
                                return next;
                              });
                            }}
                            className="rounded p-1 text-slate-400 hover:bg-rose-950 hover:text-rose-400 disabled:opacity-40 cursor-pointer"
                            aria-label={`Delete ${seg.label}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Preview Player for Completed Segment */}
            {activeSegment?.result && (
              <div className="rounded-xl border border-slate-800 bg-[#111622] p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
                    <div>
                      <h4 className="text-sm font-bold text-white">
                        {activeSegment.result.filename}
                      </h4>
                      <p className="font-mono text-xs text-slate-400 tabular-nums">
                        {formatBytes(activeSegment.result.sizeBytes)} · {formatClock(activeSegment.result.durationSec)} · Cut in {(activeSegment.result.durationMs / 1000).toFixed(2)}s
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void triggerBlobDownload(
                        activeSegment.result!.downloadUrl,
                        activeSegment.result!.filename
                      )
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500 whitespace-nowrap cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Save {activeSegment.result.outputFormat.toUpperCase()}</span>
                  </button>
                </div>

                {activeSegment.result.outputFormat === 'mov' ? (
                  <div className="mt-4 flex items-center gap-3 rounded-lg border border-slate-800 bg-[#0D121D] px-4 py-3 text-xs text-slate-300">
                    <Film className="h-4 w-4 text-slate-400 shrink-0" />
                    <span>
                      Encoded in 10-bit Apple ProRes 422 (MOV) with uncompressed PCM audio—ready for editing timelines.
                    </span>
                  </div>
                ) : exportPreviewError || !resolvedExportUrl ? (
                  <div className="mt-4 flex items-center gap-3 rounded-lg border border-slate-800 bg-[#0D121D] px-4 py-3 text-xs text-slate-300">
                    <Film className="h-4 w-4 text-slate-400 shrink-0" />
                    <span>{exportPreviewError || 'Click Save above to download your cut clip.'}</span>
                  </div>
                ) : (
                  <div className="mt-4 overflow-hidden rounded-lg border border-slate-800 bg-[#070A10]">
                    {activeSegment.result.outputFormat === 'mp3' ? (
                      <div className="bg-[#0D121D] p-4">
                        <audio
                          key={resolvedExportUrl}
                          controls
                          src={resolvedExportUrl}
                          onError={() => {
                            void handleExportMediaError();
                          }}
                          className="w-full"
                        />
                      </div>
                    ) : (
                      <video
                        key={resolvedExportUrl}
                        controls
                        src={resolvedExportUrl}
                        onError={() => {
                          void handleExportMediaError();
                        }}
                        className="mx-auto aspect-video max-h-72 w-full object-contain"
                      />
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: Unified Dark Detection & Export Sidebar */}
          <div className="lg:col-span-4">
            <div className="rounded-xl border border-slate-800 bg-[#111622]">
              {/* Segmented Mode Tabs */}
              <div className="border-b border-slate-800 p-3">
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-[#090D16] p-1">
                  <button
                    type="button"
                    onClick={() => setPanelMode('highlights')}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                      panelMode === 'highlights'
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Clapperboard className="h-3.5 w-3.5 text-rose-400" />
                    <span>Best Moments</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPanelMode('split')}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                      panelMode === 'split'
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <SplitSquareHorizontal className="h-3.5 w-3.5 text-rose-400" />
                    <span>Auto-Split</span>
                  </button>
                </div>
              </div>

              {panelMode === 'highlights' ? (
                <div className="p-5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-white">AI Highlight Finder</h3>
                    <span className="font-mono text-[11px] text-slate-400">5s–45s scenes</span>
                  </div>

                  <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                    Scans visual changes and speech to add top highlights to your Clip Queue for review.
                  </p>

                  <div className="mt-4">
                    <p className="text-xs font-semibold text-slate-300">Moments to detect</p>
                    <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                      {(
                        [
                          { id: '3', label: 'Top 3' },
                          { id: '5', label: 'Top 5' },
                          { id: '8', label: 'Top 8' },
                          { id: 'auto', label: 'Auto' },
                        ] as Array<{ id: '3' | '5' | '8' | 'auto'; label: string }>
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          disabled={analyzingHighlights}
                          onClick={() => setHighlightCount(opt.id)}
                          className={`rounded-md border py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                            highlightCount === opt.id
                              ? 'border-rose-500 bg-rose-600 text-white'
                              : 'border-slate-700 bg-[#090D16] text-slate-300 hover:bg-slate-800 hover:text-white'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-3.5">
                    <label className="block text-xs font-semibold text-slate-300">
                      Focus filter <span className="font-normal text-slate-500">(optional)</span>
                    </label>
                    <input
                      type="text"
                      value={highlightFocus}
                      disabled={analyzingHighlights}
                      onChange={(e) => setHighlightFocus(e.target.value)}
                      placeholder="e.g. key takeaways, action peaks, reactions"
                      className="mt-1.5 w-full rounded-lg border border-slate-700 bg-[#090D16] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-rose-500 focus:outline-none disabled:opacity-50"
                    />
                  </div>

                  {segments.length > 0 && (
                    <div className="mt-3.5 flex items-center justify-between gap-2 text-xs">
                      <span className="font-medium text-slate-400">Queue action</span>
                      <div className="inline-flex rounded-lg border border-slate-700 bg-[#090D16] p-0.5">
                        <button
                          type="button"
                          onClick={() => setHighlightApplyMode('replace')}
                          className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
                            highlightApplyMode === 'replace'
                              ? 'bg-slate-800 text-white'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          Replace
                        </button>
                        <button
                          type="button"
                          onClick={() => setHighlightApplyMode('append')}
                          className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
                            highlightApplyMode === 'append'
                              ? 'bg-slate-800 text-white'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          Append
                        </button>
                      </div>
                    </div>
                  )}

                  {highlightError && (
                    <div
                      role="alert"
                      className="mt-3.5 rounded-lg border border-rose-500/40 bg-rose-950/60 px-3 py-2 text-xs text-rose-200"
                    >
                      {highlightError}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => void handleFindBestMoments()}
                    disabled={analyzingHighlights || batchRunning}
                    className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:border-rose-500/60 hover:bg-rose-600 disabled:opacity-60 cursor-pointer"
                  >
                    {analyzingHighlights ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Analyzing Visuals &amp; Speech...</span>
                      </>
                    ) : (
                      <>
                        <Clapperboard className="h-4 w-4" />
                        <span>Find Best Moments</span>
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <div className="p-5">
                  <h3 className="text-sm font-bold text-white">Auto-Split Long Video</h3>
                  <p className="mt-1 text-xs text-slate-400">
                    Slice recordings into fixed intervals or equal segments.
                  </p>

                  {/* Split by Interval */}
                  <div className="mt-4">
                    <p className="text-xs font-semibold text-slate-300">Split by fixed duration</p>
                    <div className="mt-2 grid grid-cols-4 gap-1.5">
                      {[
                        { sec: 15, label: '15s' },
                        { sec: 30, label: '30s' },
                        { sec: 60, label: '60s' },
                        { sec: 180, label: '3m' },
                      ].map((preset) => (
                        <button
                          key={preset.sec}
                          type="button"
                          onClick={() => {
                            setSplitIntervalSec(preset.sec);
                            handleSplitByInterval(preset.sec);
                          }}
                          className={`rounded-md border py-1.5 font-mono text-xs font-semibold transition-colors cursor-pointer ${
                            splitIntervalSec === preset.sec
                              ? 'border-rose-500 bg-rose-600 text-white'
                              : 'border-slate-700 bg-[#090D16] text-slate-300 hover:bg-slate-800 hover:text-white'
                          }`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>

                    <div className="mt-2.5 flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={3600}
                        value={splitIntervalSec}
                        onChange={(e) => setSplitIntervalSec(Math.max(1, Number(e.target.value) || 30))}
                        aria-label="Custom split interval in seconds"
                        className="w-full rounded-lg border border-slate-700 bg-[#090D16] px-3 py-1.5 font-mono text-xs text-slate-100 focus:border-rose-500 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleSplitByInterval()}
                        className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Split (sec)
                      </button>
                    </div>
                  </div>

                  {/* Split into N Equal Parts */}
                  <div className="mt-4 border-t border-slate-800 pt-4">
                    <p className="text-xs font-semibold text-slate-300">Split into equal parts</p>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="number"
                        min={2}
                        max={30}
                        value={splitPartsCount}
                        onChange={(e) => setSplitPartsCount(Math.max(2, Math.min(30, Number(e.target.value) || 2)))}
                        aria-label="Number of equal parts"
                        className="w-full rounded-lg border border-slate-700 bg-[#090D16] px-3 py-1.5 font-mono text-xs text-slate-100 focus:border-rose-500 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={handleSplitIntoParts}
                        className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Split Parts
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Shared Export Settings & Extract Action */}
              <div className="space-y-4 border-t border-slate-800 p-5">
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={fastCopy}
                    disabled={outputFormat !== 'mp4' || resolution !== 'original'}
                    onChange={(e) => setFastCopy(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded accent-rose-500"
                  />
                  <span className="text-xs">
                    <span className="block font-semibold text-slate-200">
                      Fast Lossless Cut (Stream Copy)
                    </span>
                    <span className="mt-0.5 block text-slate-400">
                      Splits MP4s near-instantly without re-encoding. Uncheck for frame-accurate precision.
                    </span>
                  </span>
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-300">Format</label>
                    <select
                      value={outputFormat}
                      onChange={(e) => setOutputFormat(e.target.value as ClipOutputFormat)}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-[#090D16] px-2.5 py-2 text-xs font-medium text-slate-100 focus:border-rose-500 focus:outline-none"
                    >
                      <option value="mp4">MP4 (H.264)</option>
                      <option value="mov">MOV (ProRes 422)</option>
                      <option value="webm">WebM (VP9)</option>
                      <option value="mp3">MP3 Audio (320k)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300">Resolution</label>
                    <select
                      value={resolution}
                      onChange={(e) => setResolution(e.target.value as OutputResolution)}
                      disabled={outputFormat === 'mp3'}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-[#090D16] px-2.5 py-2 text-xs font-medium text-slate-100 focus:border-rose-500 focus:outline-none disabled:opacity-40"
                    >
                      <option value="original">Original ({sourceVideo.height}p)</option>
                      <option value="1080p">1080p Full HD</option>
                      <option value="720p">720p HD</option>
                      <option value="480p">480p SD</option>
                    </select>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleCutAll()}
                  disabled={batchRunning || pendingCount === 0}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-rose-500 disabled:opacity-60 cursor-pointer"
                >
                  {batchRunning ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>
                        Cutting {batchProgress?.current}/{batchProgress?.total}...
                      </span>
                    </>
                  ) : (
                    <>
                      <Scissors className="h-4 w-4" />
                      <span>Extract {pendingCount || segments.length} Clip(s)</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-700 bg-[#111622] px-6 py-14 text-center">
          <Film className="mx-auto h-8 w-8 text-slate-500" />
          <p className="mt-3 text-sm font-semibold text-slate-200">
            Load a video or select a sample clip above to find best moments and extract clips.
          </p>
        </div>
      )}
    </div>
  );
};
