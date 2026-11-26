import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Eraser, Film, Link2, Scissors, Settings } from 'lucide-react';
import { LinkDownloader } from './components/LinkDownloader';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import { SettingsModal } from './components/SettingsModal';
import { VideoClipper } from './components/VideoClipper';
import { WatermarkStudio } from './components/WatermarkStudio';
import type { BatchClipItem, LoadedVideo, SampleClip, StudioSettings } from './types/media';
import {
  AUTO_CLEANUP_MAX_AGE_MS,
  STORAGE_UPDATED_EVENT,
  cleanupExpiredClips,
  loadSettings,
  saveSettings,
} from './utils/clipStorage';

type WorkbenchTab = 'studio' | 'clipper' | 'downloader';

interface FormatSpec {
  format: string;
  codec: string;
  maxResolution: string;
  bitrate: string;
  watermarkEngine: string;
}

const FORMAT_SPECS: FormatSpec[] = [
  {
    format: 'MP4 Video',
    codec: 'H.264 + AAC',
    maxResolution: '2160p 4K',
    bitrate: '18,000 kbps',
    watermarkEngine: 'Delogo Inpaint / Blur / Crop',
  },
  {
    format: 'ProRes 422',
    codec: 'Apple ProRes 422 (MOV)',
    maxResolution: '2160p 4K',
    bitrate: '50,000 kbps',
    watermarkEngine: 'Delogo Inpaint / Blur / Crop',
  },
  {
    format: 'WebM Video',
    codec: 'VP9 + Opus',
    maxResolution: '1080p Full HD',
    bitrate: '8,500 kbps',
    watermarkEngine: 'Delogo Inpaint / Blur / Crop',
  },
  {
    format: 'MP3 Audio',
    codec: 'MPEG-1 Layer 3',
    maxResolution: 'Audio Only',
    bitrate: '320 kbps',
    watermarkEngine: 'Stream Strip & Trim',
  },
  {
    format: 'GIF Loop',
    codec: 'Lanczos Palette',
    maxResolution: '640p @ 15 fps',
    bitrate: 'Variable',
    watermarkEngine: 'Delogo Inpaint / Mosaic',
  },
];

const WORKBENCH_TABS: Array<{
  id: WorkbenchTab;
  label: string;
  hint: string;
}> = [
  {
    id: 'studio',
    label: 'Watermark Studio',
    hint: 'Erase corner logos with live split-screen scrubbing',
  },
  {
    id: 'clipper',
    label: 'Video Clipper',
    hint: 'Find best highlight moments or split long recordings',
  },
  {
    id: 'downloader',
    label: 'Link Downloader',
    hint: 'Inspect video links and save MP4, WebM, or MP3 files',
  },
];

const FAQ_ITEMS = [
  {
    q: 'How does the video watermark remover erase logos without cropping?',
    a: 'Place or one-click snap a mask over any watermark area on the video canvas. ClearReel applies bilinear spatial interpolation (FFmpeg delogo) from surrounding clean edge pixels so logos blend seamlessly into moving backgrounds while keeping your full frame intact.',
  },
  {
    q: 'How does AI Best Moments clipping pick highlights?',
    a: 'Inside the Video Clipper tab, Find Best Moments analyzes both visual scene changes and spoken audio to locate natural 5s to 45s highlight windows. Moments load into the Clip Queue with relevance scores and reasons so you can preview or adjust timestamps before cutting.',
  },
  {
    q: 'What video formats and file sizes are supported?',
    a: 'Upload local MP4, MOV, WebM, MKV, and M4V files up to 500 MB (large files stream in automatic chunks), or export directly in H.264 MP4, Apple ProRes 422 MOV, VP9 WebM, 320 kbps MP3 audio, or GIF loops.',
  },
  {
    q: 'How do I install ClearReel as an app on desktop or mobile?',
    a: 'Click Install App in the top navigation bar. On Chrome, Edge, or Android it installs as a standalone app window; on iPhone and iPad follow the two-step Safari Add to Home Screen prompt.',
  },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('studio');
  const [samples, setSamples] = useState<SampleClip[]>([]);
  const [queue, setQueue] = useState<BatchClipItem[]>([]);
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const [clipperSource, setClipperSource] = useState<LoadedVideo | null>(null);
  const [extraLoadedVideos, setExtraLoadedVideos] = useState<LoadedVideo[]>([]);
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [heroPhotoFailed, setHeroPhotoFailed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<StudioSettings>(() => loadSettings());

  const pruneExpiredFromQueue = useCallback((expiredOutputIds: string[]) => {
    const expiredSet = new Set(expiredOutputIds);
    const now = Date.now();
    setQueue((prev) =>
      prev.map((item) => {
        if (item.status !== 'done' || !item.result) return item;
        const isExpiredId = expiredSet.has(item.result.outputId);
        const isExpiredAge =
          typeof item.result.processedAt === 'number' &&
          now - item.result.processedAt >= AUTO_CLEANUP_MAX_AGE_MS;
        if (!isExpiredId && !isExpiredAge) return item;
        return {
          ...item,
          status: 'queued',
          progress: 0,
          stage: 'Waiting in queue',
          result: undefined,
        };
      })
    );
  }, []);

  useEffect(() => {
    const syncSettings = () => {
      setSettings(loadSettings());
    };
    window.addEventListener(STORAGE_UPDATED_EVENT, syncSettings);
    return () => {
      window.removeEventListener(STORAGE_UPDATED_EVENT, syncSettings);
    };
  }, []);

  useEffect(() => {
    if (!settings.autoCleanup) return;

    const runCleanup = async () => {
      const outcome = await cleanupExpiredClips(AUTO_CLEANUP_MAX_AGE_MS);
      if (outcome.expiredOutputIds.length > 0) {
        pruneExpiredFromQueue(outcome.expiredOutputIds);
      }
    };

    void runCleanup();
    const timer = window.setInterval(() => {
      void runCleanup();
    }, 60 * 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [settings.autoCleanup, pruneExpiredFromQueue]);

  const handleToggleAutoCleanup = (enabled: boolean) => {
    const updated = saveSettings({
      ...settings,
      autoCleanup: enabled,
    });
    setSettings(updated);
    if (enabled) {
      void cleanupExpiredClips(AUTO_CLEANUP_MAX_AGE_MS).then((outcome) => {
        if (outcome.expiredOutputIds.length > 0) {
          pruneExpiredFromQueue(outcome.expiredOutputIds);
        }
      });
    }
  };

  const buildSampleQueueItem = (sample: SampleClip): BatchClipItem => ({
    id: `sample_${sample.id}`,
    video: {
      sourceType: 'sample',
      sourceId: sample.filename,
      title: sample.title,
      previewUrl: `/api/samples/${sample.filename}`,
      width: sample.width,
      height: sample.height,
      duration: sample.duration,
      fps: 30,
      hasAudio: true,
    },
    regions: [
      {
        id: `sample_reg_${sample.id}`,
        ...sample.defaultRegion,
      },
    ],
    cropMarginPercent: 0,
    trimStart: 0,
    trimEnd: sample.duration,
    outputFormat: 'mp4',
    resolution: 'original',
    status: 'queued',
    progress: 0,
    stage: 'Waiting in queue',
  });

  const selectSample = (sample: SampleClip) => {
    const sampleItemId = `sample_${sample.id}`;
    setQueue((prev) => {
      if (prev.some((item) => item.id === sampleItemId)) {
        return prev;
      }
      return [...prev, buildSampleQueueItem(sample)];
    });
    setActiveClipId(sampleItemId);
  };

  const queueAllSamples = () => {
    if (!samples.length) return;
    setQueue((prev) => {
      const existingIds = new Set(prev.map((item) => item.id));
      const additions = samples
        .filter((s) => !existingIds.has(`sample_${s.id}`))
        .map(buildSampleQueueItem);
      return [...prev, ...additions];
    });
    setActiveClipId(`sample_${samples[0].id}`);
  };

  useEffect(() => {
    let mounted = true;
    fetch('/api/samples')
      .then((res) => res.json())
      .then((data: { samples?: SampleClip[] }) => {
        if (!mounted || !data.samples?.length) return;
        setSamples(data.samples);
        const first = buildSampleQueueItem(data.samples[0]);
        setQueue([first]);
        setActiveClipId(first.id);
        setClipperSource(first.video);
      })
      .catch(() => {
        // Ignore if samples endpoint unavailable
      });

    return () => {
      mounted = false;
    };
  }, []);

  const handleLoadIntoStudio = (video: LoadedVideo) => {
    const newClipId = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newItem: BatchClipItem = {
      id: newClipId,
      video,
      regions: [
        {
          id: `reg_${newClipId}`,
          x: Math.round(video.width * 0.72),
          y: Math.round(video.height * 0.82),
          w: Math.round(video.width * 0.22),
          h: Math.round(video.height * 0.1),
          mode: 'delogo',
        },
      ],
      cropMarginPercent: 0,
      trimStart: 0,
      trimEnd: Math.round((video.duration || 0) * 10) / 10,
      outputFormat: 'mp4',
      resolution: 'original',
      status: 'queued',
      progress: 0,
      stage: 'Waiting in queue',
    };
    setQueue((prev) => [...prev, newItem]);
    setActiveClipId(newClipId);
    setActiveTab('studio');
    document.getElementById('workbench')?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleLoadIntoClipper = (video: LoadedVideo) => {
    setClipperSource(video);
    setExtraLoadedVideos((prev) =>
      prev.some((v) => v.sourceType === video.sourceType && v.sourceId === video.sourceId)
        ? prev
        : [video, ...prev]
    );
    setActiveTab('clipper');
    document.getElementById('workbench')?.scrollIntoView({ behavior: 'smooth' });
  };

  const navigateToTab = (tab: WorkbenchTab) => {
    setActiveTab(tab);
    document.getElementById('workbench')?.scrollIntoView({ behavior: 'smooth' });
  };

  const activeTabMeta = WORKBENCH_TABS.find((t) => t.id === activeTab) || WORKBENCH_TABS[0];

  return (
    <div className="min-h-screen bg-[#090D16] text-slate-100">
      {/* Top Bar Contract: 3 clean zones separated by gap-8 */}
      <header className="sticky top-0 z-40 border-b border-slate-800/90 bg-[#090D16]/92 backdrop-blur-xs">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-8 px-4 py-3 sm:px-6">
          <a
            href="#top"
            className="font-display text-xl font-extrabold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            ClearReel
          </a>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-400">
            <a
              href="#workbench"
              onClick={(e) => {
                e.preventDefault();
                navigateToTab('studio');
              }}
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Studio
            </a>
            <a
              href="#workbench"
              onClick={(e) => {
                e.preventDefault();
                navigateToTab('clipper');
              }}
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Clipper
            </a>
            <a
              href="#workbench"
              onClick={(e) => {
                e.preventDefault();
                navigateToTab('downloader');
              }}
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Downloader
            </a>
            <a
              href="#formats"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Formats
            </a>
            <a
              href="#faq"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              FAQ
            </a>
          </nav>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Open Studio Settings"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#111622] px-3 py-2 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800 hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Settings className="h-4 w-4 text-slate-400 shrink-0" />
              <span className="hidden sm:inline">Settings</span>
            </button>
            <PWAInstallButton />
          </div>
        </div>
      </header>

      <main id="top">
        {/* Focused Dark Studio Hero & Unified Workbench */}
        <section id="workbench" className="mx-auto max-w-7xl px-4 pt-6 pb-14 sm:px-6 lg:pt-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <h1 className="font-display text-[clamp(1.85rem,3.2vw,2.75rem)] font-extrabold leading-[1.1] tracking-tight text-white [text-wrap:balance]">
                Clean watermarks, clip highlights, and export in seconds
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-slate-400 sm:text-base">
                {activeTabMeta.hint}. Export cleanly in MP4, ProRes 422, WebM, MP3, or GIF.
              </p>
            </div>

            {/* Interactive Mode Switcher */}
            <div
              role="tablist"
              aria-label="ClearReel workspace tools"
              className="inline-flex w-full overflow-x-auto rounded-xl border border-slate-800 bg-[#111622] p-1 sm:w-auto shrink-0"
            >
              {WORKBENCH_TABS.map((tab) => {
                const isSelected = activeTab === tab.id;
                const Icon = tab.id === 'studio' ? Eraser : tab.id === 'clipper' ? Scissors : Link2;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    onClick={() => setActiveTab(tab.id)}
                    className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer sm:flex-initial ${
                      isSelected
                        ? 'bg-rose-600 text-white'
                        : 'text-slate-400 hover:bg-slate-800/80 hover:text-slate-100'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-5">
            {activeTab === 'studio' ? (
              <WatermarkStudio
                samples={samples}
                queue={queue}
                setQueue={setQueue}
                activeClipId={activeClipId}
                setActiveClipId={setActiveClipId}
                onSelectSample={selectSample}
                onQueueAllSamples={queueAllSamples}
                onSendToClipper={handleLoadIntoClipper}
              />
            ) : activeTab === 'clipper' ? (
              <VideoClipper
                sourceVideo={clipperSource || queue.find((q) => q.id === activeClipId)?.video || queue[0]?.video || null}
                availableVideos={[
                  ...extraLoadedVideos,
                  ...queue.map((q) => q.video),
                ].filter(
                  (vid, index, arr) =>
                    arr.findIndex((v) => v.sourceType === vid.sourceType && v.sourceId === vid.sourceId) === index
                )}
                samples={samples}
                onSelectSourceVideo={(video) => {
                  setClipperSource(video);
                  setExtraLoadedVideos((prev) =>
                    prev.some((v) => v.sourceType === video.sourceType && v.sourceId === video.sourceId)
                      ? prev
                      : [video, ...prev]
                  );
                }}
                onSelectSample={(sample) => {
                  const item = buildSampleQueueItem(sample);
                  setClipperSource(item.video);
                }}
                onSendClipToStudio={handleLoadIntoStudio}
              />
            ) : (
              <LinkDownloader
                onLoadIntoStudio={handleLoadIntoStudio}
                onLoadIntoClipper={handleLoadIntoClipper}
                onLoadDemoClip={() => {
                  if (samples[0]) selectSample(samples[0]);
                  setActiveTab('studio');
                }}
              />
            )}
          </div>
        </section>

        {/* Capabilities Bento & Editorial Visual Showcase */}
        <section className="border-t border-slate-800/80 bg-[#0D121D] py-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6">
            <div className="grid gap-10 lg:grid-cols-12 lg:items-stretch">
              <div className="lg:col-span-7">
                <div className="relative h-full min-h-[300px] overflow-hidden rounded-xl border border-slate-800 bg-[#070A10]">
                  {!heroPhotoFailed ? (
                    <img
                      src="/src/assets/images/hero_studio_preview_1795560346642.jpg"
                      alt="ClearReel desktop editing station displaying clean coastal footage"
                      referrerPolicy="no-referrer"
                      onError={() => setHeroPhotoFailed(true)}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3 p-8 text-slate-300">
                      <Film className="h-10 w-10 text-rose-500" />
                      <p className="text-sm font-medium">ClearReel Video Workstation</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="lg:col-span-5 flex flex-col justify-between divide-y divide-slate-800">
                <div className="pb-5">
                  <h2 className="font-display text-2xl font-bold tracking-tight text-white">
                    Built for clean creator &amp; production footage
                  </h2>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">
                    Every export preserves native frame rates and audio sync—from lightweight web
                    MP4s to 50,000 kbps ProRes 422 masters.
                  </p>
                </div>

                <div className="py-4">
                  <h3 className="text-sm font-bold text-slate-100">01. One-Click Masking &amp; Split Scrubbing</h3>
                  <p className="mt-1 text-sm text-slate-400">
                    Snap masks to any corner or draw custom regions, then drag the split divider
                    during playback to verify clean reconstruction.
                  </p>
                </div>

                <div className="py-4">
                  <h3 className="text-sm font-bold text-slate-100">02. AI Highlight Detection &amp; Batch Queue</h3>
                  <p className="mt-1 text-sm text-slate-400">
                    Isolate natural best moments from long videos or stack up to 10 clips for
                    sequential background watermark removal.
                  </p>
                </div>

                <div className="pt-4">
                  <h3 className="text-sm font-bold text-slate-100">03. Production ProRes 422 &amp; Web Exports</h3>
                  <p className="mt-1 text-sm text-slate-400">
                    Render high-bitrate Apple ProRes 422 MOV masters for NLE timelines alongside
                    compact H.264 MP4, VP9 WebM, and 320k MP3 audio.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Supported Formats & Codecs Table */}
        <section id="formats" className="border-t border-slate-800/80 bg-[#090D16] py-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <h2 className="font-display text-2xl font-bold tracking-tight text-white">
                  Export Formats &amp; Processing Matrix
                </h2>
                <p className="mt-1.5 text-sm text-slate-400">
                  Hardware-accelerated FFmpeg presets tuned for web delivery and ProRes 422 production editing.
                </p>
              </div>
              <button
                type="button"
                onClick={() => navigateToTab('studio')}
                className="self-start rounded-lg border border-slate-700 bg-[#111622] px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Open Watermark Studio
              </button>
            </div>

            <div className="mt-6 overflow-x-auto rounded-xl border border-slate-800 bg-[#111622]">
              <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-800 bg-[#161C2C] text-xs font-semibold text-slate-300">
                    <th className="px-5 py-3.5">Container</th>
                    <th className="px-5 py-3.5">Codec</th>
                    <th className="px-5 py-3.5">Max Output</th>
                    <th className="px-5 py-3.5 text-right">Target Bitrate</th>
                    <th className="px-5 py-3.5">Watermark Tools</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {FORMAT_SPECS.map((row) => (
                    <tr key={row.format} className="hover:bg-slate-800/40">
                      <td className="px-5 py-3.5 font-semibold text-white">{row.format}</td>
                      <td className="px-5 py-3.5 text-slate-300">{row.codec}</td>
                      <td className="px-5 py-3.5 font-mono text-xs text-slate-300">{row.maxResolution}</td>
                      <td className="px-5 py-3.5 text-right font-mono text-xs text-slate-300 tabular-nums">
                        {row.bitrate}
                      </td>
                      <td className="px-5 py-3.5 text-slate-400">{row.watermarkEngine}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* 3-Step Guide */}
        <section id="workflow" className="border-t border-slate-800/80 bg-[#0D121D] py-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6">
            <h2 className="font-display text-2xl font-bold tracking-tight text-white">
              How ClearReel Works
            </h2>

            <div className="mt-8 grid gap-8 md:grid-cols-3">
              <div className="border-t border-slate-800 pt-5">
                <p className="font-mono text-xs font-semibold text-rose-500">01</p>
                <h3 className="mt-2 text-base font-bold text-white">
                  Upload footage or paste a media link
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  Drop MP4, MOV, or WebM clips up to 500 MB directly into the workspace, or inspect
                  direct video and YouTube URLs to extract clean formats.
                </p>
              </div>

              <div className="border-t border-slate-800 pt-5">
                <p className="font-mono text-xs font-semibold text-rose-500">02</p>
                <h3 className="mt-2 text-base font-bold text-white">
                  Mask logos or isolate best moments
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  Snap mask boxes to watermarked corners with live split-screen scrubbing, or let
                  AI Best Moments surface the top scenes in long recordings.
                </p>
              </div>

              <div className="border-t border-slate-800 pt-5">
                <p className="font-mono text-xs font-semibold text-rose-500">03</p>
                <h3 className="mt-2 text-base font-bold text-white">
                  Batch export in web or ProRes 422
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  Render single clips or sequential batch queues in MP4, ProRes 422 MOV, WebM,
                  320k MP3, or GIF and download directly to your device.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ Accordion */}
        <section id="faq" className="border-t border-slate-800/80 bg-[#090D16] py-16">
          <div className="mx-auto max-w-3xl px-4 sm:px-6">
            <h2 className="font-display text-2xl font-bold tracking-tight text-white">
              Frequently Asked Questions
            </h2>

            <div className="mt-6 divide-y divide-slate-800 rounded-xl border border-slate-800 bg-[#111622]">
              {FAQ_ITEMS.map((item, idx) => {
                const isOpen = openFaq === idx;
                return (
                  <div key={item.q}>
                    <button
                      type="button"
                      onClick={() => setOpenFaq(isOpen ? null : idx)}
                      aria-expanded={isOpen}
                      className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left text-sm font-semibold text-slate-100 hover:bg-slate-800/50 cursor-pointer"
                    >
                      <span>{item.q}</span>
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-150 ${
                          isOpen ? 'rotate-180' : ''
                        }`}
                      />
                    </button>
                    {isOpen && (
                      <div className="px-5 pb-4 text-sm leading-relaxed text-slate-400">
                        {item.a}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </main>

      {/* Quiet Footer */}
      <footer className="border-t border-slate-800 bg-[#070A10] py-8">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-4 px-4 text-xs text-slate-400 sm:flex-row sm:items-center sm:px-6">
          <div className="flex items-center gap-3">
            <span className="font-display text-sm font-bold text-white">ClearReel</span>
            <span aria-hidden="true">·</span>
            <span>Video Downloader, Clipper &amp; Watermark Studio</span>
          </div>

          <div className="flex items-center gap-5">
            <a href="#workbench" onClick={(e) => { e.preventDefault(); navigateToTab('studio'); }} className="hover:text-white">
              Studio
            </a>
            <a href="#workbench" onClick={(e) => { e.preventDefault(); navigateToTab('clipper'); }} className="hover:text-white">
              Clipper
            </a>
            <a href="#workbench" onClick={(e) => { e.preventDefault(); navigateToTab('downloader'); }} className="hover:text-white">
              Downloader
            </a>
            <a href="#formats" className="hover:text-white">
              Formats
            </a>
            <a href="#faq" className="hover:text-white">
              FAQ
            </a>
          </div>
        </div>
      </footer>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onToggleAutoCleanup={handleToggleAutoCleanup}
        onPruneExpiredFromState={pruneExpiredFromQueue}
      />
      <OfflineIndicator />
    </div>
  );
}
