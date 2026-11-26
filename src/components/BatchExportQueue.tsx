import React from 'react';
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  CopyCheck,
  CopyPlus,
  Download,
  Eraser,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react';
import type { BatchClipItem } from '../types/media';

interface BatchExportQueueProps {
  queue: BatchClipItem[];
  activeClipId: string | null;
  batchRunning: boolean;
  processingSingle: boolean;
  downloadingAll: boolean;
  batchProgress: { current: number; total: number; title: string } | null;
  batchNotice: string | null;
  onSelectClip: (clipId: string) => void;
  onAddMoreVideos: () => void;
  onApplyMasksToAll: () => void;
  onStartBatch: () => void;
  onStopAfterCurrent: () => void;
  onCancelActiveJob: (clip: BatchClipItem) => void;
  onProcessSingleClip: (clip: BatchClipItem) => void;
  onRetryClip: (clip: BatchClipItem) => void;
  onDuplicateClip: (clip: BatchClipItem) => void;
  onMoveClip: (clipId: string, direction: 'up' | 'down') => void;
  onRemoveClip: (clipId: string) => void;
  onClearCompleted: () => void;
  onDownloadClip: (clip: BatchClipItem) => void;
  onDownloadAllCompleted: () => void;
}

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

export const BatchExportQueue: React.FC<BatchExportQueueProps> = ({
  queue,
  activeClipId,
  batchRunning,
  processingSingle,
  downloadingAll,
  batchProgress,
  batchNotice,
  onSelectClip,
  onAddMoreVideos,
  onApplyMasksToAll,
  onStartBatch,
  onStopAfterCurrent,
  onCancelActiveJob,
  onProcessSingleClip,
  onRetryClip,
  onDuplicateClip,
  onMoveClip,
  onRemoveClip,
  onClearCompleted,
  onDownloadClip,
  onDownloadAllCompleted,
}) => {
  if (queue.length === 0) {
    return null;
  }

  const pendingCount = queue.filter(
    (item) => item.status === 'queued' || item.status === 'error' || item.status === 'cancelled'
  ).length;
  const completedCount = queue.filter((item) => item.status === 'done' && item.result).length;
  const activeClip = queue.find((item) => item.id === activeClipId) || queue[0] || null;

  const totalProgressSum = queue.reduce((acc, item) => {
    if (item.status === 'done') return acc + 100;
    if (item.status === 'processing') return acc + item.progress;
    return acc;
  }, 0);
  const overallPercent = Math.round(totalProgressSum / Math.max(1, queue.length));

  const showOverallBar = batchRunning || (completedCount > 0 && queue.length > 1);

  return (
    <section
      aria-label="Batch Export Queue"
      className="rounded-xl border border-slate-800 bg-[#111622]"
    >
      {/* Queue Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <h3 className="text-sm font-bold text-white whitespace-nowrap">
              Batch Export Queue
            </h3>
            <p className="text-xs text-slate-400 font-mono tabular-nums">
              <span>{queue.length} {queue.length === 1 ? 'task' : 'tasks'}</span>
              <span aria-hidden="true" className="mx-1.5 text-slate-600">·</span>
              <span>{completedCount} ready</span>
              <span aria-hidden="true" className="mx-1.5 text-slate-600">·</span>
              <span>{pendingCount} pending</span>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={batchRunning}
            onClick={onAddMoreVideos}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5 text-slate-400" />
            <span>Add Videos</span>
          </button>

          {queue.length > 1 && activeClip && (
            <button
              type="button"
              disabled={batchRunning}
              onClick={onApplyMasksToAll}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <CopyCheck className="h-3.5 w-3.5 text-slate-400" />
              <span>Apply Masks to All</span>
            </button>
          )}

          {batchRunning ? (
            <button
              type="button"
              onClick={onStopAfterCurrent}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Square className="h-3 w-3 fill-current" />
              <span>Stop After Current</span>
            </button>
          ) : (
            pendingCount > 0 && (
              <button
                type="button"
                disabled={processingSingle}
                onClick={onStartBatch}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Eraser className="h-3.5 w-3.5" />
                <span>Start Batch Export ({pendingCount})</span>
              </button>
            )
          )}

          {completedCount > 1 && (
            <button
              type="button"
              disabled={downloadingAll}
              onClick={onDownloadAllCompleted}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-3.5 py-1.5 text-xs font-semibold text-slate-900 hover:bg-white disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {downloadingAll ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              <span>Download All ({completedCount})</span>
            </button>
          )}

          {completedCount > 0 && !batchRunning && queue.length > 1 && (
            <button
              type="button"
              onClick={onClearCompleted}
              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-400 hover:bg-slate-800 hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
            >
              Clear Completed
            </button>
          )}
        </div>
      </div>

      {/* Overall Sequential Progress Strip */}
      {showOverallBar && (
        <div className="border-b border-slate-800 bg-[#0D121D] px-4 py-2.5 sm:px-5">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="truncate font-medium text-slate-300">
              {batchProgress
                ? `Sequential run: Clip ${batchProgress.current} of ${batchProgress.total} — ${batchProgress.title}`
                : `Batch summary: ${completedCount} of ${queue.length} tasks exported`}
            </span>
            <span className="font-mono font-semibold text-white tabular-nums shrink-0">
              {overallPercent}%
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              style={{ transform: `scaleX(${Math.max(0, Math.min(1, overallPercent / 100))})` }}
              className={`h-full w-full origin-left transition-transform duration-150 ${
                overallPercent === 100 ? 'bg-emerald-500' : 'bg-rose-500'
              }`}
            />
          </div>
        </div>
      )}

      {batchNotice && (
        <div className="border-b border-slate-800 bg-[#0D121D] px-4 py-2 text-xs font-medium text-slate-300 sm:px-5">
          {batchNotice}
        </div>
      )}

      {/* Sequential Clip Queue Rows */}
      <div className="divide-y divide-slate-800">
        {queue.map((item, idx) => {
          const isFocused = activeClip?.id === item.id;
          const isProcessing = item.status === 'processing';
          const isDone = item.status === 'done' && Boolean(item.result);
          const isError = item.status === 'error';
          const isCancelled = item.status === 'cancelled';
          const pct = isDone ? 100 : Math.max(0, Math.min(100, item.progress || 0));

          const hasTrim =
            item.trimStart > 0 ||
            (item.video.duration > 0 && item.trimEnd > 0 && Math.abs(item.trimEnd - item.video.duration) > 0.25);

          return (
            <div
              key={item.id}
              onClick={() => onSelectClip(item.id)}
              className={`flex flex-col gap-3 px-4 py-3 text-xs transition-colors cursor-pointer md:flex-row md:items-center md:justify-between md:gap-5 sm:px-5 ${
                isFocused ? 'bg-rose-500/8' : 'hover:bg-slate-800/35'
              }`}
            >
              {/* Left: Order Controls + Clip Details */}
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div
                  className="flex items-center gap-1 shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="font-mono text-slate-500 tabular-nums w-5 text-center">
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                  {queue.length > 1 && (
                    <div className="flex flex-col">
                      <button
                        type="button"
                        disabled={idx === 0 || batchRunning || isProcessing}
                        onClick={() => onMoveClip(item.id, 'up')}
                        className="rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-25 cursor-pointer"
                        aria-label={`Move ${item.video.title} up`}
                      >
                        <ChevronUp className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        disabled={idx === queue.length - 1 || batchRunning || isProcessing}
                        onClick={() => onMoveClip(item.id, 'down')}
                        className="rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-25 cursor-pointer"
                        aria-label={`Move ${item.video.title} down`}
                      >
                        <ChevronDown className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-semibold text-slate-100">
                      {item.video.title}
                    </p>
                    {isFocused && (
                      <span className="text-[11px] font-semibold text-rose-400 shrink-0">
                        Editing
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400 tabular-nums">
                    {item.video.width}×{item.video.height}
                    {' · '}
                    {formatTimecode(item.video.duration)}
                    {' · '}
                    {item.regions.length} mask{item.regions.length === 1 ? '' : 's'}
                    {' · '}
                    {item.outputFormat.toUpperCase()} {item.resolution === 'original' ? 'Orig' : item.resolution}
                    {hasTrim ? ` · ${item.trimStart.toFixed(1)}s–${item.trimEnd.toFixed(1)}s` : ''}
                  </p>
                </div>
              </div>

              {/* Middle: Per-Clip Individual Progress Bar & Live Telemetry */}
              <div className="w-full md:w-64 lg:w-72 shrink-0">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span
                    className={`inline-flex items-center gap-1.5 truncate font-medium ${
                      isDone
                        ? 'text-emerald-400'
                        : isProcessing
                        ? 'text-rose-400'
                        : isError
                        ? 'text-rose-400'
                        : isCancelled
                        ? 'text-amber-400'
                        : 'text-slate-400'
                    }`}
                  >
                    {isProcessing && <Loader2 className="h-3 w-3 animate-spin shrink-0" />}
                    {isDone && <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" />}
                    {isError && <AlertCircle className="h-3 w-3 shrink-0 text-rose-400" />}
                    {isCancelled && <Ban className="h-3 w-3 shrink-0 text-amber-400" />}
                    {item.status === 'queued' && <Clock className="h-3 w-3 shrink-0 text-slate-500" />}

                    <span className="truncate">
                      {isProcessing && (item.stage || 'Removing watermarks')}
                      {isDone && item.result && `${formatBytes(item.result.sizeBytes)} · ${(item.result.durationMs / 1000).toFixed(1)}s`}
                      {isError && (item.error || 'Failed')}
                      {isCancelled && 'Cancelled'}
                      {item.status === 'queued' && 'Waiting in queue'}
                    </span>
                  </span>

                  <span className="font-mono text-[11px] font-semibold text-slate-200 tabular-nums shrink-0">
                    {pct}%
                    {isProcessing && item.speed ? ` · ${item.speed}` : ''}
                  </span>
                </div>

                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    style={{ transform: `scaleX(${pct / 100})` }}
                    className={`h-full w-full origin-left transition-transform duration-150 ${
                      isDone
                        ? 'bg-emerald-500'
                        : isProcessing
                        ? 'bg-rose-500'
                        : isError
                        ? 'bg-rose-400'
                        : isCancelled
                        ? 'bg-amber-400'
                        : 'bg-slate-600'
                    }`}
                  />
                </div>
              </div>

              {/* Right: Per-Clip Row Actions */}
              <div
                className="flex items-center justify-end gap-1.5 shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                {isProcessing ? (
                  <button
                    type="button"
                    onClick={() => onCancelActiveJob(item)}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:border-rose-500/60 hover:bg-rose-950/60 hover:text-rose-300 whitespace-nowrap cursor-pointer"
                  >
                    <Square className="h-3 w-3 fill-current" />
                    <span>Cancel</span>
                  </button>
                ) : isDone && item.result ? (
                  <button
                    type="button"
                    onClick={() => onDownloadClip(item)}
                    className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-rose-500 whitespace-nowrap cursor-pointer"
                  >
                    <Download className="h-3 w-3" />
                    <span>Save {item.result.outputFormat.toUpperCase()}</span>
                  </button>
                ) : isError || isCancelled ? (
                  <button
                    type="button"
                    disabled={batchRunning || processingSingle}
                    onClick={() => onRetryClip(item)}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-40 whitespace-nowrap cursor-pointer"
                  >
                    <RotateCcw className="h-3 w-3 text-rose-400" />
                    <span>Retry</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={batchRunning || processingSingle}
                    onClick={() => onProcessSingleClip(item)}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-40 whitespace-nowrap cursor-pointer"
                    title="Process this clip right now"
                  >
                    <Play className="h-3 w-3 text-rose-400" />
                    <span>Run</span>
                  </button>
                )}

                <button
                  type="button"
                  disabled={isProcessing || batchRunning}
                  onClick={() => onDuplicateClip(item)}
                  className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-35 cursor-pointer"
                  aria-label={`Stack duplicate task for ${item.video.title}`}
                  title="Duplicate task in queue"
                >
                  <CopyPlus className="h-3.5 w-3.5" />
                </button>

                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => onRemoveClip(item.id)}
                  className="rounded p-1.5 text-slate-400 hover:bg-rose-950 hover:text-rose-400 disabled:opacity-35 cursor-pointer"
                  aria-label={`Remove ${item.video.title} from batch`}
                  title="Remove from queue"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
