import React, { useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardPaste,
  Copy,
  Download,
  Eraser,
  Film,
  ImageDown,
  Loader2,
  Music,
  Play,
  Scissors,
  Terminal,
  Upload,
  X,
} from 'lucide-react';
import type { FormatOption, InspectedLink, LoadedVideo } from '../types/media';
import { triggerBlobDownload } from '../utils/download';
import { parseJsonResponse, uploadVideoFile } from '../utils/upload';

interface LinkDownloaderProps {
  onLoadIntoStudio: (video: LoadedVideo) => void;
  onLoadIntoClipper: (video: LoadedVideo) => void;
  onLoadDemoClip: () => void;
}

interface LocalFallbackInfo {
  command: string;
  canonicalUrl: string;
  videoId: string;
  formatLabel: string;
}

const QUICK_LINKS = [
  { label: 'Downloadable MP4 Sample', url: '/api/samples/coastal_drone_watermarked.mp4' },
  { label: 'YouTube 4K Sample', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' },
  { label: 'YouTube Shorts Sample', url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' },
];

export const LinkDownloader: React.FC<LinkDownloaderProps> = ({
  onLoadIntoStudio,
  onLoadIntoClipper,
  onLoadDemoClip,
}) => {
  const [urlInput, setUrlInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [importingTo, setImportingTo] = useState<'studio' | 'clipper' | null>(null);
  const [uploadingLocal, setUploadingLocal] = useState(false);
  const [downloadingThumb, setDownloadingThumb] = useState(false);
  const [downloadingFormatId, setDownloadingFormatId] = useState<string | null>(null);
  const [downloadSuccess, setDownloadSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InspectedLink | null>(null);
  const [showEmbed, setShowEmbed] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const [localFallback, setLocalFallback] = useState<LocalFallbackInfo | null>(null);
  const [showCliDetails, setShowCliDetails] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const localFileInputRef = useRef<HTMLInputElement | null>(null);

  const inspectUrl = async (targetUrl?: string) => {
    const query = (targetUrl ?? urlInput).trim();
    if (!query) {
      setError('Paste a direct MP4/WebM link or a YouTube URL first.');
      return;
    }

    setLoading(true);
    setError(null);
    setLocalFallback(null);
    setShowCliDetails(false);
    setDownloadSuccess(null);
    setShowEmbed(false);
    setThumbFailed(false);

    try {
      const res = await fetch('/api/inspect-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: query }),
      });
      const data = await parseJsonResponse<InspectedLink>(res);
      setResult(data);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : 'Unable to analyze link.');
    } finally {
      setLoading(false);
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setUrlInput(text);
        setError(null);
      }
    } catch {
      setError('Clipboard access blocked. Paste directly using Ctrl+V or Cmd+V.');
    }
  };

  const handleDownloadFormat = async (fmt: FormatOption) => {
    if (!result) return;

    setDownloadingFormatId(fmt.id);
    setError(null);
    setDownloadSuccess(null);
    setLocalFallback(null);

    try {
      const res = await fetch('/api/download-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: result.canonicalUrl,
          formatId: fmt.id,
        }),
      });
      const rawText = await res.text();
      let data: {
        code?: string;
        localCommand?: string;
        canonicalUrl?: string;
        videoId?: string;
        downloadUrl?: string;
        filename?: string;
        sizeBytes?: number;
        error?: string;
      } = {};
      if (rawText) {
        try {
          data = JSON.parse(rawText);
        } catch {
          throw new Error(`Invalid response from server (HTTP ${res.status}).`);
        }
      }

      if (res.status === 422 && data.code === 'LOCAL_DOWNLOAD_REQUIRED') {
        setLocalFallback({
          command: data.localCommand || '',
          canonicalUrl: data.canonicalUrl || result.canonicalUrl,
          videoId: data.videoId || '',
          formatLabel: `${fmt.label} (${fmt.container})`,
        });
        return;
      }

      if (!res.ok || !data.downloadUrl || !data.filename) {
        throw new Error(data.error || 'Failed to prepare video download.');
      }

      await triggerBlobDownload(data.downloadUrl, data.filename);
      setDownloadSuccess(
        `Saved ${data.filename}${data.sizeBytes ? ` (${(data.sizeBytes / (1024 * 1024)).toFixed(2)} MB)` : ''}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setDownloadingFormatId(null);
    }
  };

  const handleDownloadThumbnail = async () => {
    if (!result?.videoId) return;
    setDownloadingThumb(true);
    setError(null);
    try {
      await triggerBlobDownload(
        `/api/youtube-thumbnail/${result.videoId}`,
        `youtube-${result.videoId}.jpg`
      );
      setDownloadSuccess(`Saved youtube-${result.videoId}.jpg`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not download thumbnail.');
    } finally {
      setDownloadingThumb(false);
    }
  };

  const handleCopyCommand = async () => {
    if (!localFallback) return;
    try {
      await navigator.clipboard.writeText(localFallback.command);
      setCopiedCommand(true);
      setTimeout(() => setCopiedCommand(false), 2000);
    } catch {
      setError('Clipboard permission blocked. Copy the command text directly.');
    }
  };

  const handleLocalFilePicked = async (file: File) => {
    setUploadingLocal(true);
    setError(null);
    try {
      const data = await uploadVideoFile(file);
      onLoadIntoStudio({
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
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to upload file.');
    } finally {
      setUploadingLocal(false);
    }
  };

  const handleImportDirectMedia = async (destination: 'studio' | 'clipper') => {
    if (!result) return;
    if (!result.directMediaSupported) {
      onLoadDemoClip();
      return;
    }

    setImportingTo(destination);
    setError(null);
    try {
      const res = await fetch('/api/import-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: result.canonicalUrl }),
      });
      const data = await parseJsonResponse<{
        sourceType: string;
        fileId: string;
        filename: string;
        previewUrl: string;
        width: number;
        height: number;
        duration: number;
        fps: number;
        hasAudio: boolean;
        sizeBytes: number;
      }>(res);
      const loaded: LoadedVideo = {
        sourceType: data.sourceType === 'sample' ? 'sample' : 'upload',
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
      if (destination === 'clipper') {
        onLoadIntoClipper(loaded);
      } else {
        onLoadIntoStudio(loaded);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to import media stream.');
    } finally {
      setImportingTo(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-800 bg-[#111622] p-4 sm:p-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void inspectUrl();
          }}
          className="flex flex-col gap-3 sm:flex-row sm:items-stretch"
        >
          <div className="relative flex-1">
            <input
              type="text"
              value={urlInput}
              onChange={(e) => {
                setUrlInput(e.target.value);
                if (error) setError(null);
              }}
              placeholder="Paste direct .mp4 / .webm / .mov link or YouTube URL..."
              aria-label="Video URL"
              className="h-12 w-full rounded-xl border border-slate-700 bg-[#090D16] pr-20 pl-4 text-sm text-slate-100 placeholder:text-slate-500 focus:border-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-500/20"
            />
            <div className="absolute inset-y-0 right-2 flex items-center gap-1">
              {urlInput ? (
                <button
                  type="button"
                  onClick={() => {
                    setUrlInput('');
                    setResult(null);
                    setError(null);
                    setDownloadSuccess(null);
                    setLocalFallback(null);
                  }}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200 cursor-pointer"
                  aria-label="Clear link"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handlePaste}
                  className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white cursor-pointer"
                >
                  <ClipboardPaste className="h-3.5 w-3.5" />
                  <span>Paste</span>
                </button>
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-rose-600 px-6 text-sm font-semibold text-white transition-colors hover:bg-rose-500 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Analyzing...</span>
              </>
            ) : (
              <>
                <span>Analyze Link</span>
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>
        </form>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
          <div className="flex flex-wrap items-center gap-4">
            <span>Quick test:</span>
            {QUICK_LINKS.map((item) => (
              <button
                key={item.url}
                type="button"
                onClick={() => {
                  setUrlInput(item.url);
                  void inspectUrl(item.url);
                }}
                className="font-medium text-slate-200 underline decoration-slate-600 underline-offset-4 hover:text-rose-400 hover:decoration-rose-400 cursor-pointer"
              >
                {item.label}
              </button>
            ))}
          </div>
          <span>Saves directly in MP4, WebM, and MP3 format</span>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-rose-500/40 bg-rose-950/60 px-4 py-3 text-sm text-rose-200"
        >
          {error}
        </div>
      )}

      {downloadSuccess && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-950/50 px-4 py-3 text-sm text-emerald-200">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
          <span>{downloadSuccess}</span>
        </div>
      )}

      {!result && !loading && (
        <div className="grid gap-4 rounded-xl border border-slate-800 bg-[#111622] p-5 md:grid-cols-3 md:divide-x md:divide-slate-800 md:gap-0">
          <div className="md:pr-5">
            <p className="font-mono text-xs font-semibold text-rose-500">01</p>
            <h3 className="mt-1.5 text-sm font-bold text-white">Direct Media Links</h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Paste any direct <span className="font-mono text-slate-300">.mp4</span>,{' '}
              <span className="font-mono text-slate-300">.mov</span>, or{' '}
              <span className="font-mono text-slate-300">.webm</span> URL to convert formats or open straight in the Studio.
            </p>
          </div>
          <div className="md:px-5">
            <p className="font-mono text-xs font-semibold text-rose-500">02</p>
            <h3 className="mt-1.5 text-sm font-bold text-white">YouTube &amp; Shorts Inspector</h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Inspect aspect ratios, preview embedded clips, and download high-resolution video thumbnails.
            </p>
          </div>
          <div className="md:pl-5">
            <p className="font-mono text-xs font-semibold text-rose-500">03</p>
            <h3 className="mt-1.5 text-sm font-bold text-white">One-Click Studio Handoff</h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Send imported clips directly into Watermark Studio or AI Highlight Clipper without re-uploading.
            </p>
          </div>
        </div>
      )}

      {result && (
        <div className="rounded-xl border border-slate-800 bg-[#111622] p-5 sm:p-6">
          <div className="grid gap-6 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <div className="relative aspect-video overflow-hidden rounded-lg border border-slate-800 bg-[#070A10]">
                {showEmbed && result.videoId ? (
                  <iframe
                    src={`https://www.youtube.com/embed/${result.videoId}?autoplay=1`}
                    title={result.title}
                    className="h-full w-full"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                ) : !thumbFailed ? (
                  <>
                    <img
                      src={result.thumbnail}
                      alt={result.title}
                      referrerPolicy="no-referrer"
                      onError={() => setThumbFailed(true)}
                      className="h-full w-full object-cover"
                    />
                    {result.videoId && (
                      <button
                        type="button"
                        onClick={() => setShowEmbed(true)}
                        className="absolute inset-0 flex items-center justify-center bg-black/40 text-white transition-colors hover:bg-black/55 cursor-pointer"
                        aria-label="Play video preview"
                      >
                        <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-rose-600 shadow-lg">
                          <Play className="h-5 w-5 fill-current pl-0.5" />
                        </span>
                      </button>
                    )}
                  </>
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[#0D121D] p-4 text-center text-slate-300">
                    <Film className="h-7 w-7 text-slate-500" />
                    <span className="text-xs font-medium">{result.title}</span>
                  </div>
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleImportDirectMedia('studio')}
                  disabled={importingTo !== null}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-100 transition-colors hover:bg-slate-700 cursor-pointer"
                >
                  {importingTo === 'studio' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Eraser className="h-3.5 w-3.5 text-rose-400" />
                  )}
                  <span>
                    {result.directMediaSupported
                      ? 'Send to Watermark Studio'
                      : 'Open Demo Clip in Studio'}
                  </span>
                </button>

                {result.directMediaSupported && (
                  <button
                    type="button"
                    onClick={() => void handleImportDirectMedia('clipper')}
                    disabled={importingTo !== null}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-100 transition-colors hover:bg-slate-700 cursor-pointer"
                  >
                    {importingTo === 'clipper' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Scissors className="h-3.5 w-3.5 text-rose-400" />
                    )}
                    <span>Clip Best Moments</span>
                  </button>
                )}

                {result.videoId && (
                  <button
                    type="button"
                    onClick={() => void handleDownloadThumbnail()}
                    disabled={downloadingThumb}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-100 transition-colors hover:bg-slate-700 cursor-pointer"
                  >
                    {downloadingThumb ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ImageDown className="h-3.5 w-3.5 text-slate-400" />
                    )}
                    <span>Save Thumbnail JPG</span>
                  </button>
                )}
              </div>
            </div>

            <div className="lg:col-span-7">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
                <span className="text-slate-100">{result.platform}</span>
                <span aria-hidden="true">·</span>
                <span>{result.author}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{result.aspect}</span>
              </div>
              <h3 className="mt-1.5 text-lg font-bold text-white [text-wrap:balance]">
                {result.title}
              </h3>

              <div className="mt-4 divide-y divide-slate-800 rounded-lg border border-slate-800 bg-[#0D121D]">
                {result.formats.map((fmt) => {
                  const isBusy = downloadingFormatId === fmt.id;
                  return (
                    <div
                      key={fmt.id}
                      className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-slate-800/40"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        {fmt.type === 'audio' ? (
                          <Music className="h-4 w-4 shrink-0 text-slate-400" />
                        ) : (
                          <Film className="h-4 w-4 shrink-0 text-slate-400" />
                        )}
                        <div className="flex items-center gap-2 truncate">
                          <span className="font-semibold text-white">{fmt.label}</span>
                          <span className="text-xs text-slate-400">
                            {fmt.container} · {fmt.codec}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 shrink-0">
                        <span className="hidden font-mono text-xs text-slate-400 sm:inline">
                          {fmt.estimatedSize}
                        </span>
                        <button
                          type="button"
                          disabled={downloadingFormatId !== null}
                          onClick={() => void handleDownloadFormat(fmt)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-rose-500 disabled:opacity-60 whitespace-nowrap cursor-pointer"
                        >
                          {isBusy ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              <span>Saving...</span>
                            </>
                          ) : (
                            <>
                              <Download className="h-3.5 w-3.5" />
                              <span>Save {fmt.container}</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {localFallback && (
                <div className="mt-4 rounded-xl border border-slate-800 bg-[#0D121D] p-4 space-y-3">
                  <div>
                    <h4 className="text-xs font-bold text-white">
                      YouTube restricts cloud server MP4 downloads ({localFallback.formatLabel})
                    </h4>
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">
                      YouTube blocks automated video extraction from hosted cloud servers. To save an
                      MP4 right now, paste any direct <span className="font-mono text-slate-300">.mp4 / .mov / .webm</span>{' '}
                      link above, or upload a local video file to convert to MP4 and erase watermarks.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={localFileInputRef}
                      type="file"
                      accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv,.m4v"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleLocalFilePicked(file);
                        e.target.value = '';
                      }}
                    />
                    <button
                      type="button"
                      disabled={uploadingLocal}
                      onClick={() => localFileInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-60 cursor-pointer"
                    >
                      {uploadingLocal ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Upload className="h-3.5 w-3.5" />
                      )}
                      <span>Upload Video to Save as MP4</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setShowCliDetails((v) => !v)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700 cursor-pointer"
                    >
                      <Terminal className="h-3.5 w-3.5 text-slate-400" />
                      <span>{showCliDetails ? 'Hide CLI Command' : 'Use Local yt-dlp Command'}</span>
                    </button>
                  </div>

                  {showCliDetails && (
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-700 bg-[#090D16] px-3 py-2">
                      <code className="overflow-x-auto whitespace-nowrap font-mono text-xs text-slate-200">
                        {localFallback.command}
                      </code>
                      <button
                        type="button"
                        onClick={() => void handleCopyCommand()}
                        className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 shrink-0 cursor-pointer"
                      >
                        {copiedCommand ? (
                          <>
                            <Check className="h-3.5 w-3.5" />
                            <span>Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            <span>Copy</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
