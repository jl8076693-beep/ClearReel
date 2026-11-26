import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { GoogleGenAI, Type, createPartFromUri, createUserContent } from '@google/genai';
import dotenv from 'dotenv';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';

dotenv.config();

const execFileAsync = promisify(execFile);

const ROOT_DIR = process.cwd();
const TMP_DIR = path.resolve(ROOT_DIR, 'tmp_media');
const SAMPLES_DIR = path.resolve(ROOT_DIR, 'samples');
const DIST_DIR = path.resolve(ROOT_DIR, 'dist');
const PORT = process.env.NODE_ENV === 'production' ? Number(process.env.PORT) || 3000 : 3000;

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(SAMPLES_DIR, { recursive: true });

interface SampleItem {
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
    mode: 'delogo' | 'blur' | 'pixelate';
  };
}

const SAMPLE_LIBRARY: SampleItem[] = [
  {
    id: 'coastal-drone',
    filename: 'coastal_drone_watermarked.mp4',
    title: 'Coastal Highway Drone',
    subtitle: 'Bottom-right corner watermark · 720p H.264',
    thumbnail: '/src/assets/images/sample_thumb_travel_1795560346730.jpg',
    width: 1280,
    height: 720,
    duration: 6,
    defaultRegion: { x: 954, y: 618, w: 292, h: 72, mode: 'delogo' },
  },
  {
    id: 'studio-headphones',
    filename: 'studio_headphones_watermarked.mp4',
    title: 'Studio Headphones Review',
    subtitle: 'Top-left badge watermark · 720p H.264',
    thumbnail: '/src/assets/images/sample_thumb_product_1795560347137.jpg',
    width: 1280,
    height: 720,
    duration: 6,
    defaultRegion: { x: 34, y: 34, w: 302, h: 68, mode: 'delogo' },
  },
];

const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi']);
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

function safeResolveInDir(baseDir: string, fileName: string): string | null {
  if (!SAFE_ID_PATTERN.test(fileName)) return null;
  const resolved = path.resolve(baseDir, fileName);
  if (!resolved.startsWith(baseDir + path.sep)) return null;
  return resolved;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fe80:') ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('::ffff:127.') ||
      lower.startsWith('::ffff:10.') ||
      lower.startsWith('::ffff:192.168.') ||
      lower.startsWith('::ffff:169.254.')
    ) {
      return true;
    }
    return false;
  }
  return true;
}

async function assertSafeExternalUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid URL format. Include https:// or http://.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Local or internal hostnames are not permitted.');
  }

  if (net.isIP(hostname) !== 0) {
    if (isPrivateIp(hostname)) {
      throw new Error('Private IP addresses are not permitted.');
    }
    return parsed;
  }

  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records.length || records.some((rec) => isPrivateIp(rec.address))) {
      throw new Error('Destination host resolved to a restricted network range.');
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('restricted')) {
      throw err;
    }
    // Allow DNS resolution failures to be surfaced gracefully by fetch timeout if sandboxed
  }

  return parsed;
}

function extractYouTubeId(urlObj: URL): string | null {
  const host = urlObj.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = urlObj.pathname.slice(1).split('/')[0];
    return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const v = urlObj.searchParams.get('v');
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
    const parts = urlObj.pathname.split('/').filter(Boolean);
    if ((parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') && parts[1]) {
      return /^[a-zA-Z0-9_-]{11}$/.test(parts[1]) ? parts[1] : null;
    }
  }
  return null;
}

interface ProbeInfo {
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
  codec: string;
  pixFmt?: string;
  audioCodec?: string;
}

async function probeMediaFile(filePath: string): Promise<ProbeInfo> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { shell: false, timeout: 15000 }
  );
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      pix_fmt?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }>;
  };
  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');

  let fps = 30;
  if (videoStream?.r_frame_rate) {
    const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
    if (num > 0 && den > 0) fps = Math.round((num / den) * 100) / 100;
  }

  return {
    width: videoStream?.width || 1280,
    height: videoStream?.height || 720,
    duration: Number(parsed.format?.duration) || 0,
    fps,
    hasAudio: Boolean(audioStream),
    codec: videoStream?.codec_name || 'h264',
    pixFmt: videoStream?.pix_fmt,
    audioCodec: audioStream?.codec_name,
  };
}

const previewTranscodeJobs = new Map<string, Promise<string>>();

function isBrowserPlayableMedia(filePath: string, probe: ProbeInfo): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.mp4' && ext !== '.webm') return false;

  const codec = (probe.codec || '').toLowerCase();
  if (ext === '.mp4') {
    if (!['h264', 'vp8', 'vp9', 'av1'].includes(codec)) return false;
    if (codec === 'h264' && probe.pixFmt && !['yuv420p', 'yuvj420p'].includes(probe.pixFmt)) {
      return false;
    }
    if (probe.hasAudio && probe.audioCodec && !['aac', 'mp3', 'opus', 'flac'].includes(probe.audioCodec)) {
      return false;
    }
    return true;
  }

  if (ext === '.webm') {
    if (!['vp8', 'vp9', 'av1'].includes(codec)) return false;
    if (probe.hasAudio && probe.audioCodec && !['opus', 'vorbis'].includes(probe.audioCodec)) {
      return false;
    }
    return true;
  }

  return false;
}

async function ensureBrowserPreviewFile(fileId: string, filePath: string, probe?: ProbeInfo): Promise<string> {
  const info = probe ?? (await probeMediaFile(filePath));
  if (isBrowserPlayableMedia(filePath, info)) {
    return fileId;
  }

  const baseName = fileId.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const prevId = `prev_${baseName}.mp4`;
  const prevPath = safeResolveInDir(TMP_DIR, prevId);
  if (!prevPath) return fileId;
  if (fs.existsSync(prevPath)) return prevId;

  const existing = previewTranscodeJobs.get(fileId);
  if (existing) return existing;

  const task = (async () => {
    try {
      const args = [
        '-y',
        '-i',
        filePath,
        '-vf',
        "scale='min(1280,iw)':-2",
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '24',
        '-pix_fmt',
        'yuv420p',
        '-threads',
        '0',
      ];
      if (info.hasAudio) {
        args.push('-c:a', 'aac', '-b:a', '128k');
      } else {
        args.push('-an');
      }
      args.push('-movflags', '+faststart', prevPath);
      await execFileAsync('ffmpeg', args, { shell: false, timeout: 180000 });
      return prevId;
    } catch {
      fs.unlink(prevPath, () => {});
      return fileId;
    } finally {
      previewTranscodeJobs.delete(fileId);
    }
  })();

  previewTranscodeJobs.set(fileId, task);
  return task;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TMP_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = ALLOWED_VIDEO_EXTENSIONS.has(ext) ? ext : '.mp4';
      const id = `src_${crypto.randomBytes(8).toString('hex')}${safeExt}`;
      cb(null, id);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_VIDEO_EXTENSIONS.has(ext) || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Upload MP4, MOV, WebM, MKV, or M4V video.'));
    }
  },
});

function cleanupOldTempFiles() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const activePaths = new Set<string>();
  for (const job of processJobs.values()) {
    if (job.status === 'processing') {
      if (job.outputPath) activePaths.add(job.outputPath);
      if (job.inputPath) activePaths.add(job.inputPath);
    }
  }
  fs.readdir(TMP_DIR, (err, files) => {
    if (err) return;
    for (const file of files) {
      const target = safeResolveInDir(TMP_DIR, file);
      if (!target || activePaths.has(target)) continue;
      fs.stat(target, (statErr, stats) => {
        if (!statErr && stats.mtimeMs < cutoff) {
          fs.unlink(target, () => {});
        }
      });
    }
  });
  for (const [jobId, job] of processJobs.entries()) {
    if (job.status !== 'processing' && job.updatedAt < cutoff) {
      processJobs.delete(jobId);
    }
  }
  for (const [uploadId, sess] of uploadSessions.entries()) {
    if (sess.createdAt < cutoff) {
      fs.unlink(sess.partPath, () => {});
      uploadSessions.delete(uploadId);
    }
  }
}

setInterval(cleanupOldTempFiles, 10 * 60 * 1000).unref();

const app = express();
app.use(express.json({ limit: '2mb' }));

// List bundled watermarked sample clips
app.get('/api/samples', (_req: Request, res: Response) => {
  const available = SAMPLE_LIBRARY.filter((item) => {
    const resolved = safeResolveInDir(SAMPLES_DIR, item.filename);
    return resolved !== null && fs.existsSync(resolved);
  });
  res.json({ samples: available });
});

app.get('/api/samples/:filename', (req: Request, res: Response) => {
  const filename = String(req.params.filename || '');
  const entry = SAMPLE_LIBRARY.find((item) => item.filename === filename);
  if (!entry) {
    res.status(404).json({ error: 'Sample clip not found.' });
    return;
  }
  const resolved = safeResolveInDir(SAMPLES_DIR, entry.filename);
  if (!resolved || !fs.existsSync(resolved)) {
    res.status(404).json({ error: 'Sample clip file unavailable.' });
    return;
  }
  res.sendFile(resolved);
});

function matchAllowlistedSample(rawUrl: string): SampleItem | null {
  const prefix = '/api/samples/';
  if (rawUrl.startsWith(prefix)) {
    const filename = rawUrl.slice(prefix.length).split('?')[0];
    return SAMPLE_LIBRARY.find((item) => item.filename === filename) || null;
  }
  return null;
}

async function probeRemoteMedia(parsedUrl: URL): Promise<{
  reachable: boolean;
  contentType: string;
  contentLength: number;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const headRes = await fetch(parsedUrl.toString(), {
      method: 'HEAD',
      signal: controller.signal,
    });
    if (headRes.ok) {
      const contentType = (headRes.headers.get('content-type') || '').toLowerCase();
      const contentLength = Number(headRes.headers.get('content-length') || 0);
      return { reachable: true, contentType, contentLength };
    }
  } catch {
    // Fall through to Range GET check
  } finally {
    clearTimeout(timer);
  }

  const getController = new AbortController();
  const getTimer = setTimeout(() => getController.abort(), 6000);
  try {
    const getRes = await fetch(parsedUrl.toString(), {
      method: 'GET',
      headers: { Range: 'bytes=0-2047' },
      signal: getController.signal,
    });
    if (getRes.ok || getRes.status === 206) {
      const contentType = (getRes.headers.get('content-type') || '').toLowerCase();
      const contentRange = getRes.headers.get('content-range') || '';
      const totalMatch = contentRange.match(/\/(\d+)$/);
      const contentLength = totalMatch
        ? Number(totalMatch[1])
        : Number(getRes.headers.get('content-length') || 0);
      await getRes.body?.cancel();
      return { reachable: true, contentType, contentLength };
    }
  } catch {
    // Unreachable
  } finally {
    clearTimeout(getTimer);
  }

  return { reachable: false, contentType: '', contentLength: 0 };
}

async function fetchExternalVideoToTemp(parsedUrl: URL): Promise<{
  filePath: string;
  fileId: string;
  filename: string;
  sizeBytes: number;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const upstream = await fetch(parsedUrl.toString(), { signal: controller.signal });
  clearTimeout(timer);

  if (!upstream.ok || !upstream.body) {
    throw new Error('Could not download remote video stream.');
  }

  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  if (
    !contentType.startsWith('video/') &&
    !contentType.startsWith('audio/') &&
    !contentType.includes('octet-stream')
  ) {
    throw new Error('Remote URL did not return a valid video or audio stream.');
  }

  const extMatch = path.extname(parsedUrl.pathname).toLowerCase();
  const safeExt = ALLOWED_VIDEO_EXTENSIONS.has(extMatch) ? extMatch : '.mp4';
  const fileId = `src_${crypto.randomBytes(8).toString('hex')}${safeExt}`;
  const targetPath = safeResolveInDir(TMP_DIR, fileId);
  if (!targetPath) {
    throw new Error('Storage path error.');
  }

  const maxBytes = 150 * 1024 * 1024;
  const arrayBuffer = await upstream.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new Error('Remote video exceeds 150 MB limit.');
  }

  await fs.promises.writeFile(targetPath, Buffer.from(arrayBuffer));
  return {
    filePath: targetPath,
    fileId,
    filename: path.basename(parsedUrl.pathname) || `video${safeExt}`,
    sizeBytes: arrayBuffer.byteLength,
  };
}

// Safe thumbnail download proxy restricted strictly to i.ytimg.com and 11-char video IDs
app.get('/api/youtube-thumbnail/:videoId', async (req: Request, res: Response) => {
  const videoId = String(req.params.videoId || '');
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.status(400).json({ error: 'Invalid YouTube video ID.' });
    return;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let upstream = await fetch(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, {
      signal: controller.signal,
    });
    if (!upstream.ok) {
      upstream = await fetch(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, {
        signal: controller.signal,
      });
    }
    clearTimeout(timer);

    if (!upstream.ok) {
      res.status(404).json({ error: 'Thumbnail not available.' });
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', `attachment; filename="youtube-${videoId}.jpg"`);
    res.send(buffer);
  } catch {
    res.status(502).json({ error: 'Unable to fetch YouTube thumbnail.' });
  }
});

// Inspect pasted URL (Sample clip, YouTube, Shorts, or direct MP4/WebM/MOV media URL)
app.post('/api/inspect-url', async (req: Request, res: Response) => {
  const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!rawUrl) {
    res.status(400).json({ error: 'Please paste a video link to analyze.' });
    return;
  }

  const sampleEntry = matchAllowlistedSample(rawUrl);
  if (sampleEntry) {
    const samplePath = safeResolveInDir(SAMPLES_DIR, sampleEntry.filename);
    const sizeBytes = samplePath && fs.existsSync(samplePath) ? fs.statSync(samplePath).size : 1048576;
    res.json({
      platform: 'Direct Video',
      canonicalUrl: `/api/samples/${sampleEntry.filename}`,
      title: sampleEntry.title,
      author: 'ClearReel Sample Library',
      thumbnail: sampleEntry.thumbnail,
      aspect: '16:9',
      directMediaSupported: true,
      contentType: 'video/mp4',
      contentLength: sizeBytes,
      formats: [
        { id: 'original', label: '720p Source', container: 'MP4', codec: 'H.264 + AAC', estimatedSize: `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`, type: 'video' },
        { id: '480p', label: '480p SD', container: 'MP4', codec: 'H.264 + AAC', estimatedSize: 'Fast Convert', type: 'video' },
        { id: 'webm', label: 'WebM VP9', container: 'WEBM', codec: 'VP9 + Opus', estimatedSize: 'Web Optimized', type: 'video' },
        { id: 'mp3', label: '320 kbps', container: 'MP3', codec: 'MPEG Audio', estimatedSize: 'Audio Only', type: 'audio' },
      ],
    });
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = await assertSafeExternalUrl(rawUrl);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid URL.' });
    return;
  }

  const ytId = extractYouTubeId(parsedUrl);
  if (ytId) {
    const canonicalUrl = `https://www.youtube.com/watch?v=${ytId}`;
    let title = `YouTube Video (${ytId})`;
    let author = 'YouTube Creator';
    let thumbnail = `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`;
    let isShort = parsedUrl.pathname.includes('/shorts/');

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      const oembedRes = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      if (oembedRes.ok) {
        const data = (await oembedRes.json()) as {
          title?: string;
          author_name?: string;
          thumbnail_url?: string;
          width?: number;
          height?: number;
        };
        if (data.title) title = data.title;
        if (data.author_name) author = data.author_name;
        if (data.thumbnail_url) thumbnail = data.thumbnail_url;
        if (data.width && data.height && data.height > data.width) isShort = true;
      }
    } catch {
      // Keep deterministic YouTube metadata when oEmbed is unreachable
    }

    res.json({
      platform: isShort ? 'YouTube Shorts' : 'YouTube',
      videoId: ytId,
      canonicalUrl,
      title,
      author,
      thumbnail,
      aspect: isShort ? '9:16' : '16:9',
      directMediaSupported: false,
      formats: [
        { id: '1080p', label: '1080p Full HD', container: 'MP4', codec: 'H.264 + AAC', estimatedSize: '68 MB', type: 'video' },
        { id: '720p', label: '720p HD', container: 'MP4', codec: 'H.264 + AAC', estimatedSize: '32 MB', type: 'video' },
        { id: '480p', label: '480p SD', container: 'MP4', codec: 'H.264 + AAC', estimatedSize: '17 MB', type: 'video' },
        { id: 'mp3', label: '320 kbps', container: 'MP3', codec: 'MPEG Audio', estimatedSize: '8.4 MB', type: 'audio' },
      ],
    });
    return;
  }

  const pathnameLower = parsedUrl.pathname.toLowerCase();
  const isDirectExt = ['.mp4', '.webm', '.mov', '.m4v', '.mp3', '.m4a'].some((ext) =>
    pathnameLower.endsWith(ext)
  );
  const probe = await probeRemoteMedia(parsedUrl);
  const isMediaMime =
    probe.contentType.startsWith('video/') ||
    probe.contentType.startsWith('audio/') ||
    (isDirectExt && probe.contentType.includes('octet-stream'));

  if (probe.reachable && (isMediaMime || isDirectExt)) {
    const fileBase = path.basename(parsedUrl.pathname) || 'remote-video.mp4';
    res.json({
      platform: 'Direct Video',
      canonicalUrl: parsedUrl.toString(),
      title: fileBase,
      author: parsedUrl.hostname,
      thumbnail: '/src/assets/images/sample_thumb_travel_1795560346730.jpg',
      aspect: '16:9',
      directMediaSupported: true,
      contentType: probe.contentType || 'video/mp4',
      contentLength: probe.contentLength,
      formats: [
        { id: 'original', label: 'Source Quality', container: 'MP4', codec: 'H.264', estimatedSize: probe.contentLength ? `${(probe.contentLength / (1024 * 1024)).toFixed(2)} MB` : 'Original', type: 'video' },
        { id: '720p', label: '720p HD', container: 'MP4', codec: 'H.264 + AAC', estimatedSize: 'Transcoded', type: 'video' },
        { id: '480p', label: '480p SD', container: 'MP4', codec: 'H.264 + AAC', estimatedSize: 'Transcoded', type: 'video' },
        { id: 'webm', label: 'WebM VP9', container: 'WEBM', codec: 'VP9 + Opus', estimatedSize: 'Transcoded', type: 'video' },
        { id: 'mp3', label: '320 kbps', container: 'MP3', codec: 'Audio Extract', estimatedSize: 'Audio Only', type: 'audio' },
      ],
    });
    return;
  }

  res.status(400).json({
    error: isDirectExt
      ? 'This remote video link blocked server access (403/404). Upload the video file directly into the Watermark Studio instead.'
      : 'Paste a YouTube / Shorts link or a direct .mp4 / .webm / .mov media URL.',
  });
});

function buildLocalYtdlpCommand(canonicalUrl: string, formatId: string): string {
  if (formatId === 'mp3') {
    return `yt-dlp -x --audio-format mp3 --audio-quality 0 "${canonicalUrl}"`;
  }
  const height = formatId === '1080p' ? 1080 : formatId === '720p' ? 720 : formatId === '480p' ? 480 : 1080;
  return `yt-dlp -f "bestvideo[height<=${height}]+bestaudio/best[height<=${height}]" --merge-output-format mp4 "${canonicalUrl}"`;
}

async function findYtdlpBinary(): Promise<string | null> {
  const candidates = [process.env.YTDLP_PATH, 'yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'].filter(
    (v): v is string => Boolean(v)
  );
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ['--version'], { shell: false, timeout: 3000 });
      return bin;
    } catch {
      // Try next
    }
  }
  return null;
}

// Download & optionally transcode a direct video URL, sample clip, or local YouTube stream
app.post('/api/download-url', async (req: Request, res: Response) => {
  const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  const formatId = ['original', '1080p', '720p', '480p', 'webm', 'mp3'].includes(req.body?.formatId)
    ? (req.body.formatId as 'original' | '1080p' | '720p' | '480p' | 'webm' | 'mp3')
    : 'original';

  if (!rawUrl) {
    res.status(400).json({ error: 'Video URL is required.' });
    return;
  }

  let inputPath: string | null = null;
  let baseName = 'clearreel-video';

  try {
    const sampleEntry = matchAllowlistedSample(rawUrl);
    if (sampleEntry) {
      inputPath = safeResolveInDir(SAMPLES_DIR, sampleEntry.filename);
      baseName = sampleEntry.id;
    } else {
      const parsedUrl = await assertSafeExternalUrl(rawUrl);
      const ytId = extractYouTubeId(parsedUrl);

      if (ytId) {
        const canonicalUrl = `https://www.youtube.com/watch?v=${ytId}`;
        const localCommand = buildLocalYtdlpCommand(canonicalUrl, formatId);
        const ytdlpBin = await findYtdlpBinary();

        if (!ytdlpBin) {
          res.status(422).json({
            code: 'LOCAL_DOWNLOAD_REQUIRED',
            canonicalUrl,
            videoId: ytId,
            localCommand,
            error: 'YouTube blocks automated cloud downloads. Run the local download command on your computer, then drop the saved MP4 into the Watermark Studio.',
          });
          return;
        }

        const outId = `yt_${crypto.randomBytes(8).toString('hex')}.${formatId === 'mp3' ? 'mp3' : 'mp4'}`;
        const outTarget = safeResolveInDir(TMP_DIR, outId);
        if (!outTarget) {
          res.status(500).json({ error: 'Output path allocation failed.' });
          return;
        }

        const ytArgs =
          formatId === 'mp3'
            ? ['--no-playlist', '--max-filesize', '150M', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', outTarget, canonicalUrl]
            : [
                '--no-playlist',
                '--max-filesize',
                '150M',
                '-f',
                `bestvideo[height<=${formatId === '1080p' ? 1080 : formatId === '480p' ? 480 : 720}]+bestaudio/best`,
                '--merge-output-format',
                'mp4',
                '-o',
                outTarget,
                canonicalUrl,
              ];

        try {
          await execFileAsync(ytdlpBin, ytArgs, { shell: false, timeout: 90000 });
          if (fs.existsSync(outTarget)) {
            const stats = await fs.promises.stat(outTarget);
            const downloadFilename = `youtube-${ytId}-${formatId}.${formatId === 'mp3' ? 'mp3' : 'mp4'}`;
            res.json({
              fileId: outId,
              filename: downloadFilename,
              sizeBytes: stats.size,
              downloadUrl: `/api/download/${outId}?name=${encodeURIComponent(downloadFilename)}`,
              previewUrl: `/api/media/${outId}`,
            });
            return;
          }
        } catch {
          res.status(422).json({
            code: 'LOCAL_DOWNLOAD_REQUIRED',
            canonicalUrl,
            videoId: ytId,
            localCommand,
            error: 'YouTube blocked this cloud server IP. Run the local download command on your computer to save it directly.',
          });
          return;
        }
      }

      const fetched = await fetchExternalVideoToTemp(parsedUrl);
      inputPath = fetched.filePath;
      baseName = path.parse(fetched.filename).name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'clearreel-video';
    }

    if (!inputPath || !fs.existsSync(inputPath)) {
      res.status(404).json({ error: 'Source video could not be loaded.' });
      return;
    }

    const outExt = formatId === 'webm' ? 'webm' : formatId === 'mp3' ? 'mp3' : 'mp4';
    const outId = `dl_${crypto.randomBytes(8).toString('hex')}.${outExt}`;
    const outputPath = safeResolveInDir(TMP_DIR, outId);
    if (!outputPath) {
      res.status(500).json({ error: 'Output path allocation failed.' });
      return;
    }

    if (formatId === 'original' && path.extname(inputPath).toLowerCase() === '.mp4') {
      await fs.promises.copyFile(inputPath, outputPath);
    } else {
      const args: string[] = ['-y', '-i', inputPath];
      if (formatId === 'mp3') {
        args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '320k', outputPath);
      } else if (formatId === 'webm') {
        args.push(
          '-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '4',
          '-c:a', 'libopus', '-b:a', '128k', outputPath
        );
      } else {
        const probe = await probeMediaFile(inputPath);
        const targetH = formatId === '720p' ? 720 : formatId === '480p' ? 480 : 0;
        if (targetH > 0 && targetH < probe.height) {
          args.push('-vf', `scale=-2:${targetH}`);
        }
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
        if (probe.hasAudio) {
          args.push('-c:a', 'aac', '-b:a', '192k');
        }
        args.push('-movflags', '+faststart', outputPath);
      }
      await execFileAsync('ffmpeg', args, { shell: false, timeout: 120000 });
    }

    const stats = await fs.promises.stat(outputPath);
    const downloadFilename = `${baseName}-${formatId}.${outExt}`;

    res.json({
      fileId: outId,
      filename: downloadFilename,
      sizeBytes: stats.size,
      downloadUrl: `/api/download/${outId}?name=${encodeURIComponent(downloadFilename)}`,
      previewUrl: `/api/media/${outId}`,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to prepare video download.',
    });
  }
});

// Import direct MP4/WebM URL or sample clip into server tmp_media for watermark removal
app.post('/api/import-url', async (req: Request, res: Response) => {
  const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!rawUrl) {
    res.status(400).json({ error: 'Video URL is required.' });
    return;
  }

  const sampleEntry = matchAllowlistedSample(rawUrl);
  if (sampleEntry) {
    const resolvedSample = safeResolveInDir(SAMPLES_DIR, sampleEntry.filename);
    if (!resolvedSample || !fs.existsSync(resolvedSample)) {
      res.status(404).json({ error: 'Sample clip unavailable.' });
      return;
    }
    const probe = await probeMediaFile(resolvedSample);
    const stats = await fs.promises.stat(resolvedSample);
    res.json({
      sourceType: 'sample',
      fileId: sampleEntry.filename,
      filename: sampleEntry.title,
      sizeBytes: stats.size,
      previewUrl: `/api/samples/${sampleEntry.filename}`,
      defaultRegion: sampleEntry.defaultRegion,
      ...probe,
    });
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = await assertSafeExternalUrl(rawUrl);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid URL.' });
    return;
  }

  try {
    const fetched = await fetchExternalVideoToTemp(parsedUrl);
    const probe = await probeMediaFile(fetched.filePath);
    const previewFileId = await ensureBrowserPreviewFile(fetched.fileId, fetched.filePath, probe);

    res.json({
      sourceType: 'upload',
      fileId: fetched.fileId,
      filename: fetched.filename,
      sizeBytes: fetched.sizeBytes,
      previewUrl: `/api/media/${previewFileId}`,
      ...probe,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to import remote video.',
    });
  }
});

interface ChunkUploadSession {
  uploadId: string;
  fileId: string;
  partPath: string;
  finalPath: string;
  originalName: string;
  totalSize: number;
  receivedBytes: number;
  nextChunkIndex: number;
  totalChunks: number;
  createdAt: number;
}

const uploadSessions = new Map<string, ChunkUploadSession>();

// Initialize chunked video upload (bypasses proxy 32 MB single-request limits for large videos)
app.post('/api/upload-video/init', async (req: Request, res: Response) => {
  const filename = typeof req.body?.filename === 'string' ? req.body.filename.trim() : 'video.mp4';
  const sizeBytes = Number(req.body?.sizeBytes) || 0;
  const totalChunks = Math.round(Number(req.body?.totalChunks) || 0);

  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_VIDEO_EXTENSIONS.has(ext) && !String(req.body?.mimeType || '').startsWith('video/')) {
    res.status(400).json({ error: 'Unsupported file type. Upload MP4, MOV, WebM, MKV, or M4V video.' });
    return;
  }
  if (sizeBytes <= 0 || sizeBytes > 500 * 1024 * 1024) {
    res.status(400).json({ error: 'Video file size must be between 1 byte and 500 MB.' });
    return;
  }
  if (totalChunks < 1 || totalChunks > 500) {
    res.status(400).json({ error: 'Invalid chunk count.' });
    return;
  }

  const safeExt = ALLOWED_VIDEO_EXTENSIONS.has(ext) ? ext : '.mp4';
  const uploadId = `up_${crypto.randomBytes(8).toString('hex')}`;
  const fileId = `src_${crypto.randomBytes(8).toString('hex')}${safeExt}`;
  const finalPath = safeResolveInDir(TMP_DIR, fileId);
  const partPath = safeResolveInDir(TMP_DIR, `${fileId}.part`);
  if (!finalPath || !partPath) {
    res.status(500).json({ error: 'Failed to allocate upload path.' });
    return;
  }

  try {
    await fs.promises.writeFile(partPath, Buffer.alloc(0));
    uploadSessions.set(uploadId, {
      uploadId,
      fileId,
      partPath,
      finalPath,
      originalName: filename,
      totalSize: sizeBytes,
      receivedBytes: 0,
      nextChunkIndex: 0,
      totalChunks,
      createdAt: Date.now(),
    });
    res.json({ uploadId, fileId });
  } catch {
    res.status(500).json({ error: 'Could not initialize upload session.' });
  }
});

// Receive a single binary chunk for an active chunked upload session
app.post(
  '/api/upload-video/chunk',
  express.raw({ type: 'application/octet-stream', limit: '16mb' }),
  async (req: Request, res: Response) => {
    const uploadId = String(req.headers['x-upload-id'] || '');
    const chunkIndex = Number(req.headers['x-chunk-index']);
    const session = uploadSessions.get(uploadId);

    if (!session) {
      res.status(404).json({ error: 'Upload session not found or expired. Please try uploading again.' });
      return;
    }
    if (!Number.isInteger(chunkIndex) || chunkIndex !== session.nextChunkIndex) {
      res.status(400).json({ error: `Unexpected chunk index ${chunkIndex}; expected ${session.nextChunkIndex}.` });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'Empty upload chunk received.' });
      return;
    }
    if (session.receivedBytes + req.body.length > 500 * 1024 * 1024) {
      fs.unlink(session.partPath, () => {});
      uploadSessions.delete(uploadId);
      res.status(413).json({ error: 'Uploaded file exceeds 500 MB limit.' });
      return;
    }

    try {
      await fs.promises.appendFile(session.partPath, req.body);
      session.receivedBytes += req.body.length;
      session.nextChunkIndex += 1;
      res.json({
        ok: true,
        receivedBytes: session.receivedBytes,
        nextChunkIndex: session.nextChunkIndex,
      });
    } catch {
      res.status(500).json({ error: 'Failed to write video chunk to disk.' });
    }
  }
);

// Finalize chunked upload, verify streams with ffprobe, and return video metadata
app.post('/api/upload-video/complete', async (req: Request, res: Response) => {
  const uploadId = typeof req.body?.uploadId === 'string' ? req.body.uploadId.trim() : '';
  const session = uploadSessions.get(uploadId);
  if (!session) {
    res.status(404).json({ error: 'Upload session not found or expired.' });
    return;
  }

  uploadSessions.delete(uploadId);

  if (session.nextChunkIndex !== session.totalChunks) {
    fs.unlink(session.partPath, () => {});
    res.status(400).json({ error: 'Upload incomplete: missing one or more chunks.' });
    return;
  }

  try {
    await fs.promises.rename(session.partPath, session.finalPath);
    const probe = await probeMediaFile(session.finalPath);
    const stats = await fs.promises.stat(session.finalPath);
    const previewFileId = await ensureBrowserPreviewFile(session.fileId, session.finalPath, probe);
    res.json({
      fileId: session.fileId,
      filename: session.originalName,
      sizeBytes: stats.size,
      previewUrl: `/api/media/${previewFileId}`,
      ...probe,
    });
  } catch {
    fs.unlink(session.partPath, () => {});
    fs.unlink(session.finalPath, () => {});
    res.status(400).json({ error: 'Unable to read video streams. Ensure the file is a valid MP4, MOV, or WebM.' });
  }
});

// Upload local video file for watermark removal & conversion (single-request path for smaller clips)
app.post('/api/upload-video', upload.single('video'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No video file uploaded.' });
    return;
  }

  const fileId = req.file.filename;
  const resolved = safeResolveInDir(TMP_DIR, fileId);
  if (!resolved) {
    res.status(400).json({ error: 'Invalid upload reference.' });
    return;
  }

  try {
    const probe = await probeMediaFile(resolved);
    const previewFileId = await ensureBrowserPreviewFile(fileId, resolved, probe);
    res.json({
      fileId,
      filename: req.file.originalname,
      sizeBytes: req.file.size,
      previewUrl: `/api/media/${previewFileId}`,
      ...probe,
    });
  } catch {
    fs.unlink(resolved, () => {});
    res.status(400).json({ error: 'Unable to read video streams. Ensure the file is a valid MP4, MOV, or WebM.' });
  }
});

// Stream temp source or processed media (supports Range requests for HTML5 video scrubbing)
app.get('/api/media/:fileId', (req: Request, res: Response) => {
  const fileId = String(req.params.fileId || '');
  const resolved = safeResolveInDir(TMP_DIR, fileId);
  if (!resolved || !fs.existsSync(resolved)) {
    res.status(404).json({ error: 'Media file not found or expired.' });
    return;
  }
  if (path.extname(resolved).toLowerCase() === '.m4v') {
    res.type('video/mp4');
  }
  res.sendFile(resolved);
});

// On-demand H.264/AAC browser preview transcode fallback for unsupported video containers/codecs
app.get('/api/preview-proxy/:fileId', async (req: Request, res: Response) => {
  const fileId = String(req.params.fileId || '');
  const resolved = safeResolveInDir(TMP_DIR, fileId);
  if (!resolved || !fs.existsSync(resolved)) {
    res.status(404).json({ error: 'Source video not found or expired.' });
    return;
  }
  try {
    const probe = await probeMediaFile(resolved);
    const previewId = await ensureBrowserPreviewFile(fileId, resolved, probe);
    const previewPath = safeResolveInDir(TMP_DIR, previewId);
    if (!previewPath || !fs.existsSync(previewPath)) {
      res.status(404).json({ error: 'Preview unavailable.' });
      return;
    }
    res.type('video/mp4');
    res.sendFile(previewPath);
  } catch {
    res.status(500).json({ error: 'Could not prepare browser preview.' });
  }
});

// Download processed output with Content-Disposition attachment
app.get('/api/download/:fileId', (req: Request, res: Response) => {
  const fileId = String(req.params.fileId || '');
  const resolved = safeResolveInDir(TMP_DIR, fileId);
  if (!resolved || !fs.existsSync(resolved)) {
    res.status(404).json({ error: 'Processed file not found or expired.' });
    return;
  }
  const downloadName = typeof req.query.name === 'string' && /^[a-zA-Z0-9_.-]+$/.test(req.query.name)
    ? req.query.name
    : fileId;
  res.download(resolved, downloadName);
});

interface RegionInput {
  x: number;
  y: number;
  w: number;
  h: number;
  mode: 'delogo' | 'blur' | 'pixelate';
}

interface ProcessJobResult {
  outputId: string;
  previewUrl: string;
  downloadUrl: string;
  sizeBytes: number;
  durationMs: number;
  regionsProcessed: number;
  outputFormat: 'mp4' | 'webm' | 'mov' | 'mp3' | 'gif';
}

interface PublicProcessJob {
  jobId: string;
  status: 'queued' | 'processing' | 'done' | 'error' | 'cancelled';
  progress: number;
  stage: string;
  speed?: string;
  processedSeconds: number;
  totalSeconds: number;
  result?: ProcessJobResult;
  error?: string;
}

interface InternalProcessJob extends PublicProcessJob {
  createdAt: number;
  updatedAt: number;
  inputPath?: string;
  outputPath: string;
  child?: ChildProcess;
  listeners: Set<(snapshot: PublicProcessJob) => void>;
}

const processJobs = new Map<string, InternalProcessJob>();

function toPublicJob(job: InternalProcessJob): PublicProcessJob {
  return {
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    speed: job.speed,
    processedSeconds: job.processedSeconds,
    totalSeconds: job.totalSeconds,
    result: job.result,
    error: job.error,
  };
}

function emitJobUpdate(job: InternalProcessJob) {
  job.updatedAt = Date.now();
  const snapshot = toPublicJob(job);
  for (const listener of job.listeners) {
    listener(snapshot);
  }
}

function parseOutTimeSeconds(outTimeStr: string): number | null {
  const match = outTimeStr.trim().match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!match) return null;
  const hrs = Number(match[1]);
  const mins = Number(match[2]);
  const secs = Number(match[3]);
  if (!Number.isFinite(hrs) || !Number.isFinite(mins) || !Number.isFinite(secs)) return null;
  return hrs * 3600 + mins * 60 + secs;
}

async function prepareWatermarkFfmpegPlan(body: Record<string, unknown>): Promise<{
  args: string[];
  outId: string;
  inputPath: string;
  outputPath: string;
  outputFormat: 'mp4' | 'webm' | 'mov' | 'mp3' | 'gif';
  regionsProcessed: number;
  totalSeconds: number;
  activeStage: string;
}> {
  const sourceType = body?.sourceType === 'sample' ? 'sample' : 'upload';
  const sourceId = typeof body?.sourceId === 'string' ? body.sourceId.trim() : '';
  const outputFormat = ['mp4', 'webm', 'mov', 'mp3', 'gif'].includes(String(body?.outputFormat))
    ? (body.outputFormat as 'mp4' | 'webm' | 'mov' | 'mp3' | 'gif')
    : 'mp4';
  const resolution = ['original', '1080p', '720p', '480p'].includes(String(body?.resolution))
    ? (body.resolution as 'original' | '1080p' | '720p' | '480p')
    : 'original';

  const inputPath =
    sourceType === 'sample'
      ? safeResolveInDir(SAMPLES_DIR, sourceId)
      : safeResolveInDir(TMP_DIR, sourceId);

  if (!inputPath || !fs.existsSync(inputPath)) {
    const err = new Error('Source video could not be found. Please re-load your clip.') as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }

  const probe = await probeMediaFile(inputPath);
  const rawRegions = Array.isArray(body?.regions) ? (body.regions as RegionInput[]) : [];
  const safeRegions = rawRegions.slice(0, 6).map((r) => {
    const x = Math.max(2, Math.min(probe.width - 16, Math.round(Number(r.x) || 0)));
    const y = Math.max(2, Math.min(probe.height - 16, Math.round(Number(r.y) || 0)));
    const w = Math.max(8, Math.min(probe.width - x - 2, Math.round(Number(r.w) || 80)));
    const h = Math.max(8, Math.min(probe.height - y - 2, Math.round(Number(r.h) || 40)));
    const mode: 'delogo' | 'blur' | 'pixelate' =
      r.mode === 'blur' || r.mode === 'pixelate' ? r.mode : 'delogo';
    return { x, y, w, h, mode };
  });

  const cropPercent = Math.max(0, Math.min(20, Math.round(Number(body?.cropMarginPercent) || 0)));
  const trimStart = Math.max(0, Number(body?.trimStart) || 0);
  const trimEnd = Number(body?.trimEnd) > trimStart ? Math.min(probe.duration || 14400, Number(body.trimEnd)) : 0;
  const totalSeconds =
    trimEnd > trimStart
      ? Math.max(0.2, trimEnd - trimStart)
      : Math.max(0.2, (probe.duration || 6) - trimStart);

  const outId = `clean_${crypto.randomBytes(8).toString('hex')}.${outputFormat}`;
  const outputPath = safeResolveInDir(TMP_DIR, outId);
  if (!outputPath) {
    const err = new Error('Could not allocate output file.') as Error & { statusCode?: number };
    err.statusCode = 500;
    throw err;
  }

  const args: string[] = ['-y'];
  if (trimStart > 0) {
    args.push('-ss', trimStart.toFixed(2));
  }
  args.push('-i', inputPath);
  if (trimEnd > trimStart) {
    args.push('-t', (trimEnd - trimStart).toFixed(2));
  }

  if (outputFormat === 'mp3') {
    if (!probe.hasAudio) {
      const err = new Error('This video does not contain an audio track to extract.') as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '320k', outputPath);
  } else {
    const filterSteps: string[] = [];
    let currentLabel = '0:v';
    let stepIdx = 0;

    for (const region of safeRegions) {
      const nextLabel = `v${++stepIdx}`;
      if (region.mode === 'delogo') {
        filterSteps.push(`[${currentLabel}]delogo=x=${region.x}:y=${region.y}:w=${region.w}:h=${region.h}[${nextLabel}]`);
      } else if (region.mode === 'blur') {
        const baseCopy = `b${stepIdx}`;
        const cropCopy = `c${stepIdx}`;
        const blurred = `bl${stepIdx}`;
        const blurRadius = Math.max(1, Math.min(14, Math.floor(Math.min(region.w, region.h) / 4) - 1));
        filterSteps.push(
          `[${currentLabel}]split=2[${baseCopy}][${cropCopy}];` +
          `[${cropCopy}]crop=${region.w}:${region.h}:${region.x}:${region.y},boxblur=${blurRadius}:2[${blurred}];` +
          `[${baseCopy}][${blurred}]overlay=${region.x}:${region.y}[${nextLabel}]`
        );
      } else {
        const baseCopy = `p${stepIdx}`;
        const cropCopy = `pc${stepIdx}`;
        const pix = `px${stepIdx}`;
        const downW = Math.max(4, Math.round(region.w / 10));
        const downH = Math.max(4, Math.round(region.h / 10));
        filterSteps.push(
          `[${currentLabel}]split=2[${baseCopy}][${cropCopy}];` +
          `[${cropCopy}]crop=${region.w}:${region.h}:${region.x}:${region.y},scale=${downW}:${downH}:flags=neighbor,scale=${region.w}:${region.h}:flags=neighbor[${pix}];` +
          `[${baseCopy}][${pix}]overlay=${region.x}:${region.y}[${nextLabel}]`
        );
      }
      currentLabel = nextLabel;
    }

    if (cropPercent > 0) {
      const factor = (100 - cropPercent * 2) / 100;
      const nextLabel = `v${++stepIdx}`;
      filterSteps.push(`[${currentLabel}]crop=iw*${factor.toFixed(2)}:ih*${factor.toFixed(2)}[${nextLabel}]`);
      currentLabel = nextLabel;
    }

    const targetHeight = resolution === '1080p' ? 1080 : resolution === '720p' ? 720 : resolution === '480p' ? 480 : 0;
    if (targetHeight > 0 && targetHeight < probe.height) {
      const nextLabel = `v${++stepIdx}`;
      filterSteps.push(`[${currentLabel}]scale=-2:${targetHeight}[${nextLabel}]`);
      currentLabel = nextLabel;
    }

    if (outputFormat === 'gif') {
      const nextLabel = `v${++stepIdx}`;
      filterSteps.push(`[${currentLabel}]fps=15,scale=640:-1:flags=lanczos[${nextLabel}]`);
      currentLabel = nextLabel;
    }

    if (filterSteps.length > 0) {
      args.push('-filter_complex', filterSteps.join(';'), '-map', `[${currentLabel}]`);
      if (probe.hasAudio && outputFormat !== 'gif') {
        args.push('-map', '0:a?');
      }
    }

    if (outputFormat === 'mp4') {
      args.push('-c:v', 'libx264', '-preset', 'superfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-threads', '0');
      if (probe.hasAudio) {
        args.push('-c:a', 'aac', '-b:a', '192k');
      }
      args.push('-movflags', '+faststart', outputPath);
    } else if (outputFormat === 'webm') {
      args.push(
        '-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0',
        '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1', '-threads', '0'
      );
      if (probe.hasAudio) {
        args.push('-c:a', 'libopus', '-b:a', '128k');
      }
      args.push(outputPath);
    } else if (outputFormat === 'mov') {
      args.push('-c:v', 'prores_ks', '-profile:v', '2', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le', '-threads', '0');
      if (probe.hasAudio) {
        args.push('-c:a', 'pcm_s16le');
      }
      args.push(outputPath);
    } else {
      args.push(outputPath);
    }
  }

  const activeStage =
    outputFormat === 'mp3'
      ? 'Extracting MP3 audio'
      : outputFormat === 'gif'
      ? 'Rendering GIF frames'
      : outputFormat === 'mov'
      ? 'Encoding ProRes 422 master'
      : safeRegions.length > 0
      ? 'Removing watermarks & encoding'
      : 'Encoding clean output';

  return {
    args,
    outId,
    inputPath,
    outputPath,
    outputFormat,
    regionsProcessed: safeRegions.length,
    totalSeconds,
    activeStage,
  };
}

// Start a background FFmpeg watermark removal job with live progress tracking
app.post('/api/process-jobs', async (req: Request, res: Response) => {
  try {
    const plan = await prepareWatermarkFfmpegPlan((req.body || {}) as Record<string, unknown>);
    const jobId = `job_${crypto.randomBytes(8).toString('hex')}`;
    const now = Date.now();

    const job: InternalProcessJob = {
      jobId,
      status: 'processing',
      progress: 1,
      stage: plan.activeStage,
      processedSeconds: 0,
      totalSeconds: plan.totalSeconds,
      createdAt: now,
      updatedAt: now,
      inputPath: plan.inputPath,
      outputPath: plan.outputPath,
      listeners: new Set(),
    };

    processJobs.set(jobId, job);

    const ffmpegArgs = ['-progress', 'pipe:1', '-nostats', ...plan.args];
    const child = spawn('ffmpeg', ffmpegArgs, { shell: false });
    job.child = child;

    const startedAt = Date.now();
    const STALL_TIMEOUT_MS = 4 * 60 * 1000;
    const MAX_RUNTIME_MS = Math.max(
      20 * 60 * 1000,
      Math.min(45 * 60 * 1000, Math.round(plan.totalSeconds * 10 * 1000))
    );

    const terminateWithTimeout = (reason: string) => {
      if (job.status !== 'processing') return;
      job.status = 'error';
      job.stage = 'Timed out';
      job.error = reason;
      emitJobUpdate(job);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 1500).unref();
    };

    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        terminateWithTimeout('FFmpeg stalled with no encoding progress for 4 minutes.');
      }, STALL_TIMEOUT_MS);
    };
    resetStallTimer();

    const maxRuntimeTimer = setTimeout(() => {
      const mins = Math.round(MAX_RUNTIME_MS / 60000);
      terminateWithTimeout(`FFmpeg processing exceeded maximum ${mins}-minute runtime limit.`);
    }, MAX_RUNTIME_MS);

    const clearWatchdogs = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      clearTimeout(maxRuntimeTimer);
    };

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let latestTimeSec = 0;
    let latestSpeed: string | undefined;

    child.stdout?.on('data', (chunk: Buffer) => {
      resetStallTimer();
      stdoutBuffer += chunk.toString('utf8');
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx);
        const val = line.slice(eqIdx + 1);

        if (key === 'out_time_us' && val !== 'N/A') {
          const us = Number(val);
          if (Number.isFinite(us) && us >= 0) {
            latestTimeSec = us / 1_000_000;
          }
        } else if (key === 'out_time' && val !== 'N/A') {
          const parsed = parseOutTimeSeconds(val);
          if (parsed !== null) {
            latestTimeSec = parsed;
          }
        } else if (key === 'speed' && val !== 'N/A') {
          latestSpeed = val.trim();
        } else if (key === 'progress') {
          if (job.status !== 'processing') continue;
          const clampedSec = Math.max(0, Math.min(plan.totalSeconds, latestTimeSec));
          const computedPct = Math.round((clampedSec / Math.max(0.1, plan.totalSeconds)) * 100);
          job.processedSeconds = Math.round(clampedSec * 10) / 10;
          job.speed = latestSpeed;
          if (val === 'end') {
            job.progress = 99;
            job.stage = 'Finalizing file';
          } else {
            job.progress = Math.max(job.progress, Math.min(98, computedPct));
            job.stage = plan.activeStage;
          }
          emitJobUpdate(job);
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      resetStallTimer();
      stderrBuffer = (stderrBuffer + chunk.toString('utf8')).slice(-2500);
    });

    child.on('error', (err) => {
      clearWatchdogs();
      job.child = undefined;
      if (job.status === 'processing') {
        job.status = 'error';
        job.stage = 'Failed';
        job.error = err.message || 'Could not start FFmpeg process.';
        emitJobUpdate(job);
      }
    });

    child.on('close', async (code) => {
      clearWatchdogs();
      job.child = undefined;

      if (job.status === 'cancelled') {
        fs.unlink(plan.outputPath, () => {});
        emitJobUpdate(job);
        return;
      }

      if (job.status === 'error') {
        fs.unlink(plan.outputPath, () => {});
        emitJobUpdate(job);
        return;
      }

      if (code === 0 && fs.existsSync(plan.outputPath)) {
        try {
          const stats = await fs.promises.stat(plan.outputPath);
          const durationMs = Date.now() - startedAt;
          job.status = 'done';
          job.progress = 100;
          job.processedSeconds = Math.round(plan.totalSeconds * 10) / 10;
          job.stage = 'Complete';
          job.result = {
            outputId: plan.outId,
            previewUrl: `/api/media/${plan.outId}`,
            downloadUrl: `/api/download/${plan.outId}?name=${encodeURIComponent(`clearreel-clean.${plan.outputFormat}`)}`,
            sizeBytes: stats.size,
            durationMs,
            regionsProcessed: plan.regionsProcessed,
            outputFormat: plan.outputFormat,
          };
          emitJobUpdate(job);
          return;
        } catch {
          // Fall through to error handling
        }
      }

      fs.unlink(plan.outputPath, () => {});
      const lastErrLine = stderrBuffer
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-1)[0];
      job.status = 'error';
      job.stage = 'Failed';
      job.error = lastErrLine || 'FFmpeg video processing failed.';
      emitJobUpdate(job);
    });

    res.status(202).json(toPublicJob(job));
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode || 500;
    res.status(statusCode).json({
      error: err instanceof Error ? err.message : 'Failed to start processing job.',
    });
  }
});

// JSON polling endpoint for job status
app.get('/api/process-jobs/:jobId', (req: Request, res: Response) => {
  const jobId = String(req.params.jobId || '');
  const job = processJobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: 'Processing job not found.' });
    return;
  }
  res.json(toPublicJob(job));
});

// Server-Sent Events stream for real-time per-clip progress
app.get('/api/process-jobs/:jobId/stream', (req: Request, res: Response) => {
  const jobId = String(req.params.jobId || '');
  const job = processJobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: 'Processing job not found.' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 20000);

  const sendEvent = (snapshot: PublicProcessJob) => {
    res.write(`event: progress\ndata: ${JSON.stringify(snapshot)}\n\n`);
    if (snapshot.status === 'done' || snapshot.status === 'error' || snapshot.status === 'cancelled') {
      clearInterval(keepAlive);
      job.listeners.delete(sendEvent);
      res.end();
    }
  };

  job.listeners.add(sendEvent);
  sendEvent(toPublicJob(job));

  req.on('close', () => {
    clearInterval(keepAlive);
    job.listeners.delete(sendEvent);
  });
});

// Cancel an active processing job
app.post('/api/process-jobs/:jobId/cancel', (req: Request, res: Response) => {
  const jobId = String(req.params.jobId || '');
  const job = processJobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: 'Processing job not found.' });
    return;
  }

  if (job.status === 'processing') {
    job.status = 'cancelled';
    job.stage = 'Cancelled';
    emitJobUpdate(job);
    const child = job.child;
    if (child) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 1200).unref();
    }
  }

  res.json(toPublicJob(job));
});

// Real FFmpeg Watermark Removal & Format Conversion Pipeline (synchronous fallback)
app.post('/api/process-video', async (req: Request, res: Response) => {
  try {
    const plan = await prepareWatermarkFfmpegPlan((req.body || {}) as Record<string, unknown>);
    const startedAt = Date.now();
    await execFileAsync('ffmpeg', plan.args, { shell: false, timeout: 1200000 });

    const stats = await fs.promises.stat(plan.outputPath);
    const durationMs = Date.now() - startedAt;

    res.json({
      outputId: plan.outId,
      previewUrl: `/api/media/${plan.outId}`,
      downloadUrl: `/api/download/${plan.outId}?name=${encodeURIComponent(`clearreel-clean.${plan.outputFormat}`)}`,
      sizeBytes: stats.size,
      durationMs,
      regionsProcessed: plan.regionsProcessed,
      outputFormat: plan.outputFormat,
    });
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode || 500;
    res.status(statusCode).json({
      error: err instanceof Error ? err.message : 'FFmpeg video processing failed.',
    });
  }
});

// Fast or frame-accurate segment clipping for long videos
app.post('/api/clip-segment', async (req: Request, res: Response) => {
  const sourceType = req.body?.sourceType === 'sample' ? 'sample' : 'upload';
  const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId.trim() : '';
  const outputFormat = ['mp4', 'webm', 'mov', 'mp3'].includes(req.body?.outputFormat)
    ? (req.body.outputFormat as 'mp4' | 'webm' | 'mov' | 'mp3')
    : 'mp4';
  const resolution = ['original', '1080p', '720p', '480p'].includes(req.body?.resolution)
    ? (req.body.resolution as 'original' | '1080p' | '720p' | '480p')
    : 'original';
  const fastCopy = Boolean(req.body?.fastCopy);
  const rawLabel = typeof req.body?.label === 'string' ? req.body.label.trim() : 'clip';
  const safeLabel = rawLabel.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'clip';

  const inputPath =
    sourceType === 'sample'
      ? safeResolveInDir(SAMPLES_DIR, sourceId)
      : safeResolveInDir(TMP_DIR, sourceId);

  if (!inputPath || !fs.existsSync(inputPath)) {
    res.status(404).json({ error: 'Source video could not be found. Please re-load your video.' });
    return;
  }

  try {
    const probe = await probeMediaFile(inputPath);
    const maxDur = probe.duration > 0 ? probe.duration : 14400;
    const rawStart = Number(req.body?.start);
    const rawEnd = Number(req.body?.end);

    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      res.status(400).json({ error: 'Invalid start or end timestamp.' });
      return;
    }

    const start = Math.max(0, Math.min(maxDur - 0.2, rawStart));
    const end = Math.max(start + 0.2, Math.min(maxDur, rawEnd));
    const clipDur = Math.round((end - start) * 100) / 100;

    if (clipDur < 0.2) {
      res.status(400).json({ error: 'Clip duration must be at least 0.2 seconds.' });
      return;
    }

    const outId = `clip_${crypto.randomBytes(8).toString('hex')}.${outputFormat}`;
    const outputPath = safeResolveInDir(TMP_DIR, outId);
    if (!outputPath) {
      res.status(500).json({ error: 'Could not allocate clip output file.' });
      return;
    }

    const sourceExt = path.extname(inputPath).toLowerCase();
    const canStreamCopy =
      fastCopy &&
      outputFormat === 'mp4' &&
      resolution === 'original' &&
      ['.mp4', '.mov', '.m4v'].includes(sourceExt);

    const startedAt = Date.now();
    const args: string[] = ['-y', '-ss', start.toFixed(3), '-i', inputPath, '-t', clipDur.toFixed(3)];

    if (outputFormat === 'mp3') {
      if (!probe.hasAudio) {
        res.status(400).json({ error: 'This video does not contain an audio track to extract.' });
        return;
      }
      args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '320k', outputPath);
    } else if (canStreamCopy) {
      args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', outputPath);
    } else if (outputFormat === 'mov') {
      const targetH = resolution === '1080p' ? 1080 : resolution === '720p' ? 720 : resolution === '480p' ? 480 : 0;
      if (targetH > 0 && targetH < probe.height) {
        args.push('-vf', `scale=-2:${targetH}`);
      }
      args.push('-c:v', 'prores_ks', '-profile:v', '2', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le', '-threads', '0');
      if (probe.hasAudio) {
        args.push('-c:a', 'pcm_s16le');
      }
      args.push(outputPath);
    } else if (outputFormat === 'webm') {
      const targetH = resolution === '1080p' ? 1080 : resolution === '720p' ? 720 : resolution === '480p' ? 480 : 0;
      if (targetH > 0 && targetH < probe.height) {
        args.push('-vf', `scale=-2:${targetH}`);
      }
      args.push(
        '-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0',
        '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1', '-threads', '0'
      );
      if (probe.hasAudio) {
        args.push('-c:a', 'libopus', '-b:a', '128k');
      }
      args.push(outputPath);
    } else {
      const targetH = resolution === '1080p' ? 1080 : resolution === '720p' ? 720 : resolution === '480p' ? 480 : 0;
      if (targetH > 0 && targetH < probe.height) {
        args.push('-vf', `scale=-2:${targetH}`);
      }
      args.push('-c:v', 'libx264', '-preset', 'superfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-threads', '0');
      if (probe.hasAudio) {
        args.push('-c:a', 'aac', '-b:a', '192k');
      }
      args.push('-movflags', '+faststart', outputPath);
    }

    await execFileAsync('ffmpeg', args, { shell: false, timeout: 1200000 });

    const stats = await fs.promises.stat(outputPath);
    const durationMs = Date.now() - startedAt;
    const downloadFilename = `${safeLabel}.${outputFormat}`;

    res.json({
      outputId: outId,
      filename: downloadFilename,
      previewUrl: `/api/media/${outId}`,
      downloadUrl: `/api/download/${outId}?name=${encodeURIComponent(downloadFilename)}`,
      sizeBytes: stats.size,
      durationMs,
      durationSec: clipDur,
      outputFormat,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'FFmpeg clip extraction failed.',
    });
  }
});

interface RawAiMoment {
  title?: unknown;
  startSec?: unknown;
  endSec?: unknown;
  reason?: unknown;
  score?: unknown;
}

interface CleanHighlightMoment {
  title: string;
  start: number;
  end: number;
  reason: string;
  score: number;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    const err = new Error(
      'GEMINI_API_KEY is not set. Add your key in Settings > Secrets to use AI Best Moments detection.'
    ) as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function sanitizeDetectedMoments(
  rawMoments: RawAiMoment[],
  duration: number,
  maxMoments: number | 'auto'
): CleanHighlightMoment[] {
  const safeDur = Math.max(2, duration);
  const minLen = safeDur < 12 ? Math.max(1.2, Math.round(safeDur * 0.22 * 10) / 10) : 5;
  const maxLen = Math.min(45, safeDur);

  const normalized: CleanHighlightMoment[] = [];
  rawMoments.forEach((m, idx) => {
    const rawStart = Number(m.startSec);
    const rawEnd = Number(m.endSec);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return;

    let start = Math.max(0, Math.min(safeDur - minLen, rawStart));
    let end = Math.max(start + minLen, Math.min(safeDur, rawEnd));
    if (end - start > maxLen) {
      end = Math.min(safeDur, start + maxLen);
    }
    start = Math.round(start * 10) / 10;
    end = Math.round(end * 10) / 10;
    if (end - start < 1.0) return;

    const titleRaw = typeof m.title === 'string' ? m.title.trim() : '';
    const title = (titleRaw || `Highlight ${idx + 1}`).slice(0, 48);
    const reasonRaw = typeof m.reason === 'string' ? m.reason.trim() : '';
    const reason = (reasonRaw || 'Strong visual and audio peak').slice(0, 140);
    const scoreNum = Number(m.score);
    const score = Number.isFinite(scoreNum) ? Math.max(1, Math.min(100, Math.round(scoreNum))) : 80;

    normalized.push({ title, start, end, reason, score });
  });

  // Deduplicate heavy overlaps (>40% overlap with a higher-ranked moment)
  const byScore = [...normalized].sort((a, b) => b.score - a.score);
  const kept: CleanHighlightMoment[] = [];

  for (const cand of byScore) {
    const candLen = cand.end - cand.start;
    const overlapsExisting = kept.some((existing) => {
      const overlap = Math.min(existing.end, cand.end) - Math.max(existing.start, cand.start);
      if (overlap <= 0) return false;
      const minSegLen = Math.min(existing.end - existing.start, candLen);
      return overlap / Math.max(0.1, minSegLen) > 0.4;
    });
    if (!overlapsExisting) {
      kept.push(cand);
    }
  }

  const limit = maxMoments === 'auto' ? 12 : Math.max(1, Math.min(12, maxMoments));
  return kept.slice(0, limit).sort((a, b) => a.start - b.start);
}

function mapGeminiError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err || '');
  const upper = raw.toUpperCase();
  if (upper.includes('GEMINI_API_KEY')) {
    return { status: 400, message: raw };
  }
  if (upper.includes('PERMISSION_DENIED') || upper.includes('API_KEY_INVALID') || upper.includes('403')) {
    return {
      status: 403,
      message: 'Gemini API key was rejected. Check your key in the Settings > Secrets panel.',
    };
  }
  if (upper.includes('RESOURCE_EXHAUSTED') || upper.includes('429')) {
    return {
      status: 429,
      message: 'Gemini API rate limit or quota reached. Wait a moment or check your billing quota in Settings > Secrets.',
    };
  }
  if (upper.includes('NOT_FOUND') || upper.includes('404')) {
    return {
      status: 404,
      message: 'Gemini analysis model could not be reached. Please verify server configuration.',
    };
  }
  return {
    status: 500,
    message: raw || 'AI highlight analysis failed.',
  };
}

// Analyze video visuals + speech with Gemini to extract only the best highlight moments
app.post('/api/analyze-highlights', async (req: Request, res: Response) => {
  const sourceType = req.body?.sourceType === 'sample' ? 'sample' : 'upload';
  const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId.trim() : '';
  const rawMax = req.body?.maxMoments;
  const maxMoments: number | 'auto' =
    rawMax === 'auto' ? 'auto' : [3, 5, 8].includes(Number(rawMax)) ? Number(rawMax) : 5;
  const focusPrompt =
    typeof req.body?.focusPrompt === 'string' ? req.body.focusPrompt.trim().slice(0, 240) : '';

  const inputPath =
    sourceType === 'sample'
      ? safeResolveInDir(SAMPLES_DIR, sourceId)
      : safeResolveInDir(TMP_DIR, sourceId);

  if (!inputPath || !fs.existsSync(inputPath)) {
    res.status(404).json({ error: 'Source video could not be found. Please re-load your video.' });
    return;
  }

  let proxyPath: string | null = null;
  let uploadedFileName: string | null = null;
  let aiClient: GoogleGenAI | null = null;

  try {
    aiClient = getGeminiClient();
    const probe = await probeMediaFile(inputPath);
    const duration = probe.duration > 0 ? probe.duration : 6;
    const stats = await fs.promises.stat(inputPath);
    const ext = path.extname(inputPath).toLowerCase();

    let analysisPath = inputPath;
    if (stats.size > 15 * 1024 * 1024 || ext !== '.mp4') {
      const proxyId = `proxy_${crypto.randomBytes(8).toString('hex')}.mp4`;
      const resolvedProxy = safeResolveInDir(TMP_DIR, proxyId);
      if (!resolvedProxy) {
        throw new Error('Could not allocate temporary analysis file.');
      }
      proxyPath = resolvedProxy;

      const proxyArgs = [
        '-y',
        '-i',
        inputPath,
        '-vf',
        "scale=-2:'min(360,ih)',fps=2",
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '32',
        '-pix_fmt',
        'yuv420p',
        ...(probe.hasAudio ? ['-c:a', 'aac', '-b:a', '64k', '-ac', '1'] : ['-an']),
        '-movflags',
        '+faststart',
        proxyPath,
      ];
      await execFileAsync('ffmpeg', proxyArgs, { shell: false, timeout: 180000 });
      analysisPath = proxyPath;
    }

    const uploaded = await aiClient.files.upload({
      file: analysisPath,
      config: { mimeType: 'video/mp4' },
    });

    if (!uploaded.name) {
      throw new Error('Failed to upload video for AI highlight analysis.');
    }
    uploadedFileName = uploaded.name;

    let activeFile = uploaded;
    for (let attempt = 0; attempt < 45; attempt++) {
      if (activeFile.state === 'ACTIVE') break;
      if (activeFile.state === 'FAILED') {
        throw new Error('Video indexing failed during AI analysis.');
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      activeFile = await aiClient.files.get({ name: uploadedFileName });
    }

    if (activeFile.state !== 'ACTIVE' || !activeFile.uri) {
      throw new Error('Video analysis timed out while preparing the media stream.');
    }

    const countDirective =
      maxMoments === 'auto'
        ? 'Identify all genuinely compelling, non-overlapping highlight moments (between 2 and 10 moments depending on video length).'
        : `Identify up to ${maxMoments} of the strongest, non-overlapping highlight moments.`;

    const durationRule =
      duration >= 12
        ? 'Each highlight must follow natural scene or spoken-thought boundaries lasting between 5 and 45 seconds (endSec - startSec between 5 and 45).'
        : `This clip is ${duration.toFixed(1)} seconds long; return the 1 to 2 strongest highlight windows between 1.5 and ${duration.toFixed(1)} seconds.`;

    const focusLine = focusPrompt
      ? `User focus preference: prioritize moments matching "${focusPrompt}".`
      : 'Look across both visual action (scene changes, visual reveals, peaks of motion/expression) and speech/audio (key insights, punchlines, emotional hooks, high-energy moments).';

    const promptText = [
      `Analyze this ${duration.toFixed(1)}-second video across both visuals and audio/speech.`,
      countDirective,
      durationRule,
      focusLine,
      `Every startSec and endSec must fall strictly within 0 and ${duration.toFixed(1)} seconds.`,
      'Avoid filler, dead air, or arbitrary uniform slicing. Score each moment from 1 to 100 based on highlight strength.',
    ].join('\n');

    const aiResponse = await aiClient.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: createUserContent([
        createPartFromUri(activeFile.uri, activeFile.mimeType || 'video/mp4'),
        promptText,
      ]),
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            moments: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: {
                    type: Type.STRING,
                    description: 'Concise 2-5 word title describing the highlight moment',
                  },
                  startSec: {
                    type: Type.NUMBER,
                    description: 'Start timestamp in seconds',
                  },
                  endSec: {
                    type: Type.NUMBER,
                    description: 'End timestamp in seconds',
                  },
                  reason: {
                    type: Type.STRING,
                    description: 'One concise sentence explaining why this visual or spoken moment stands out',
                  },
                  score: {
                    type: Type.NUMBER,
                    description: 'Highlight strength score from 1 to 100',
                  },
                },
                required: ['title', 'startSec', 'endSec', 'reason', 'score'],
              },
            },
          },
          required: ['moments'],
        },
      },
    });

    const parsed = JSON.parse((aiResponse.text ?? '{"moments":[]}').trim()) as {
      moments?: RawAiMoment[];
    };
    const moments = sanitizeDetectedMoments(
      Array.isArray(parsed.moments) ? parsed.moments : [],
      duration,
      maxMoments
    );

    if (moments.length === 0) {
      res.status(422).json({
        error: 'No distinct highlight moments could be isolated from this clip. Try adjusting the focus prompt or marking clips manually.',
      });
      return;
    }

    res.json({
      moments,
      duration,
    });
  } catch (err) {
    const mapped = mapGeminiError(err);
    res.status(mapped.status).json({ error: mapped.message });
  } finally {
    if (proxyPath) {
      fs.unlink(proxyPath, () => {});
    }
    if (aiClient && uploadedFileName) {
      await aiClient.files.delete({ name: uploadedFileName }).catch(() => {});
    }
  }
});

// Ensure unknown API paths and upload/JSON errors always return valid JSON instead of HTML
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Video file exceeds the 500 MB upload limit.'
        : err.message || 'Upload error.';
    res.status(status).json({ error: message });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unexpected server error.';
  res.status(500).json({ error: message });
});

async function startServer() {
  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
        ws: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(DIST_DIR));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`ClearReel server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
