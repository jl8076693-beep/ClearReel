import { getCachedMediaResponse } from './clipStorage';

export async function triggerBlobDownload(url: string, filename: string): Promise<void> {
  let response = await getCachedMediaResponse(url);

  if (!response) {
    response = await fetch(url);
  } else if (!response.ok) {
    response = await fetch(url);
  }

  if (!response.ok) {
    throw new Error('Could not download media file.');
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 15000);
  }
}

