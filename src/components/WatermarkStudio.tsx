import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Columns2,
  Download,
  Eraser,
  FastForward,
  Film,
  Layers,
  Loader2,
  Pause,
  Play,
  Plus,
  Rewind,
  RotateCcw,
  Scissors,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  BatchClipItem,
  LoadedVideo,
  OutputFormat,
  OutputResolution,
  ProcessResult,
  RemovalMode,
  SampleClip,
  WatermarkRegion,
} from '../types/media';
import { saveProcessedClip } from '../utils/clipStorage';
import { triggerBlobDownload } from '../utils/download';
import { resolveMediaFallback } from '../utils/mediaFallback';
import { parseJsonResponse, uploadVideoFile } from '../utils/upload';
import { BatchExportQueue } from './BatchExportQueue';

interface WatermarkStudioProps {
  samples: SampleClip[];
  queue: BatchClipItem[];
  setQueue: React.Dispatch<React.SetStateAction<BatchClipItem[]>>;
  activeClipId: string | null;
  setActiveClipId: React.Dispatch<React.SetStateAction<string | null>>;
  onSelectSample: (sample: SampleClip) => void;
  onQueueAllSamples: () => void;
  onSendToClipper: (video: LoadedVideo) => void;
}

type DragInteraction =
  | { kind: 'none' }
  | { kind: 'split' }
  | { kind: 'move'; regionId: string; offsetX: number; offsetY: number }
  | { kind: 'resize'; regionId: string }
  | { kind: 'draw'; startX: number; startY: number; regionId: string };

type CornerPreset = 'tl' | 'tr' | 'bl' | 'br' | 'center';

function formatTimecode(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00.0';
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${String(mins).padStart(2, '0')}:${rem.toFixed(1).padStart(4, '0')}`;
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Real-time bilinear border interpolation matching FFmpeg delogo behavior
function applyDelogoToImageData(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  frameW: number,
  frameH: number
) {
  const rx = Math.max(1, Math.min(frameW - 3, Math.round(x)));
  const ry = Math.max(1, Math.min(frameH - 3, Math.round(y)));
  const rw = Math.max(4, Math.min(frameW - rx - 1, Math.round(w)));
  const rh = Math.max(4, Math.min(frameH - ry - 1, Math.round(h)));

  const patch = ctx.getImageData(rx - 1, ry - 1, rw + 2, rh + 2);
  const data = patch.data;
  const stride = (rw + 2) * 4;

  for (let iy = 1; iy <= rh; iy++) {
    const vNorm = iy / (rh + 1);
    const bottomOffset = (rh + 1) * stride;

    for (let ix = 1; ix <= rw; ix++) {
      const uNorm = ix / (rw + 1);

      const leftIdx = iy * stride;
      const rightIdx = iy * stride + (rw + 1) * 4;
      const topPixel = ix * 4;
      const bottomPixel = bottomOffset + ix * 4;

      const wLeft = 1 / Math.max(0.05, uNorm);
      const wRight = 1 / Math.max(0.05, 1 - uNorm);
      const wTop = 1 / Math.max(0.05, vNorm);
      const wBottom = 1 / Math.max(0.05, 1 - vNorm);
      const wSum = wLeft + wRight + wTop + wBottom;

      const dst = iy * stride + ix * 4;
      for (let c = 0; c < 3; c++) {
        data[dst + c] = Math.round(
          (data[leftIdx + c] * wLeft +
            data[rightIdx + c] * wRight +
            data[topPixel + c] * wTop +
            data[bottomPixel + c] * wBottom) /
            wSum
        );
      }
      data[dst + 3] = 255;
    }
  }

  ctx.putImageData(patch, rx - 1, ry - 1);
}

export const WatermarkStudio: React.FC<WatermarkStudioProps> = ({
  samples,
  queue,
  setQueue,
  activeClipId,
  setActiveClipId,
  onSelectSample,
  onQueueAllSamples,
  onSendToClipper,
}) => {
  const activeClip = queue.find((item) => item.id === activeClipId) || queue[0] || null;
  const activeVideo = activeClip?.video || null;
  const regions = activeClip?.regions || [];
  const cropMarginPercent = activeClip?.cropMarginPercent || 0;
  const trimStart = activeClip?.trimStart || 0;
  const trimEnd = activeClip?.trimEnd || activeVideo?.duration || 0;
  const outputFormat: OutputFormat = activeClip?.outputFormat || 'mp4';
  const resolution: OutputResolution = activeClip?.resolution || 'original';
  const processResult = activeClip?.result || null;
  const isActiveClipProcessing = activeClip?.status === 'processing';

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const batchQueueSectionRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const cancelBatchRef = useRef(false);
  const activeCleanupRef = useRef<(() => void) | null>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [splitEnabled, setSplitEnabled] = useState(true);
  const [splitRatio, setSplitRatio] = useState(0.45);
  const [dragState, setDragState] = useState<DragInteraction>({ kind: 'none' });

  const [uploadProgress, setUploadProgress] = useState<{
    current: number;
    total: number;
    percent: number;
  } | null>(null);
  const [processingSingle, setProcessingSingle] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; title: string } | null>(null);
  const [downloadingExport, setDownloadingExport] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const [sourcePreviewOverride, setSourcePreviewOverride] = useState<string | null>(null);
  const [sourcePreviewError, setSourcePreviewError] = useState<string | null>(null);
  const [exportPreviewOverride, setExportPreviewOverride] = useState<string | null>(null);
  const [exportPreviewError, setExportPreviewError] = useState<string | null>(null);
  const sourceTriedUrlsRef = useRef<Set<string>>(new Set());
  const exportTriedUrlsRef = useRef<Set<string>>(new Set());
  const objectUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      activeCleanupRef.current?.();
      for (const objUrl of objectUrlsRef.current) {
        URL.revokeObjectURL(objUrl);
      }
      objectUrlsRef.current = [];
    };
  }, []);

  const updateActiveClip = useCallback(
    (updater: (clip: BatchClipItem) => BatchClipItem) => {
      if (!activeClip || activeClip.status === 'processing') return;
      setQueue((prev) => prev.map((item) => (item.id === activeClip.id ? updater(item) : item)));
    },
    [activeClip, setQueue]
  );

  const updateRegions = useCallback(
    (updater: React.SetStateAction<WatermarkRegion[]>) => {
      updateActiveClip((clip) => {
        const shouldReset = clip.status === 'done' || clip.status === 'error' || clip.status === 'cancelled';
        return {
          ...clip,
          regions: typeof updater === 'function' ? updater(clip.regions) : updater,
          status: shouldReset ? 'queued' : clip.status,
          progress: shouldReset ? 0 : clip.progress,
          stage: shouldReset ? 'Waiting in queue' : clip.stage,
          result: shouldReset ? undefined : clip.result,
          error: shouldReset ? undefined : clip.error,
        };
      });
    },
    [updateActiveClip]
  );

  useEffect(() => {
    setProcessError(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(activeVideo?.duration || 0);
    setSourcePreviewOverride(null);
    setSourcePreviewError(null);
    sourceTriedUrlsRef.current.clear();
    if (regions.length > 0) {
      setSelectedRegionId(regions[0].id);
    } else {
      setSelectedRegionId(null);
    }
  }, [activeClip?.id, activeVideo?.previewUrl]);

  useEffect(() => {
    setExportPreviewOverride(null);
    setExportPreviewError(null);
    exportTriedUrlsRef.current.clear();
  }, [processResult?.outputId, processResult?.previewUrl]);

  const resolvedSourceUrl = sourcePreviewOverride || activeVideo?.previewUrl || '';
  const resolvedExportUrl = exportPreviewOverride || processResult?.previewUrl || '';

  const handleSourceVideoError = async () => {
    if (!activeVideo || !resolvedSourceUrl) return;
    sourceTriedUrlsRef.current.add(resolvedSourceUrl);
    const fallback = await resolveMediaFallback({
      url: resolvedSourceUrl,
      sourceType: activeVideo.sourceType,
      sourceId: activeVideo.sourceId,
      triedUrls: sourceTriedUrlsRef.current,
    });
    if (fallback) {
      if (fallback.isObjectUrl) objectUrlsRef.current.push(fallback.url);
      setSourcePreviewOverride(fallback.url);
      setSourcePreviewError(null);
      return;
    }
    setIsPlaying(false);
    setSourcePreviewError('Video preview stream is unavailable or uses an unsupported codec. You can still process or re-upload the file.');
  };

  const handleExportMediaError = async () => {
    if (!processResult || !resolvedExportUrl) return;
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

  const renderFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !activeVideo) return;
    if (video.readyState < 2) return;

    const w = activeVideo.width || video.videoWidth || 1280;
    const h = activeVideo.height || video.videoHeight || 720;

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    if (!offscreenRef.current) {
      offscreenRef.current = document.createElement('canvas');
    }
    const cleanCanvas = offscreenRef.current;
    if (cleanCanvas.width !== w || cleanCanvas.height !== h) {
      cleanCanvas.width = w;
      cleanCanvas.height = h;
    }
    const cleanCtx = cleanCanvas.getContext('2d', { willReadFrequently: true });
    if (!cleanCtx) return;

    ctx.drawImage(video, 0, 0, w, h);
    cleanCtx.drawImage(video, 0, 0, w, h);

    for (const reg of regions) {
      if (reg.mode === 'delogo') {
        applyDelogoToImageData(cleanCtx, reg.x, reg.y, reg.w, reg.h, w, h);
      } else if (reg.mode === 'blur') {
        cleanCtx.save();
        cleanCtx.beginPath();
        cleanCtx.rect(reg.x, reg.y, reg.w, reg.h);
        cleanCtx.clip();
        cleanCtx.filter = 'blur(14px)';
        cleanCtx.drawImage(video, 0, 0, w, h);
        cleanCtx.restore();
      } else {
        const pxW = Math.max(4, Math.round(reg.w / 10));
        const pxH = Math.max(4, Math.round(reg.h / 10));
        const tiny = document.createElement('canvas');
        tiny.width = pxW;
        tiny.height = pxH;
        const tCtx = tiny.getContext('2d');
        if (tCtx) {
          tCtx.drawImage(video, reg.x, reg.y, reg.w, reg.h, 0, 0, pxW, pxH);
          cleanCtx.save();
          cleanCtx.imageSmoothingEnabled = false;
          cleanCtx.drawImage(tiny, 0, 0, pxW, pxH, reg.x, reg.y, reg.w, reg.h);
          cleanCtx.restore();
        }
      }
    }

    const splitX = splitEnabled ? Math.round(w * splitRatio) : 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, 0, w - splitX, h);
    ctx.clip();
    ctx.drawImage(cleanCanvas, 0, 0, w, h);
    ctx.restore();

    if (cropMarginPercent > 0) {
      const mx = Math.round((w * cropMarginPercent) / 100);
      const my = Math.round((h * cropMarginPercent) / 100);
      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
      ctx.fillRect(0, 0, w, my);
      ctx.fillRect(0, h - my, w, my);
      ctx.fillRect(0, my, mx, h - my * 2);
      ctx.fillRect(w - mx, my, mx, h - my * 2);
      ctx.restore();
    }

    if (splitEnabled) {
      ctx.save();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = Math.max(2, Math.round(w / 450));
      ctx.beginPath();
      ctx.moveTo(splitX, 0);
      ctx.lineTo(splitX, h);
      ctx.stroke();

      const badgeFontSize = Math.max(12, Math.round(w / 72));
      ctx.font = `600 ${badgeFontSize}px "Plus Jakarta Sans", sans-serif`;
      if (splitX > 95) {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
        ctx.fillRect(14, 14, 78, 28);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText('ORIGINAL', 22, 33);
      }
      if (w - splitX > 95) {
        ctx.fillStyle = 'rgba(225, 29, 72, 0.9)';
        ctx.fillRect(w - 94, 14, 80, 28);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText('CLEANED', w - 85, 33);
      }
      ctx.restore();
    }

    for (const reg of regions) {
      const isSelected = reg.id === selectedRegionId;
      ctx.save();
      ctx.strokeStyle = isSelected ? '#F43F5E' : 'rgba(255,255,255,0.85)';
      ctx.lineWidth = Math.max(2, Math.round(w / 500));
      ctx.setLineDash(isSelected ? [] : [6, 4]);
      ctx.strokeRect(reg.x, reg.y, reg.w, reg.h);

      if (isSelected) {
        const handleSize = Math.max(10, Math.round(w / 100));
        ctx.fillStyle = '#E11D48';
        ctx.fillRect(
          reg.x + reg.w - handleSize / 2,
          reg.y + reg.h - handleSize / 2,
          handleSize,
          handleSize
        );
      }
      ctx.restore();
    }
  }, [activeVideo, cropMarginPercent, regions, selectedRegionId, splitEnabled, splitRatio]);

  useEffect(() => {
    renderFrame();
  }, [renderFrame, currentTime]);

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    const step = () => {
      const video = videoRef.current;
      if (video) {
        setCurrentTime(video.currentTime);
        renderFrame();
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, renderFrame]);

  const seekBy = (deltaSec: number) => {
    const video = videoRef.current;
    if (!video) return;
    const next = Math.max(0, Math.min(duration || 6, video.currentTime + deltaSec));
    video.currentTime = next;
    setCurrentTime(next);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  const getVideoCoords = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: Math.max(0, Math.min(canvas.width, (clientX - rect.left) * scaleX)),
      y: Math.max(0, Math.min(canvas.height, (clientY - rect.top) * scaleY)),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!activeVideo || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const { x, y } = getVideoCoords(e.clientX, e.clientY);
    canvas.setPointerCapture(e.pointerId);

    if (splitEnabled) {
      const splitX = canvas.width * splitRatio;
      if (Math.abs(x - splitX) < Math.max(16, canvas.width * 0.02)) {
        setDragState({ kind: 'split' });
        return;
      }
    }

    const hitTol = Math.max(16, canvas.width * 0.02);
    for (let i = regions.length - 1; i >= 0; i--) {
      const reg = regions[i];
      if (
        Math.abs(x - (reg.x + reg.w)) <= hitTol &&
        Math.abs(y - (reg.y + reg.h)) <= hitTol
      ) {
        setSelectedRegionId(reg.id);
        setDragState({ kind: 'resize', regionId: reg.id });
        return;
      }
    }

    for (let i = regions.length - 1; i >= 0; i--) {
      const reg = regions[i];
      if (x >= reg.x && x <= reg.x + reg.w && y >= reg.y && y <= reg.y + reg.h) {
        setSelectedRegionId(reg.id);
        setDragState({
          kind: 'move',
          regionId: reg.id,
          offsetX: x - reg.x,
          offsetY: y - reg.y,
        });
        return;
      }
    }

    if (regions.length < 6) {
      const newId = `reg_${Date.now()}`;
      const newRegion: WatermarkRegion = {
        id: newId,
        x: Math.round(x),
        y: Math.round(y),
        w: 16,
        h: 16,
        mode: 'delogo',
      };
      updateRegions((prev) => [...prev, newRegion]);
      setSelectedRegionId(newId);
      setDragState({ kind: 'draw', startX: x, startY: y, regionId: newId });
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragState.kind === 'none' || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const { x, y } = getVideoCoords(e.clientX, e.clientY);

    if (dragState.kind === 'split') {
      setSplitRatio(Math.max(0.05, Math.min(0.95, x / canvas.width)));
      return;
    }

    if (dragState.kind === 'move') {
      updateRegions((prev) =>
        prev.map((r) => {
          if (r.id !== dragState.regionId) return r;
          const nx = Math.max(2, Math.min(canvas.width - r.w - 2, Math.round(x - dragState.offsetX)));
          const ny = Math.max(2, Math.min(canvas.height - r.h - 2, Math.round(y - dragState.offsetY)));
          return { ...r, x: nx, y: ny };
        })
      );
      return;
    }

    if (dragState.kind === 'resize') {
      updateRegions((prev) =>
        prev.map((r) => {
          if (r.id !== dragState.regionId) return r;
          const nw = Math.max(24, Math.min(canvas.width - r.x - 2, Math.round(x - r.x)));
          const nh = Math.max(20, Math.min(canvas.height - r.y - 2, Math.round(y - r.y)));
          return { ...r, w: nw, h: nh };
        })
      );
      return;
    }

    if (dragState.kind === 'draw') {
      const rx = Math.max(2, Math.round(Math.min(dragState.startX, x)));
      const ry = Math.max(2, Math.round(Math.min(dragState.startY, y)));
      const rw = Math.max(24, Math.min(canvas.width - rx - 2, Math.round(Math.abs(x - dragState.startX))));
      const rh = Math.max(20, Math.min(canvas.height - ry - 2, Math.round(Math.abs(y - dragState.startY))));
      updateRegions((prev) =>
        prev.map((r) => (r.id === dragState.regionId ? { ...r, x: rx, y: ry, w: rw, h: rh } : r))
      );
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragState.kind !== 'none' && canvasRef.current) {
      try {
        canvasRef.current.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore if capture wasn't active
      }
      setDragState({ kind: 'none' });
    }
  };

  const addCornerMask = (corner: CornerPreset) => {
    if (!activeVideo || regions.length >= 6) return;
    const vidW = activeVideo.width || 1280;
    const vidH = activeVideo.height || 720;
    const w = Math.round(vidW * 0.22);
    const h = Math.round(vidH * 0.1);
    const padX = Math.round(vidW * 0.03);
    const padY = Math.round(vidH * 0.04);

    let x = Math.round((vidW - w) / 2);
    let y = Math.round(vidH - h - padY);

    if (corner === 'tl') {
      x = padX;
      y = padY;
    } else if (corner === 'tr') {
      x = Math.max(2, vidW - w - padX);
      y = padY;
    } else if (corner === 'bl') {
      x = padX;
      y = Math.max(2, vidH - h - padY);
    } else if (corner === 'br') {
      x = Math.max(2, vidW - w - padX);
      y = Math.max(2, vidH - h - padY);
    } else if (corner === 'center') {
      x = Math.round((vidW - w) / 2);
      y = Math.round((vidH - h) / 2);
    }

    const newId = `reg_${Date.now()}`;
    const newRegion: WatermarkRegion = {
      id: newId,
      x,
      y,
      w,
      h,
      mode: 'delogo',
    };
    updateRegions((prev) => [...prev, newRegion]);
    setSelectedRegionId(newId);
  };

  const uploadFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).slice(0, 10);
    if (!files.length) return;

    setUploadError(null);
    setBatchNotice(null);
    let firstAddedId: string | null = null;
    const errors: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setUploadProgress({ current: i + 1, total: files.length, percent: 0 });

      try {
        const data = await uploadVideoFile(file, (percent) => {
          setUploadProgress({ current: i + 1, total: files.length, percent });
        });

        const clipId = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        if (!firstAddedId) firstAddedId = clipId;

        const newItem: BatchClipItem = {
          id: clipId,
          video: {
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
          },
          regions: [
            {
              id: `reg_${clipId}`,
              x: Math.round(data.width * 0.72),
              y: Math.round(data.height * 0.82),
              w: Math.round(data.width * 0.22),
              h: Math.round(data.height * 0.1),
              mode: 'delogo',
            },
          ],
          cropMarginPercent: 0,
          trimStart: 0,
          trimEnd: Math.round((data.duration || 0) * 10) / 10,
          outputFormat: 'mp4',
          resolution: 'original',
          status: 'queued',
          progress: 0,
          stage: 'Waiting in queue',
        };

        setQueue((prev) => [...prev, newItem]);
      } catch (err) {
        errors.push(`${file.name}: ${err instanceof Error ? err.message : 'upload failed'}`);
      }
    }

    setUploadProgress(null);
    if (firstAddedId) {
      setActiveClipId(firstAddedId);
    }
    if (errors.length > 0) {
      setUploadError(errors.join(' · '));
    }
  };

  interface JobSnapshot {
    jobId: string;
    status: 'queued' | 'processing' | 'done' | 'error' | 'cancelled';
    progress: number;
    stage: string;
    speed?: string;
    processedSeconds: number;
    totalSeconds: number;
    result?: ProcessResult;
    error?: string;
  }

  const runClipJobWithProgress = (
    clip: BatchClipItem
  ): Promise<{ status: 'done' | 'error' | 'cancelled'; result?: ProcessResult; error?: string }> => {
    return new Promise((resolve) => {
      let settled = false;
      let eventSource: EventSource | null = null;
      let pollTimer: number | null = null;

      const cleanup = () => {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        if (pollTimer !== null) {
          window.clearInterval(pollTimer);
          pollTimer = null;
        }
        if (activeCleanupRef.current === cleanup) {
          activeCleanupRef.current = null;
        }
      };

      activeCleanupRef.current = cleanup;

      const applySnapshot = (snap: JobSnapshot) => {
        if (settled) return;

        const completedAt = snap.status === 'done' ? Date.now() : undefined;
        const enrichedResult =
          snap.result && completedAt
            ? { ...snap.result, processedAt: snap.result.processedAt ?? completedAt }
            : snap.result;

        setQueue((prev) =>
          prev.map((item) => {
            if (item.id !== clip.id) return item;
            return {
              ...item,
              jobId: snap.jobId,
              status: snap.status,
              progress: snap.status === 'done' ? 100 : snap.progress,
              stage: snap.stage,
              speed: snap.speed,
              processedSeconds: snap.processedSeconds,
              totalSeconds: snap.totalSeconds,
              result: enrichedResult ?? item.result,
              error: snap.error,
            };
          })
        );

        if (snap.status === 'done') {
          settled = true;
          cleanup();
          if (enrichedResult) {
            const baseName = clip.video.title.replace(/\.[^/.]+$/, '') || 'clearreel_clean';
            void saveProcessedClip({
              outputId: enrichedResult.outputId,
              title: clip.video.title,
              filename: `${baseName}_clean.${enrichedResult.outputFormat}`,
              tool: 'studio',
              outputFormat: enrichedResult.outputFormat,
              sizeBytes: enrichedResult.sizeBytes,
              previewUrl: enrichedResult.previewUrl,
              downloadUrl: enrichedResult.downloadUrl,
              createdAt: completedAt || Date.now(),
            });
          }
          resolve({ status: 'done', result: enrichedResult });
        } else if (snap.status === 'error') {
          settled = true;
          cleanup();
          resolve({ status: 'error', error: snap.error || 'Processing failed.' });
        } else if (snap.status === 'cancelled') {
          settled = true;
          cleanup();
          resolve({ status: 'cancelled' });
        }
      };

      setQueue((prev) =>
        prev.map((item) =>
          item.id === clip.id
            ? {
                ...item,
                status: 'processing',
                progress: 1,
                stage: 'Preparing media',
                speed: undefined,
                error: undefined,
                result: undefined,
              }
            : item
        )
      );

      fetch('/api/process-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceType: clip.video.sourceType,
          sourceId: clip.video.sourceId,
          regions: clip.regions.map(({ x, y, w, h, mode }) => ({ x, y, w, h, mode })),
          cropMarginPercent: clip.cropMarginPercent,
          trimStart: clip.trimStart,
          trimEnd: clip.trimEnd,
          outputFormat: clip.outputFormat,
          resolution: clip.resolution,
        }),
      })
        .then(async (res) => {
          const initial = await parseJsonResponse<JobSnapshot>(res);
          applySnapshot(initial);
          if (settled) return;

          const startPolling = () => {
            if (pollTimer !== null || settled) return;
            pollTimer = window.setInterval(async () => {
              if (settled) return;
              try {
                const pollRes = await fetch(`/api/process-jobs/${initial.jobId}`);
                if (!pollRes.ok) return;
                const pollData = await parseJsonResponse<JobSnapshot>(pollRes);
                applySnapshot(pollData);
              } catch {
                // Keep polling until job finishes or fails
              }
            }, 900);
          };

          if (typeof EventSource !== 'undefined') {
            eventSource = new EventSource(`/api/process-jobs/${initial.jobId}/stream`);
            eventSource.addEventListener('progress', (evt) => {
              try {
                const snap = JSON.parse((evt as MessageEvent).data) as JobSnapshot;
                applySnapshot(snap);
              } catch {
                // Ignore malformed event payload
              }
            });
            eventSource.onerror = () => {
              if (eventSource) {
                eventSource.close();
                eventSource = null;
              }
              startPolling();
            };
          } else {
            startPolling();
          }
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : 'Processing failed.';
          settled = true;
          cleanup();
          setQueue((prev) =>
            prev.map((item) =>
              item.id === clip.id
                ? { ...item, status: 'error', stage: 'Failed', error: msg }
                : item
            )
          );
          resolve({ status: 'error', error: msg });
        });
    });
  };

  const handleProcessSingleClip = async (targetClip: BatchClipItem) => {
    if (processingSingle || batchRunning) return;
    setActiveClipId(targetClip.id);
    setProcessingSingle(true);
    setProcessError(null);
    setBatchNotice(null);

    const outcome = await runClipJobWithProgress(targetClip);
    if (outcome.status === 'error' && outcome.error) {
      setProcessError(outcome.error);
    }
    setProcessingSingle(false);
  };

  const handleProcessActiveClip = async () => {
    if (!activeClip) return;
    await handleProcessSingleClip(activeClip);
  };

  const handleProcessBatch = async () => {
    const pendingIds = queueRef.current
      .filter((item) => item.status === 'queued' || item.status === 'error' || item.status === 'cancelled')
      .map((item) => item.id);

    if (pendingIds.length === 0) return;

    cancelBatchRef.current = false;
    setBatchRunning(true);
    setProcessError(null);
    setBatchNotice(null);

    let completedCount = 0;
    let cancelledCount = 0;
    let errorCount = 0;

    for (let i = 0; i < pendingIds.length; i++) {
      if (cancelBatchRef.current) break;

      const targetId = pendingIds[i];
      const clip = queueRef.current.find((item) => item.id === targetId);
      if (!clip) continue;

      setActiveClipId(targetId);
      setBatchProgress({ current: i + 1, total: pendingIds.length, title: clip.video.title });

      const outcome = await runClipJobWithProgress(clip);
      if (outcome.status === 'done') {
        completedCount++;
      } else if (outcome.status === 'cancelled') {
        cancelledCount++;
      } else {
        errorCount++;
      }
    }

    setBatchRunning(false);
    setBatchProgress(null);
    if (cancelBatchRef.current) {
      setBatchNotice(
        `Batch stopped: ${completedCount} completed${cancelledCount ? `, ${cancelledCount} cancelled` : ''}.`
      );
    } else if (errorCount > 0 || cancelledCount > 0) {
      setBatchNotice(
        `Batch finished: ${completedCount} of ${pendingIds.length} exported (${errorCount} failed${cancelledCount ? `, ${cancelledCount} cancelled` : ''}).`
      );
    } else {
      setBatchNotice(`Batch complete: ${completedCount} of ${pendingIds.length} clip(s) exported cleanly.`);
    }
  };

  const handleCancelActiveJob = async (clip: BatchClipItem) => {
    if (!clip.jobId) return;
    try {
      await fetch(`/api/process-jobs/${clip.jobId}/cancel`, { method: 'POST' });
    } catch {
      // Ignore cancel network errors
    }
  };

  const handleDuplicateClip = (clip: BatchClipItem) => {
    const dupId = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const copy: BatchClipItem = {
      ...clip,
      id: dupId,
      regions: clip.regions.map((r, idx) => ({ ...r, id: `reg_${dupId}_${idx}` })),
      status: 'queued',
      progress: 0,
      stage: 'Waiting in queue',
      speed: undefined,
      processedSeconds: undefined,
      totalSeconds: undefined,
      jobId: undefined,
      result: undefined,
      error: undefined,
    };
    setQueue((prev) => {
      const idx = prev.findIndex((item) => item.id === clip.id);
      if (idx === -1) return [...prev, copy];
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
    setActiveClipId(dupId);
    setBatchNotice(`Stacked a duplicate removal task for ${clip.video.title}.`);
  };

  const handleMoveClip = (clipId: string, direction: 'up' | 'down') => {
    setQueue((prev) => {
      const idx = prev.findIndex((item) => item.id === clipId);
      if (idx === -1) return prev;
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(idx, 1);
      next.splice(targetIdx, 0, moved);
      return next;
    });
  };

  const handleRemoveClip = (clipId: string) => {
    setQueue((prev) => {
      const next = prev.filter((q) => q.id !== clipId);
      if (activeClip?.id === clipId) {
        setActiveClipId(next[0]?.id || null);
      }
      return next;
    });
  };

  const handleClearCompleted = () => {
    setQueue((prev) => {
      const remaining = prev.filter((item) => item.status !== 'done');
      if (activeClip && activeClip.status === 'done') {
        setActiveClipId(remaining[0]?.id || null);
      }
      return remaining;
    });
    setBatchNotice(null);
  };

  const handleApplyMasksToAll = () => {
    if (!activeClip || queue.length < 2) return;
    const srcW = activeClip.video.width || 1280;
    const srcH = activeClip.video.height || 720;

    setQueue((prev) =>
      prev.map((item) => {
        if (item.id === activeClip.id || item.status === 'processing') return item;
        const dstW = item.video.width || srcW;
        const dstH = item.video.height || srcH;
        const scaleX = dstW / srcW;
        const scaleY = dstH / srcH;

        const clonedRegions: WatermarkRegion[] = activeClip.regions.map((r, idx) => ({
          id: `reg_${item.id}_${idx}_${Date.now()}`,
          x: Math.max(2, Math.min(dstW - 16, Math.round(r.x * scaleX))),
          y: Math.max(2, Math.min(dstH - 16, Math.round(r.y * scaleY))),
          w: Math.max(8, Math.min(dstW - 4, Math.round(r.w * scaleX))),
          h: Math.max(8, Math.min(dstH - 4, Math.round(r.h * scaleY))),
          mode: r.mode,
        }));

        return {
          ...item,
          regions: clonedRegions,
          cropMarginPercent: activeClip.cropMarginPercent,
          status: 'queued',
          progress: 0,
          stage: 'Waiting in queue',
          speed: undefined,
          result: undefined,
          error: undefined,
        };
      })
    );
    setBatchNotice(`Applied ${activeClip.regions.length} mask(s) across all queued clips.`);
  };

  const handleDownloadClipResult = async (clip: BatchClipItem) => {
    if (!clip.result) return;
    setDownloadingExport(true);
    setProcessError(null);
    try {
      const safeBase = clip.video.title.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'clearreel';
      await triggerBlobDownload(
        clip.result.downloadUrl,
        `${safeBase}-clean.${clip.result.outputFormat}`
      );
    } catch (err) {
      setProcessError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setDownloadingExport(false);
    }
  };

  const handleDownloadAllCompleted = async () => {
    const doneClips = queue.filter((item) => item.status === 'done' && item.result);
    if (!doneClips.length) return;

    setDownloadingAll(true);
    setProcessError(null);
    try {
      for (let i = 0; i < doneClips.length; i++) {
        const clip = doneClips[i];
        if (!clip.result) continue;
        const safeBase = clip.video.title.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_') || `clip-${i + 1}`;
        await triggerBlobDownload(
          clip.result.downloadUrl,
          `${safeBase}-clean.${clip.result.outputFormat}`
        );
        if (i < doneClips.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      }
      setBatchNotice(`Saved ${doneClips.length} clean exported file(s).`);
    } catch (err) {
      setProcessError(err instanceof Error ? err.message : 'Could not download all batch files.');
    } finally {
      setDownloadingAll(false);
    }
  };

  const readyInQueueCount = queue.filter((q) => q.status === 'done').length;

  return (
    <div className="space-y-5">
      {/* Compact Dark Source Bar & Multi-Clip Quick Switcher */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          if (e.dataTransfer.files?.length) {
            void uploadFiles(e.dataTransfer.files);
          }
        }}
        className={`rounded-xl border transition-colors ${
          isDragOver ? 'border-rose-500 bg-rose-950/30' : 'border-slate-800 bg-[#111622]'
        }`}
      >
        <div className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <div className="flex items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv,.m4v"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) {
                  void uploadFiles(e.target.files);
                }
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadProgress !== null || batchRunning}
              className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-rose-500 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {uploadProgress ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              <span>
                {uploadProgress
                  ? `Uploading ${uploadProgress.current}/${uploadProgress.total} (${uploadProgress.percent}%)`
                  : 'Upload Videos'}
              </span>
            </button>

            <p className="text-xs text-slate-400">
              <span className="font-semibold text-slate-200">Drop 1–10 clips</span> (MP4, MOV, WebM, MKV up to 500 MB)
              <span className="hidden md:inline text-slate-500"> · Drag on video or snap a corner preset</span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-medium text-slate-500">Samples:</span>
            {samples.map((sample) => {
              const isActive =
                activeVideo?.sourceType === 'sample' &&
                activeVideo.sourceId === sample.filename;
              return (
                <button
                  key={sample.id}
                  type="button"
                  onClick={() => onSelectSample(sample)}
                  className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                    isActive
                      ? 'border-rose-500/70 bg-rose-500/15 text-rose-300'
                      : 'border-slate-700 bg-slate-800/70 text-slate-300 hover:border-slate-600 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  {sample.title}
                </button>
              );
            })}
            {samples.length > 1 && (
              <button
                type="button"
                onClick={onQueueAllSamples}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/70 px-2.5 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 hover:text-white whitespace-nowrap cursor-pointer"
              >
                <Layers className="h-3.5 w-3.5 text-rose-400" />
                <span>Queue All</span>
              </button>
            )}
          </div>
        </div>

        {/* Inline Active Clip Switcher when >= 2 clips are stacked */}
        {queue.length > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 bg-[#0D121D] px-4 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 font-medium text-slate-400">Stacked ({queue.length}):</span>
              {queue.map((clip, i) => {
                const isCur = clip.id === activeClip?.id;
                return (
                  <button
                    key={clip.id}
                    type="button"
                    onClick={() => setActiveClipId(clip.id)}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                      isCur
                        ? 'border-rose-500 bg-rose-600 text-white'
                        : 'border-slate-700 bg-slate-800/80 text-slate-300 hover:bg-slate-800 hover:text-white'
                    }`}
                  >
                    <span className="font-mono opacity-75">{i + 1}.</span>
                    <span className="max-w-[130px] truncate">{clip.video.title}</span>
                    {clip.status === 'processing' && (
                      <span className="font-mono text-[11px] text-rose-200">{clip.progress}%</span>
                    )}
                    {clip.status === 'done' && (
                      <CheckCircle2 className={`h-3 w-3 ${isCur ? 'text-white' : 'text-emerald-400'}`} />
                    )}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => batchQueueSectionRef.current?.scrollIntoView({ behavior: 'smooth' })}
              className="font-semibold text-rose-400 hover:text-rose-300 whitespace-nowrap cursor-pointer"
            >
              Batch Queue ({readyInQueueCount}/{queue.length} ready) ↓
            </button>
          </div>
        )}
      </div>

      {uploadError && (
        <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-950/60 px-4 py-3 text-sm text-rose-200">
          {uploadError}
        </div>
      )}

      {/* Main Studio Workspace: Focal Canvas Left + Dark Inspector Right */}
      {activeVideo && activeClip ? (
        <div className="grid gap-6 lg:grid-cols-12 lg:items-start">
          {/* Left: Dark Calibrated Video Canvas & Scrubber */}
          <div className="lg:col-span-8 space-y-5">
            <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#070A10]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-[#111622] px-4 py-2.5 text-xs text-slate-300">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="truncate font-semibold text-white">{activeVideo.title}</span>
                  <span className="text-slate-600" aria-hidden="true">·</span>
                  <span className="font-mono text-slate-400 tabular-nums">
                    {activeVideo.width}×{activeVideo.height}
                  </span>
                  <span className="text-slate-600" aria-hidden="true">·</span>
                  <span className="font-mono text-slate-400 tabular-nums">{activeVideo.fps} fps</span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSplitEnabled((v) => !v)}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                      splitEnabled
                        ? 'bg-rose-600 text-white'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    <Columns2 className="h-3.5 w-3.5" />
                    <span>{splitEnabled ? `Compare ${Math.round(splitRatio * 100)}%` : 'Split Off'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => addCornerMask('br')}
                    disabled={regions.length >= 6}
                    className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-40 whitespace-nowrap cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Add Mask</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onSendToClipper(activeVideo)}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-800 whitespace-nowrap cursor-pointer"
                    title="Open this video in AI Highlight Clipper"
                  >
                    <Scissors className="h-3.5 w-3.5 text-rose-400" />
                    <span>Clip Best Moments</span>
                  </button>
                </div>
              </div>

              {resolvedSourceUrl && !sourcePreviewError && (
                <video
                  key={resolvedSourceUrl}
                  ref={videoRef}
                  src={resolvedSourceUrl}
                  playsInline
                  preload="auto"
                  onLoadedMetadata={(e) => {
                    const vid = e.currentTarget;
                    const realDur = vid.duration || activeVideo.duration;
                    setDuration(realDur);
                    if (!activeClip.trimEnd) {
                      updateActiveClip((clip) => ({
                        ...clip,
                        trimEnd: Math.round(realDur * 10) / 10,
                      }));
                    }
                    renderFrame();
                  }}
                  onLoadedData={() => renderFrame()}
                  onSeeked={() => renderFrame()}
                  onEnded={() => setIsPlaying(false)}
                  onError={() => {
                    void handleSourceVideoError();
                  }}
                  className="hidden"
                />
              )}

              <div className="relative flex aspect-video w-full items-center justify-center bg-[#070A10]">
                {sourcePreviewError ? (
                  <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center text-xs text-slate-400">
                    <Film className="h-7 w-7 text-slate-500" />
                    <p className="font-semibold text-slate-200">{activeVideo.title}</p>
                    <p>{sourcePreviewError}</p>
                  </div>
                ) : (
                  <canvas
                    ref={canvasRef}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    className="max-h-full max-w-full cursor-crosshair touch-none select-none"
                  />
                )}
              </div>

              {/* Transport & Scrubber Bar */}
              <div className="flex flex-wrap items-center gap-2.5 border-t border-slate-800 bg-[#0D121D] px-4 py-3">
                <button
                  type="button"
                  onClick={togglePlay}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-600 text-white transition-colors hover:bg-rose-500 cursor-pointer"
                  aria-label={isPlaying ? 'Pause video' : 'Play video'}
                >
                  {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 pl-0.5" />}
                </button>

                <button
                  type="button"
                  onClick={() => seekBy(-0.5)}
                  className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-2 py-1.5 font-mono text-xs text-slate-200 hover:bg-slate-700 cursor-pointer"
                  title="Step back 0.5 seconds"
                >
                  <Rewind className="h-3 w-3" />
                  <span>0.5s</span>
                </button>

                <button
                  type="button"
                  onClick={() => seekBy(0.5)}
                  className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-2 py-1.5 font-mono text-xs text-slate-200 hover:bg-slate-700 cursor-pointer"
                  title="Step forward 0.5 seconds"
                >
                  <span>0.5s</span>
                  <FastForward className="h-3 w-3" />
                </button>

                <span className="font-mono text-xs text-slate-300 tabular-nums shrink-0">
                  {formatTimecode(currentTime)}
                </span>

                <input
                  type="range"
                  min={0}
                  max={duration || 6}
                  step={0.05}
                  value={currentTime}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setCurrentTime(next);
                    if (videoRef.current) {
                      videoRef.current.currentTime = next;
                    }
                  }}
                  aria-label="Seek video timeline"
                  className="h-1.5 min-w-[100px] flex-1 cursor-pointer accent-rose-500"
                />

                <span className="font-mono text-xs text-slate-400 tabular-nums shrink-0">
                  {formatTimecode(duration)}
                </span>
              </div>
            </div>

            {/* Verified Export Result Panel */}
            {processResult && (
              <div className="rounded-xl border border-slate-800 bg-[#111622] p-5">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5">
                    <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
                    <div>
                      <h4 className="text-sm font-bold text-white">
                        {processResult.outputFormat === 'mov'
                          ? `ProRes 422 Master Ready — ${activeVideo.title}`
                          : `Clean ${processResult.outputFormat.toUpperCase()} Ready — ${activeVideo.title}`}
                      </h4>
                      <p className="text-xs text-slate-400 font-mono tabular-nums">
                        {formatBytes(processResult.sizeBytes)} · Processed in {(processResult.durationMs / 1000).toFixed(2)}s · {processResult.regionsProcessed} region(s) erased
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => void handleDownloadClipResult(activeClip)}
                    disabled={downloadingExport}
                    className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-rose-500 disabled:opacity-60 whitespace-nowrap cursor-pointer"
                  >
                    {downloadingExport ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    <span>
                      {downloadingExport
                        ? 'Saving File...'
                        : `Save Clean ${processResult.outputFormat.toUpperCase()}`}
                    </span>
                  </button>
                </div>

                {processResult.outputFormat === 'mov' ? (
                  <div className="mt-4 flex items-center gap-3 rounded-lg border border-slate-800 bg-[#0D121D] px-4 py-3 text-xs text-slate-300">
                    <Film className="h-4 w-4 text-slate-400 shrink-0" />
                    <span>
                      Encoded in 10-bit Apple ProRes 422 (MOV) with uncompressed PCM audio—ready for Premiere Pro, DaVinci Resolve, and Final Cut Pro.
                    </span>
                  </div>
                ) : exportPreviewError || !resolvedExportUrl ? (
                  <div className="mt-4 flex items-center gap-3 rounded-lg border border-slate-800 bg-[#0D121D] px-4 py-3 text-xs text-slate-300">
                    <Film className="h-4 w-4 text-slate-400 shrink-0" />
                    <span>{exportPreviewError || 'Click Save above to download your clean exported file.'}</span>
                  </div>
                ) : (
                  <div className="mt-4 overflow-hidden rounded-lg border border-slate-800 bg-[#070A10]">
                    {processResult.outputFormat === 'mp3' ? (
                      <div className="p-4 bg-[#0D121D]">
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
                    ) : processResult.outputFormat === 'gif' ? (
                      <img
                        src={resolvedExportUrl}
                        alt="Exported clean GIF"
                        onError={() => {
                          void handleExportMediaError();
                        }}
                        className="mx-auto max-h-72 object-contain"
                      />
                    ) : (
                      <video
                        key={resolvedExportUrl}
                        controls
                        src={resolvedExportUrl}
                        onError={() => {
                          void handleExportMediaError();
                        }}
                        className="mx-auto aspect-video max-h-80 w-full object-contain"
                      />
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: Watermark Region Inspector & FFmpeg Export Controls */}
          <div className="lg:col-span-4">
            <div className="rounded-xl border border-slate-800 bg-[#111622]">
              <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5">
                <h3 className="text-sm font-bold text-white">
                  Watermark Masks ({regions.length}/6)
                </h3>
                {regions.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      updateRegions([]);
                      setSelectedRegionId(null);
                    }}
                    className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-rose-400 cursor-pointer"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Clear All</span>
                  </button>
                )}
              </div>

              {/* Quick Corner Placement Presets */}
              <div className="border-b border-slate-800 px-5 py-3">
                <p className="text-[11px] font-semibold text-slate-400">
                  1-Click Corner Mask
                </p>
                <div className="mt-1.5 grid grid-cols-5 gap-1">
                  {(
                    [
                      { id: 'tl', label: 'Top-L' },
                      { id: 'tr', label: 'Top-R' },
                      { id: 'bl', label: 'Bot-L' },
                      { id: 'br', label: 'Bot-R' },
                      { id: 'center', label: 'Center' },
                    ] as Array<{ id: CornerPreset; label: string }>
                  ).map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      disabled={regions.length >= 6 || isActiveClipProcessing}
                      onClick={() => addCornerMask(preset.id)}
                      className="rounded-md border border-slate-700 bg-slate-800/80 py-1 text-[11px] font-semibold text-slate-200 hover:border-slate-600 hover:bg-slate-800 hover:text-white disabled:opacity-40 whitespace-nowrap cursor-pointer"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Clean Divider List of Active Masks */}
              {regions.length === 0 ? (
                <div className="px-5 py-6 text-center text-xs text-slate-400">
                  <p className="font-medium text-slate-200">No masks active</p>
                  <p className="mt-1">
                    Drag directly across any logo on the video preview, or tap a corner preset above.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-slate-800">
                  {regions.map((reg, index) => {
                    const isSelected = reg.id === selectedRegionId;
                    return (
                      <div
                        key={reg.id}
                        onClick={() => setSelectedRegionId(reg.id)}
                        className={`px-5 py-3 transition-colors cursor-pointer ${
                          isSelected ? 'bg-rose-500/10' : 'hover:bg-slate-800/40'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-white">
                              Mask {index + 1}
                            </span>
                            {isSelected && (
                              <span className="text-[11px] font-semibold text-rose-400">
                                Active
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                              {reg.w}×{reg.h} · {reg.x},{reg.y}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                updateRegions((prev) => prev.filter((item) => item.id !== reg.id));
                              }}
                              className="rounded p-1 text-slate-400 hover:bg-rose-950 hover:text-rose-400 cursor-pointer"
                              aria-label={`Remove Mask ${index + 1}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>

                        <div className="mt-2 grid grid-cols-3 gap-1.5">
                          {(
                            [
                              { id: 'delogo', label: 'Inpaint' },
                              { id: 'blur', label: 'Soft Blur' },
                              { id: 'pixelate', label: 'Mosaic' },
                            ] as Array<{ id: RemovalMode; label: string }>
                          ).map((modeOpt) => (
                            <button
                              key={modeOpt.id}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                updateRegions((prev) =>
                                  prev.map((item) =>
                                    item.id === reg.id ? { ...item, mode: modeOpt.id } : item
                                  )
                                );
                              }}
                              className={`rounded-md py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                                reg.mode === modeOpt.id
                                  ? 'bg-rose-600 text-white'
                                  : 'bg-slate-900/90 text-slate-300 border border-slate-700 hover:bg-slate-800 hover:text-white'
                              }`}
                            >
                              {modeOpt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Edge Crop, Trim & Export Format Controls */}
              <div className="space-y-4 border-t border-slate-800 px-5 py-4">
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-300">Border Crop Margin</span>
                    <span className="font-mono text-slate-400 tabular-nums">{cropMarginPercent}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={15}
                    step={1}
                    disabled={isActiveClipProcessing}
                    value={cropMarginPercent}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      updateActiveClip((clip) => {
                        const shouldReset = clip.status === 'done' || clip.status === 'error' || clip.status === 'cancelled';
                        return {
                          ...clip,
                          cropMarginPercent: next,
                          status: shouldReset ? 'queued' : clip.status,
                          progress: shouldReset ? 0 : clip.progress,
                          stage: shouldReset ? 'Waiting in queue' : clip.stage,
                          result: shouldReset ? undefined : clip.result,
                        };
                      });
                    }}
                    className="mt-1.5 h-1.5 w-full cursor-pointer accent-rose-500 disabled:opacity-50"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="flex items-center gap-1 text-xs font-medium text-slate-300">
                      <Scissors className="h-3 w-3 text-slate-500" />
                      <span>Trim Start (s)</span>
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={Math.max(0, trimEnd - 0.5)}
                      step={0.1}
                      disabled={isActiveClipProcessing}
                      value={trimStart}
                      onChange={(e) => {
                        const next = Math.max(0, Number(e.target.value));
                        updateActiveClip((clip) => {
                          const shouldReset = clip.status === 'done' || clip.status === 'error' || clip.status === 'cancelled';
                          return {
                            ...clip,
                            trimStart: next,
                            status: shouldReset ? 'queued' : clip.status,
                            progress: shouldReset ? 0 : clip.progress,
                            stage: shouldReset ? 'Waiting in queue' : clip.stage,
                            result: shouldReset ? undefined : clip.result,
                          };
                        });
                      }}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-[#090D16] px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-rose-500 focus:outline-none disabled:opacity-50"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-300">Trim End (s)</label>
                    <input
                      type="number"
                      min={trimStart + 0.5}
                      max={duration || 3600}
                      step={0.1}
                      disabled={isActiveClipProcessing}
                      value={trimEnd}
                      onChange={(e) => {
                        const next = Math.max(trimStart + 0.5, Number(e.target.value));
                        updateActiveClip((clip) => {
                          const shouldReset = clip.status === 'done' || clip.status === 'error' || clip.status === 'cancelled';
                          return {
                            ...clip,
                            trimEnd: next,
                            status: shouldReset ? 'queued' : clip.status,
                            progress: shouldReset ? 0 : clip.progress,
                            stage: shouldReset ? 'Waiting in queue' : clip.stage,
                            result: shouldReset ? undefined : clip.result,
                          };
                        });
                      }}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-[#090D16] px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-rose-500 focus:outline-none disabled:opacity-50"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-300">Format</label>
                    <select
                      value={outputFormat}
                      disabled={isActiveClipProcessing}
                      onChange={(e) => {
                        const nextFormat = e.target.value as OutputFormat;
                        updateActiveClip((clip) => {
                          const shouldReset = clip.status === 'done' || clip.status === 'error' || clip.status === 'cancelled';
                          return {
                            ...clip,
                            outputFormat: nextFormat,
                            status: shouldReset ? 'queued' : clip.status,
                            progress: shouldReset ? 0 : clip.progress,
                            stage: shouldReset ? 'Waiting in queue' : clip.stage,
                            result: shouldReset ? undefined : clip.result,
                          };
                        });
                      }}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-[#090D16] px-2.5 py-2 text-xs font-medium text-slate-100 focus:border-rose-500 focus:outline-none disabled:opacity-50"
                    >
                      <option value="mp4">MP4 (H.264)</option>
                      <option value="mov">MOV (ProRes 422)</option>
                      <option value="webm">WebM (VP9)</option>
                      <option value="mp3">MP3 Audio (320k)</option>
                      <option value="gif">GIF Loop</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300">Resolution</label>
                    <select
                      value={resolution}
                      onChange={(e) => {
                        const nextRes = e.target.value as OutputResolution;
                        updateActiveClip((clip) => {
                          const shouldReset = clip.status === 'done' || clip.status === 'error' || clip.status === 'cancelled';
                          return {
                            ...clip,
                            resolution: nextRes,
                            status: shouldReset ? 'queued' : clip.status,
                            progress: shouldReset ? 0 : clip.progress,
                            stage: shouldReset ? 'Waiting in queue' : clip.stage,
                            result: shouldReset ? undefined : clip.result,
                          };
                        });
                      }}
                      disabled={isActiveClipProcessing || outputFormat === 'mp3' || outputFormat === 'gif'}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-[#090D16] px-2.5 py-2 text-xs font-medium text-slate-100 focus:border-rose-500 focus:outline-none disabled:opacity-40"
                    >
                      <option value="original">Original ({activeVideo.height}p)</option>
                      <option value="1080p">1080p Full HD</option>
                      <option value="720p">720p HD</option>
                      <option value="480p">480p SD</option>
                    </select>
                  </div>
                </div>

                {processError && (
                  <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
                    {processError}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => void handleProcessActiveClip()}
                  disabled={processingSingle || batchRunning || isActiveClipProcessing}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-rose-500 disabled:opacity-60 cursor-pointer"
                >
                  {isActiveClipProcessing || processingSingle ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span className="font-mono tabular-nums">
                        Rendering {activeClip.progress > 0 ? `${activeClip.progress}%` : '...'}
                      </span>
                    </>
                  ) : (
                    <>
                      <Eraser className="h-4 w-4" />
                      <span>Remove Watermark &amp; Export</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-700 bg-[#111622] px-6 py-14 text-center">
          <p className="text-sm font-semibold text-slate-200">
            Select sample clips above or upload multiple videos to start watermark removal.
          </p>
        </div>
      )}

      {/* Batch Export Queue positioned cleanly beneath the main studio canvas */}
      <div ref={batchQueueSectionRef}>
        <BatchExportQueue
          queue={queue}
          activeClipId={activeClip?.id || null}
          batchRunning={batchRunning}
          processingSingle={processingSingle}
          downloadingAll={downloadingAll}
          batchProgress={batchProgress}
          batchNotice={batchNotice}
          onSelectClip={setActiveClipId}
          onAddMoreVideos={() => fileInputRef.current?.click()}
          onApplyMasksToAll={handleApplyMasksToAll}
          onStartBatch={() => void handleProcessBatch()}
          onStopAfterCurrent={() => {
            cancelBatchRef.current = true;
          }}
          onCancelActiveJob={(clip) => void handleCancelActiveJob(clip)}
          onProcessSingleClip={(clip) => void handleProcessSingleClip(clip)}
          onRetryClip={(clip) => void handleProcessSingleClip(clip)}
          onDuplicateClip={handleDuplicateClip}
          onMoveClip={handleMoveClip}
          onRemoveClip={handleRemoveClip}
          onClearCompleted={handleClearCompleted}
          onDownloadClip={(clip) => void handleDownloadClipResult(clip)}
          onDownloadAllCompleted={() => void handleDownloadAllCompleted()}
        />
      </div>
    </div>
  );
};
