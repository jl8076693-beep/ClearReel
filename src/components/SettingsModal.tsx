import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Download,
  HardDrive,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { StoredProcessedClip, StudioSettings } from '../types/media';
import {
  AUTO_CLEANUP_MAX_AGE_MS,
  STORAGE_UPDATED_EVENT,
  cleanupExpiredClips,
  clearAllProcessedClips,
  deleteProcessedClip,
  getBrowserStorageSummary,
  loadProcessedClips,
} from '../utils/clipStorage';
import { triggerBlobDownload } from '../utils/download';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: StudioSettings;
  onToggleAutoCleanup: (enabled: boolean) => void;
  onPruneExpiredFromState: (expiredOutputIds: string[]) => void;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRelativeAge(timestamp: number): string {
  const diffMs = Math.max(0, Date.now() - timestamp);
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  onClose,
  settings,
  onToggleAutoCleanup,
  onPruneExpiredFromState,
}) => {
  const [clips, setClips] = useState<StoredProcessedClip[]>([]);
  const [storageSummary, setStorageSummary] = useState<{
    clipCount: number;
    cachedClipCount: number;
    cachedBytes: number;
    browserUsageBytes?: number;
    browserQuotaBytes?: number;
  }>({
    clipCount: 0,
    cachedClipCount: 0,
    cachedBytes: 0,
  });
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  const refreshStorageView = useCallback(async () => {
    setClips(loadProcessedClips());
    const summary = await getBrowserStorageSummary();
    setStorageSummary(summary);
  }, []);

  useEffect(() => {
    if (!open) {
      setStatusNotice(null);
      setConfirmClearAll(false);
      return;
    }
    void refreshStorageView();

    const handleStorageUpdate = () => {
      void refreshStorageView();
    };
    window.addEventListener(STORAGE_UPDATED_EVENT, handleStorageUpdate);
    return () => {
      window.removeEventListener(STORAGE_UPDATED_EVENT, handleStorageUpdate);
    };
  }, [open, refreshStorageView]);

  if (!open) return null;

  const expiredCount = clips.filter(
    (item) => Date.now() - item.createdAt >= AUTO_CLEANUP_MAX_AGE_MS
  ).length;

  const handleRunCleanupNow = async () => {
    const result = await cleanupExpiredClips(AUTO_CLEANUP_MAX_AGE_MS);
    if (result.expiredOutputIds.length > 0) {
      onPruneExpiredFromState(result.expiredOutputIds);
    }
    await refreshStorageView();
    if (result.deletedCount > 0) {
      setStatusNotice(
        `Removed ${result.deletedCount} clip(s) older than 24h (${formatBytes(result.freedBytes)} freed).`
      );
    } else {
      setStatusNotice('No processed clips older than 24 hours found.');
    }
  };

  const handleDeleteSingle = async (clip: StoredProcessedClip) => {
    await deleteProcessedClip(clip.id);
    onPruneExpiredFromState([clip.outputId]);
    await refreshStorageView();
    setStatusNotice(`Deleted "${clip.title}" from browser storage.`);
  };

  const handleClearAll = async () => {
    if (!confirmClearAll) {
      setConfirmClearAll(true);
      return;
    }
    const allIds = clips.map((c) => c.outputId);
    const result = await clearAllProcessedClips();
    if (allIds.length > 0) {
      onPruneExpiredFromState(allIds);
    }
    setConfirmClearAll(false);
    await refreshStorageView();
    setStatusNotice(
      `Cleared ${result.deletedCount} cached clip(s) (${formatBytes(result.freedBytes)} freed).`
    );
  };

  const handleDownloadClip = async (clip: StoredProcessedClip) => {
    try {
      await triggerBlobDownload(clip.downloadUrl, clip.filename);
    } catch {
      setStatusNotice(`Could not download "${clip.title}" — temporary file may have expired.`);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="studio-settings-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-xl border border-slate-800 bg-[#111622] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-6 py-4">
          <div>
            <h2 id="studio-settings-title" className="text-lg font-bold text-white">
              Studio Settings
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Manage local browser storage and automatic clip cleanup.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white cursor-pointer"
            aria-label="Close Studio Settings"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-5 px-6 py-5">
          {/* Auto-Cleanup Toggle Row */}
          <div className="flex items-start justify-between gap-4 rounded-xl border border-slate-800 bg-[#0D121D] p-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-white">
                  Auto-cleanup processed clips
                </span>
                <span className="font-mono text-[11px] font-semibold text-rose-400">
                  24h
                </span>
              </div>
              <p className="text-xs leading-relaxed text-slate-400">
                Automatically delete processed clips older than 24 hours to save local browser storage.
              </p>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={settings.autoCleanup}
              aria-label="Toggle Auto-cleanup for processed clips older than 24 hours"
              onClick={() => onToggleAutoCleanup(!settings.autoCleanup)}
              className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500 ${
                settings.autoCleanup
                  ? 'border-rose-500 bg-rose-600'
                  : 'border-slate-700 bg-slate-800'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.autoCleanup ? 'translate-x-5.5' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Local Browser Storage Telemetry */}
          <div className="rounded-xl border border-slate-800 bg-[#090D16] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <HardDrive className="h-4 w-4 text-slate-400 shrink-0" />
                <div>
                  <p className="text-xs font-semibold text-slate-200">
                    Local Browser Storage
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] text-slate-400 tabular-nums">
                    {storageSummary.clipCount} processed clip{storageSummary.clipCount === 1 ? '' : 's'}
                    {' · '}
                    {formatBytes(storageSummary.cachedBytes)} cached
                    {storageSummary.browserQuotaBytes
                      ? ` · ${formatBytes(storageSummary.browserQuotaBytes)} quota`
                      : ''}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {expiredCount > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleRunCleanupNow()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700 whitespace-nowrap cursor-pointer"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-rose-400" />
                    <span>Clean Expired ({expiredCount})</span>
                  </button>
                )}

                {clips.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleClearAll()}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap cursor-pointer ${
                      confirmClearAll
                        ? 'bg-rose-600 text-white hover:bg-rose-500'
                        : 'border border-slate-700 bg-[#111622] text-slate-300 hover:bg-rose-950/60 hover:text-rose-300'
                    }`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>{confirmClearAll ? 'Confirm Clear All' : 'Clear All'}</span>
                  </button>
                )}
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2 border-t border-slate-800/80 pt-2.5 text-[11px] text-slate-400">
              {settings.autoCleanup ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  <span>
                    Auto-cleanup active · Clips older than 24 hours are automatically removed.
                    {settings.lastCleanupAt && settings.lastCleanupDeletedCount
                      ? ` Last removed ${settings.lastCleanupDeletedCount} clip(s) ${formatRelativeAge(settings.lastCleanupAt)}.`
                      : ''}
                  </span>
                </>
              ) : (
                <>
                  <Clock className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                  <span>Auto-cleanup paused · Processed clips stay in browser storage until cleared.</span>
                </>
              )}
            </div>
          </div>

          {statusNotice && (
            <div className="rounded-lg border border-slate-700 bg-[#0D121D] px-3.5 py-2 text-xs text-slate-200">
              {statusNotice}
            </div>
          )}

          {/* Cached Processed Clips List */}
          <div>
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-300">
                Processed Clips in Browser Storage
              </span>
              <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                {clips.length} item{clips.length === 1 ? '' : 's'}
              </span>
            </div>

            {clips.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-800 bg-[#090D16] px-4 py-6 text-center text-xs text-slate-500">
                No processed clips stored in browser cache yet. Export a clip from Studio or Clipper to manage it here.
              </div>
            ) : (
              <div className="max-h-52 divide-y divide-slate-800 overflow-y-auto rounded-xl border border-slate-800 bg-[#090D16]">
                {clips.map((clip) => {
                  const isOlderThan24h = Date.now() - clip.createdAt >= AUTO_CLEANUP_MAX_AGE_MS;
                  return (
                    <div
                      key={clip.id}
                      className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold text-slate-200">{clip.title}</p>
                        <p className="mt-0.5 font-mono text-[11px] text-slate-400 tabular-nums">
                          {clip.tool === 'studio' ? 'Studio' : 'Clipper'}
                          {' · '}
                          {clip.outputFormat.toUpperCase()}
                          {' · '}
                          {formatBytes(clip.sizeBytes)}
                          {' · '}
                          <span className={isOlderThan24h ? 'text-amber-400' : 'text-slate-400'}>
                            {formatRelativeAge(clip.createdAt)}
                            {isOlderThan24h ? ' (>24h)' : ''}
                          </span>
                        </p>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => void handleDownloadClip(clip)}
                          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white cursor-pointer"
                          title="Download cached clip"
                          aria-label={`Download ${clip.title}`}
                        >
                          <Download className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteSingle(clip)}
                          className="rounded-md p-1.5 text-slate-400 hover:bg-rose-950 hover:text-rose-400 cursor-pointer"
                          title="Delete from browser storage"
                          aria-label={`Delete ${clip.title} from browser storage`}
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
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end border-t border-slate-800 px-6 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
