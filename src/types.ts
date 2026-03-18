export interface Subtitle {
  id: string;
  text: string;
  start: number;
  end: number;
}

export interface Voiceover {
  id: string;
  url: string;
  startTime: number;
  type: 'recorded' | 'ai';
  text?: string;
}

export interface VideoClip {
  id: string;
  url: string;
  duration: number;
  trimStart: number;
  trimEnd: number;
}

export interface VideoState {
  clips: VideoClip[];
  subtitles: Subtitle[];
  voiceovers: Voiceover[];
  watermarkUrl?: string;
  watermarkSize?: number; // percentage of width (0-100)
}
