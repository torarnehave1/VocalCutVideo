import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL, fetchFile } from '@ffmpeg/util';

export type ExportProgress = {
  stage: 'loading' | 'rendering' | 'encoding' | 'done';
  percent: number;
  message: string;
};

export interface AudioInput {
  inputName: string;
  /** Where this track lands on the output timeline (seconds). */
  startSec: number;
  /** How long this track plays for (seconds). */
  durationSec: number;
  /** Offset within the SOURCE file to start reading from (seconds). */
  sourceStartSec: number;
  volume: number;
}

const ffmpeg = new FFmpeg();
let loaded = false;

// ffmpeg.exec() is one long blocking call with no built-in progress. The
// FFmpeg instance emits a 'progress' event (ratio 0..1) parsed from ffmpeg's
// own output during exec. Route it through a module-level sink set just
// before exec, so the encode stage shows real movement instead of a silent
// wall at whatever percent rendering finished on.
let onEncodeProgress: ((ratio: number) => void) | null = null;
ffmpeg.on('progress', ({ progress }) => {
  if (onEncodeProgress) onEncodeProgress(progress);
});

export async function loadFFmpeg(onProgress?: (p: ExportProgress) => void) {
  if (loaded) return;
  onProgress?.({ stage: 'loading', percent: 0, message: 'Loading ffmpeg.wasm...' });
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });
  loaded = true;
}

export async function writeFrame(name: string, blob: Blob) {
  await ffmpeg.writeFile(name, await fetchFile(blob));
}

export async function writeAudioInput(name: string, source: File | Blob | string) {
  const bytes = typeof source === 'string'
    ? await fetchFile(source)
    : new Uint8Array(await source.arrayBuffer());
  await ffmpeg.writeFile(name, bytes);
}

export async function deleteFile(name: string) {
  try {
    await ffmpeg.deleteFile(name);
  } catch {
    /* already gone */
  }
}

/**
 * Build the ffmpeg arg array for the image-sequence-to-MP4 encode.
 *   - No audio inputs: video only.
 *   - One or more audio inputs: each gets its own adelay/atrim/volume filter
 *     branch; multiple branches are combined via amix=normalize=0 so tracks
 *     don't get quietly attenuated by 1/N.
 * `-t durationSec` caps the output at the composition length even if an
 * audio track runs long or short.
 */
export function buildFfmpegCommand(fps: number, durationSec: number, audioInputs: AudioInput[]): string[] {
  const args: string[] = ['-framerate', String(fps), '-i', 'frame_%06d.png'];
  for (const a of audioInputs) {
    args.push('-i', a.inputName);
  }

  if (audioInputs.length === 0) {
    args.push(
      '-c:v', 'libx264',
      // ffmpeg.wasm is single-threaded; 'medium' makes long exports look
      // frozen. 'ultrafast' trades file size for encode speed, which is the
      // point of moving off real-time capture.
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-t', String(durationSec),
      'output.mp4',
    );
    return args;
  }

  const branches: string[] = [];
  const branchLabels: string[] = [];
  audioInputs.forEach((a, i) => {
    const ffmpegInputIdx = i + 1; // input 0 is the PNG sequence
    const startMs = Math.max(0, Math.round(a.startSec * 1000));
    const label = `a${i}`;
    const srcStart = Math.max(0, a.sourceStartSec);
    branches.push(
      `[${ffmpegInputIdx}:a]` +
      `atrim=start=${srcStart.toFixed(3)}:end=${(srcStart + a.durationSec).toFixed(3)},` +
      `asetpts=PTS-STARTPTS,` +
      `adelay=${startMs}|${startMs},` +
      `volume=${a.volume.toFixed(3)}` +
      `[${label}]`
    );
    branchLabels.push(`[${label}]`);
  });

  let finalAudioLabel: string;
  if (audioInputs.length === 1) {
    finalAudioLabel = branchLabels[0];
  } else {
    branches.push(`${branchLabels.join('')}amix=inputs=${audioInputs.length}:normalize=0[mixed]`);
    finalAudioLabel = '[mixed]';
  }

  args.push(
    '-filter_complex', branches.join(';'),
    '-map', '0:v',
    '-map', finalAudioLabel,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-t', String(durationSec),
    'output.mp4',
  );
  return args;
}

export async function runEncode(cmd: string[], onProgress?: (ratio: number) => void) {
  onEncodeProgress = onProgress ?? null;
  try {
    await ffmpeg.exec(cmd);
  } finally {
    onEncodeProgress = null;
  }
}

export async function readOutput(): Promise<Blob> {
  const data = await ffmpeg.readFile('output.mp4');
  return new Blob([data as Uint8Array<ArrayBuffer>], { type: 'video/mp4' });
}
