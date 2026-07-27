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
 * Encode a segment-local PNG sequence (frames already written via
 * writeFrame with this prefix) to a video-only MP4. Used for stretches of
 * the timeline that need something drawn on top (subtitle/watermark) and
 * so can't skip the canvas render.
 */
export async function encodeFrameSequence(framePrefix: string, fps: number, width: number, height: number, outName: string, onProgress?: (ratio: number) => void) {
  await runEncode([
    '-framerate', String(fps),
    '-i', `${framePrefix}_%06d.png`,
    '-vf', `scale=${width}:${height}`,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    outName,
  ], onProgress);
}

/**
 * Trim a stretch directly out of an already-written source video file, no
 * canvas/per-frame rendering involved. `-ss` before `-i` is an INPUT seek —
 * ffmpeg jumps to the nearest keyframe instead of decoding from the start,
 * which is what makes this fast on a long source file. It trades a little
 * frame accuracy (may start a few frames early) for speed; acceptable for
 * a skip-canvas fast path.
 */
export async function encodePassthroughVideoSegment(srcName: string, startSec: number, durationSec: number, fps: number, width: number, height: number, outName: string, onProgress?: (ratio: number) => void) {
  await runEncode([
    '-ss', Math.max(0, startSec).toFixed(3),
    '-i', srcName,
    '-t', durationSec.toFixed(3),
    '-vf', `scale=${width}:${height}`,
    '-r', String(fps),
    '-an',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    outName,
  ], onProgress);
}

/** Same as above but for a static image clip held for durationSec. */
export async function encodePassthroughImageSegment(srcName: string, durationSec: number, fps: number, width: number, height: number, outName: string, onProgress?: (ratio: number) => void) {
  await runEncode([
    '-loop', '1',
    '-i', srcName,
    '-t', durationSec.toFixed(3),
    '-vf', `scale=${width}:${height}`,
    '-r', String(fps),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    outName,
  ], onProgress);
}

/** Concatenate segment MP4s (all same codec/res/fps) into one video-only file, stream-copy (fast, no re-encode). */
export async function concatSegments(segmentNames: string[], outName: string) {
  const listContent = segmentNames.map(n => `file '${n}'`).join('\n');
  await ffmpeg.writeFile('concat_list.txt', new TextEncoder().encode(listContent));
  await runEncode(['-f', 'concat', '-safe', '0', '-i', 'concat_list.txt', '-c', 'copy', outName]);
  await deleteFile('concat_list.txt');
}

/**
 * Final pass: mux the (already-encoded) concatenated video against the
 * audio filter graph. `-c:v copy` — the video is already correctly encoded
 * from the segment stage, this is just a remux + audio encode.
 *   - No audio inputs: straight stream-copy remux.
 *   - One or more audio inputs: each gets its own adelay/atrim/volume filter
 *     branch; multiple branches combine via amix=normalize=0 so tracks
 *     don't get quietly attenuated by 1/N.
 * `-t durationSec` caps the output at the composition length even if an
 * audio track runs long or short.
 */
export function buildFfmpegCommand(videoInputName: string, durationSec: number, audioInputs: AudioInput[]): string[] {
  const args: string[] = ['-i', videoInputName];
  for (const a of audioInputs) {
    args.push('-i', a.inputName);
  }

  if (audioInputs.length === 0) {
    args.push('-c:v', 'copy', '-movflags', '+faststart', '-t', String(durationSec), 'output.mp4');
    return args;
  }

  const branches: string[] = [];
  const branchLabels: string[] = [];
  audioInputs.forEach((a, i) => {
    const ffmpegInputIdx = i + 1; // input 0 is the concatenated video
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
    '-c:v', 'copy',
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
