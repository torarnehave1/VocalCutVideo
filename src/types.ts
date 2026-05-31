export interface Subtitle {
  id: string;
  text: string;
  start: number;
  end: number;
}

export interface Voiceover {
  id: string;
  url: string;
  file?: File | Blob;
  clipId?: string; // Optional for backward compatibility, but preferred
  relativeStartTime: number; // Time relative to the clip's start (trimStart)
  type: 'recorded' | 'ai';
  text?: string;
}

export interface VideoClip {
  id: string;
  url: string;
  file?: File | Blob;
  duration: number;
  trimStart: number;
  trimEnd: number;
  type: 'video' | 'image';
}

export interface VideoState {
  clips: VideoClip[];
  subtitles: Subtitle[];
  voiceovers: Voiceover[];
  watermarkUrl?: string;
  watermarkSize?: number; // percentage of width (0-100)
}
