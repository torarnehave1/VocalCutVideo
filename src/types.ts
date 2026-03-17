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

export interface VideoState {
  url: string | null;
  duration: number;
  trimStart: number;
  trimEnd: number;
  subtitles: Subtitle[];
  voiceovers: Voiceover[];
}
