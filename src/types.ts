export interface Subtitle {
  id: string;
  text: string;
  start: number;
  end: number;
  fontSize?: number; // e.g. 24
  color?: string; // e.g. '#ffffff'
  backgroundColor?: string; // e.g. 'rgba(0,0,0,0.75)'
  positionY?: 'top' | 'center' | 'bottom';
  positionX?: 'left' | 'center' | 'right';
  fontWeight?: 'normal' | 'bold' | 'extrabold';
  fontStyle?: 'normal' | 'italic';
  hasShadow?: boolean;
}

export interface Voiceover {
  id: string;
  url: string;
  file?: File | Blob;
  clipId?: string; // Optional for backward compatibility, but preferred
  relativeStartTime: number; // Time relative to the clip's start (trimStart)
  type: 'recorded' | 'ai' | 'extracted';
  text?: string;
  duration?: number;
}

export interface VideoClip {
  id: string;
  url: string;
  file?: File | Blob;
  duration: number;
  trimStart: number;
  trimEnd: number;
  type: 'video' | 'image';
  muted?: boolean;
}

export type WatermarkPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center' | 'top-center' | 'bottom-center';

export interface VideoState {
  clips: VideoClip[];
  subtitles: Subtitle[];
  voiceovers: Voiceover[];
  watermarkUrl?: string;
  watermarkSize?: number; // percentage of width (0-100)
  watermarkPosition?: WatermarkPosition; // default 'top-right'
  watermarkOpacity?: number; // percentage (0-100), default 80
  watermarkStart?: number; // seconds; undefined = 0 (start of video)
  watermarkEnd?: number; // seconds; undefined = full video duration
}
