export interface UploadedVideoResponse {
  fileId: string;
  filename: string;
  sizeBytes: number;
  previewUrl: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
  codec?: string;
}

const SINGLE_REQUEST_THRESHOLD = 16 * 1024 * 1024; // 16 MB (safely below 32 MB Cloud Run HTTP/1.1 body cap)
const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB per chunk
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

export async function parseJsonResponse<T = Record<string, unknown>>(res: Response): Promise<T> {
  const rawText = await res.text();
  let parsed: unknown = null;

  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const trimmed = rawText.trimStart();
      if (trimmed.startsWith('<') || res.headers.get('content-type')?.includes('text/html')) {
        if (res.status === 413) {
          throw new Error('Request payload exceeded the proxy size limit (HTTP 413).');
        }
        if (res.status === 502 || res.status === 503 || res.status === 504) {
          throw new Error(`Upload gateway timed out or was unavailable (HTTP ${res.status}). Please retry.`);
        }
        throw new Error(`Server returned an unexpected HTML page (HTTP ${res.status}).`);
      }
      throw new Error(`Invalid response from server (HTTP ${res.status}).`);
    }
  }

  if (!res.ok) {
    const errMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `Request failed (HTTP ${res.status}).`;
    throw new Error(errMsg);
  }

  return (parsed ?? {}) as T;
}

async function uploadViaChunks(
  file: File,
  onProgress?: (percent: number) => void
): Promise<UploadedVideoResponse> {
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  onProgress?.(0);

  const initRes = await fetch('/api/upload-video/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      sizeBytes: file.size,
      totalChunks,
      mimeType: file.type,
    }),
  });
  const initData = await parseJsonResponse<{ uploadId: string; fileId: string }>(initRes);

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    const slice = file.slice(start, end);

    const chunkRes = await fetch('/api/upload-video/chunk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-upload-id': initData.uploadId,
        'x-chunk-index': String(chunkIndex),
      },
      body: slice,
    });
    await parseJsonResponse(chunkRes);
    onProgress?.(Math.min(96, Math.round(((chunkIndex + 1) / totalChunks) * 96)));
  }

  const completeRes = await fetch('/api/upload-video/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: initData.uploadId }),
  });
  const result = await parseJsonResponse<UploadedVideoResponse>(completeRes);
  onProgress?.(100);
  return result;
}

export async function uploadVideoFile(
  file: File,
  onProgress?: (percent: number) => void
): Promise<UploadedVideoResponse> {
  if (file.size <= 0) {
    throw new Error('Selected file is empty.');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error('Video file exceeds the 500 MB upload limit.');
  }

  if (file.size > SINGLE_REQUEST_THRESHOLD) {
    return uploadViaChunks(file, onProgress);
  }

  onProgress?.(10);
  const formData = new FormData();
  formData.append('video', file);

  const res = await fetch('/api/upload-video', {
    method: 'POST',
    body: formData,
  });

  if (res.status === 413) {
    return uploadViaChunks(file, onProgress);
  }

  const data = await parseJsonResponse<UploadedVideoResponse>(res);
  onProgress?.(100);
  return data;
}
