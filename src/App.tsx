import React, { useState, useRef, useEffect } from 'react';
import { 
  Play, Pause, Scissors, Mic, Type, Download, 
  Trash2, Plus, Volume2, Wand2, Upload, ChevronRight, 
  ChevronLeft, X, Save, Image as ImageIcon, GripVertical
} from 'lucide-react';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { get, set } from 'idb-keyval';
import { generateAIVoice } from './services/gemini';
import { Subtitle, Voiceover, VideoState, VideoClip } from './types';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function App() {
  const [videoState, setVideoState] = useState<VideoState>({
    clips: [],
    subtitles: [],
    voiceovers: [],
    watermarkSize: 15,
  });

  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const selectedClip = videoState.clips.find(c => c.id === selectedClipId);

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  // Persistence: Load state
  useEffect(() => {
    const loadState = async () => {
      try {
        const savedState = await get<VideoState>('vocalcut-project');
        if (savedState) {
          // Recreate URLs for files
          const clipsWithUrls = savedState.clips.map(clip => ({
            ...clip,
            type: clip.type || 'video',
            url: clip.file ? URL.createObjectURL(clip.file) : clip.url
          }));
          const voiceoversWithUrls = savedState.voiceovers.map(v => ({
            ...v,
            url: v.file ? URL.createObjectURL(v.file) : v.url
          }));
          
          setVideoState({
            ...savedState,
            clips: clipsWithUrls,
            voiceovers: voiceoversWithUrls
          });
          
          if (clipsWithUrls.length > 0) {
            setSelectedClipId(clipsWithUrls[0].id);
          }
        }
      } catch (error) {
        console.error("Failed to load project:", error);
      } finally {
        setIsLoaded(true);
      }
    };
    loadState();
  }, []);

  // Persistence: Save state
  useEffect(() => {
    if (!isLoaded) return;
    
    const saveState = async () => {
      try {
        // We don't save the URLs as they change every session
        await set('vocalcut-project', videoState);
      } catch (error) {
        console.error("Failed to save project:", error);
      }
    };
    
    const timeout = setTimeout(saveState, 1000);
    return () => clearTimeout(timeout);
  }, [videoState, isLoaded]);
  
  const totalDuration = videoState.clips.reduce((acc, clip) => {
    const duration = (clip.trimEnd || 0) - (clip.trimStart || 0);
    return acc + (isFinite(duration) ? duration : 0);
  }, 0);

  const getGlobalTime = (clipId: string, localTime: number) => {
    let globalTime = 0;
    for (const clip of videoState.clips) {
      if (clip.id === clipId) {
        return globalTime + (localTime - clip.trimStart);
      }
      globalTime += (clip.trimEnd - clip.trimStart);
    }
    return globalTime;
  };

  const getClipGlobalStart = (clipId: string) => {
    let globalStart = 0;
    for (const clip of videoState.clips) {
      if (clip.id === clipId) return globalStart;
      globalStart += (clip.trimEnd - clip.trimStart);
    }
    return 0;
  };


  const getVoiceoverGlobalTime = (v: Voiceover) => {
    if (!v.clipId) return (v as any).startTime || 0;
    let globalTime = 0;
    for (const clip of videoState.clips) {
      if (clip.id === v.clipId) {
        return globalTime + v.relativeStartTime;
      }
      globalTime += (clip.trimEnd - clip.trimStart);
    }
    return -1; // Clip no longer exists
  };

  const getClipAtTime = (globalTime: number) => {
    let accumulatedTime = 0;
    for (const clip of videoState.clips) {
      const clipDuration = clip.trimEnd - clip.trimStart;
      if (globalTime <= accumulatedTime + clipDuration) {
        return { clip, localTime: clip.trimStart + (globalTime - accumulatedTime) };
      }
      accumulatedTime += clipDuration;
    }
    return null;
  };

  const handleTimelineScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left + timelineRef.current.scrollLeft);
    const targetGlobalTime = Math.max(0, Math.min(x / zoom, totalDuration));
    
    const clipInfo = getClipAtTime(targetGlobalTime);
    if (clipInfo) {
      if (clipInfo.clip.id !== selectedClipId) {
        setSelectedClipId(clipInfo.clip.id);
      }
      if (videoRef.current && isFinite(clipInfo.localTime)) {
        videoRef.current.currentTime = clipInfo.localTime;
      }
    }
    setCurrentTime(targetGlobalTime);
  };

  const [activeTab, setActiveTab] = useState<'trim' | 'voice' | 'subtitles' | 'watermark'>('trim');
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [aiText, setAiText] = useState('');
  const [aiVoice, setAiVoice] = useState<'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr'>('Kore');
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [draggingHandle, setDraggingHandle] = useState<{
    clipId: string;
    type: 'start' | 'end';
    initialTrimStart: number;
    initialTrimEnd: number;
    initialClientX: number;
  } | null>(null);
  const [zoom, setZoom] = useState(50); // pixels per second for composition lanes


  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const addTrackFileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Handle Media Upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      const newClips: VideoClip[] = [];
      
      const getDuration = (file: File): Promise<number> => {
        return new Promise((resolve) => {
          if (file.type.startsWith('image/')) {
            resolve(5);
            return;
          }
          const tempVideo = document.createElement('video');
          tempVideo.preload = 'metadata';
          const tempUrl = URL.createObjectURL(file);
          tempVideo.src = tempUrl;
          tempVideo.onloadedmetadata = () => {
            resolve(tempVideo.duration || 0);
          };
          tempVideo.onerror = () => {
            resolve(0);
          };
        });
      };

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const url = URL.createObjectURL(file);
        const id = Math.random().toString(36).substr(2, 9);
        const type = file.type.startsWith('image/') ? 'image' : 'video';
        
        // Fetch actual duration of video or fallback
        const duration = await getDuration(file);
        
        newClips.push({
          id,
          url,
          file,
          duration,
          trimStart: 0,
          trimEnd: duration,
          type
        });
      }
      
      setVideoState(prev => ({
        ...prev,
        clips: [...prev.clips, ...newClips],
      }));

      if (!selectedClipId && newClips.length > 0) {
        setSelectedClipId(newClips[0].id);
      }
    }
  };

  const duplicateClip = (clip: VideoClip) => {
    const id = Math.random().toString(36).substr(2, 9);
    const newClip: VideoClip = {
      ...clip,
      id,
    };

    // Duplicate voiceovers associated with this clip
    const relatedVoiceovers = videoState.voiceovers
      .filter(v => v.clipId === clip.id)
      .map(v => ({
        ...v,
        id: Math.random().toString(36).substr(2, 9),
        clipId: id
      }));

    setVideoState(prev => ({
      ...prev,
      clips: [...prev.clips, newClip],
      voiceovers: [...prev.voiceovers, ...relatedVoiceovers]
    }));
    setSelectedClipId(id);
  };

  const handleSplitClip = () => {
    if (!selectedClip) return;
    
    // Find global start time of selected clip
    const gStart = getClipGlobalStart(selectedClip.id);
    const gEnd = gStart + (selectedClip.trimEnd - selectedClip.trimStart);
    
    // Check if current playhead (currentTime) is within the clip bounds
    if (currentTime > gStart && currentTime < gEnd) {
      const localSplitTime = currentTime - gStart + selectedClip.trimStart;
      
      const clipIndex = videoState.clips.findIndex(c => c.id === selectedClip.id);
      if (clipIndex === -1) return;
      
      const leftClip: VideoClip = {
        ...selectedClip,
        trimEnd: localSplitTime
      };
      
      const rightClip: VideoClip = {
        ...selectedClip,
        id: Math.random().toString(36).substr(2, 9),
        trimStart: localSplitTime
      };
      
      const updatedClips = [...videoState.clips];
      updatedClips.splice(clipIndex, 1, leftClip, rightClip);
      
      setVideoState(prev => ({
        ...prev,
        clips: updatedClips
      }));
      
      // Auto select the right clip
      setSelectedClipId(rightClip.id);
    }
  };


  const onLoadedMetadata = (id: string) => {
    const clip = videoState.clips.find(c => c.id === id);
    if (clip?.type === 'image') return;
    
    if (videoRef.current) {
      const duration = videoRef.current.duration;
      if (isFinite(duration)) {
        setVideoState(prev => ({
          ...prev,
          clips: prev.clips.map(c => c.id === id ? { ...c, duration, trimEnd: duration } : c),
        }));
      }
    }
  };

  const togglePlay = () => {
    if (videoRef.current && selectedClip?.type === 'video') {
      if (isPlaying) {
        videoRef.current.pause();
        setIsPlaying(false);
      } else {
        const playPromise = videoRef.current.play();
        if (playPromise !== undefined) {
          playPromise.catch(error => {
            if (error.name !== 'AbortError') {
              console.error("Playback failed:", error);
            }
          });
        }
        setIsPlaying(true);
      }
    } else {
      setIsPlaying(!isPlaying);
    }
  };

  // Support image playback transition
  useEffect(() => {
    if (!isPlaying || selectedClip?.type !== 'image') return;

    let frameId: number;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const delta = (now - lastTime) / 1000;
      lastTime = now;

      setCurrentTime(prev => {
        const nextTime = prev + delta;
        
        // Find current clip's global start time
        let globalStart = 0;
        for (const clip of videoState.clips) {
          if (clip.id === selectedClip!.id) break;
          globalStart += (clip.trimEnd - clip.trimStart);
        }
        
        const localTime = nextTime - globalStart + selectedClip!.trimStart;

        if (localTime >= selectedClip!.trimEnd) {
          const nextClipInfo = getClipAtTime(nextTime + 0.05);
          if (nextClipInfo && nextClipInfo.clip.id !== selectedClip!.id) {
            setTimeout(() => setSelectedClipId(nextClipInfo.clip.id), 0);
          } else {
            setTimeout(() => setIsPlaying(false), 0);
            return globalStart + (selectedClip!.trimEnd - selectedClip!.trimStart);
          }
        }
        return nextTime;
      });

      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, selectedClipId, selectedClip?.trimEnd, videoState.clips]);

  const handleTimeUpdate = () => {
    if (videoRef.current && selectedClip) {
      const localTime = videoRef.current.currentTime;
      const globalTime = getGlobalTime(selectedClip.id, localTime);
      setCurrentTime(globalTime);
      
      // Handle clip transition or loop
      if (localTime >= selectedClip.trimEnd) {
        const nextClipInfo = getClipAtTime(globalTime + 0.01);
        if (nextClipInfo && nextClipInfo.clip.id !== selectedClip.id) {
          setSelectedClipId(nextClipInfo.clip.id);
          // The useEffect for selectedClipId will handle setting currentTime on the video
        } else {
          // Loop or stop
          if (isFinite(selectedClip.trimStart)) {
            videoRef.current.currentTime = selectedClip.trimStart;
          }
          if (!isPlaying) videoRef.current.pause();
        }
      }
    }
  };

  useEffect(() => {
    if (videoRef.current && selectedClip) {
      // When selected clip changes, we might need to seek to its trim start
      // but only if we are not already at the right global time
      const clipInfo = getClipAtTime(currentTime);
      if (clipInfo && clipInfo.clip.id === selectedClip.id) {
        if (isFinite(clipInfo.localTime) && Math.abs(videoRef.current.currentTime - clipInfo.localTime) > 0.1) {
          videoRef.current.currentTime = clipInfo.localTime;
        }
      } else if (isFinite(selectedClip.trimStart)) {
        videoRef.current.currentTime = selectedClip.trimStart;
      }
    }
  }, [selectedClipId]);

  // Voiceover: Recording
  const startRecording = async () => {
    try {
      // Use high-quality audio constraints to prevent distortion
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 1
        } 
      });

      // Try to find the best supported mime type
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
        ? 'audio/webm;codecs=opus' 
        : 'audio/ogg;codecs=opus';

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 128000 // High bitrate for clarity
      });

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        const audioUrl = URL.createObjectURL(audioBlob);
        addVoiceover(audioUrl, 'recorded');
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Error accessing microphone:", err);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
    }
  };

  // Timeline Dragging Logic
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingHandle) return;

      const deltaPixels = e.clientX - draggingHandle.initialClientX;
      const deltaSeconds = deltaPixels / zoom;

      setVideoState(prev => {
        const clipIndex = prev.clips.findIndex(c => c.id === draggingHandle.clipId);
        if (clipIndex === -1) return prev;

        const clip = prev.clips[clipIndex];
        const newClips = [...prev.clips];

        if (draggingHandle.type === 'start') {
          const newTrimStart = Math.max(0, Math.min(draggingHandle.initialTrimStart + deltaSeconds, draggingHandle.initialTrimEnd - 0.2));
          newClips[clipIndex] = { ...clip, trimStart: newTrimStart };
          if (videoRef.current && isFinite(newTrimStart)) {
            videoRef.current.currentTime = newTrimStart;
          }
        } else {
          const maxDuration = clip.duration || 10;
          const newTrimEnd = Math.max(draggingHandle.initialTrimStart + 0.2, Math.min(draggingHandle.initialTrimEnd + deltaSeconds, maxDuration));
          newClips[clipIndex] = { ...clip, trimEnd: newTrimEnd };
          if (videoRef.current && isFinite(newTrimEnd)) {
            videoRef.current.currentTime = newTrimEnd;
          }
        }

        return { ...prev, clips: newClips };
      });
    };

    const handleMouseUp = () => {
      setDraggingHandle(null);
    };

    if (draggingHandle) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingHandle, zoom]);


  // Voiceover: Upload
  const handleAudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      addVoiceover(url, 'recorded', file.name, file);
    }
  };

  // Voiceover: AI
  const handleGenerateAIVoice = async () => {
    if (!aiText.trim()) return;
    setIsGeneratingAi(true);
    try {
      const audioUrl = await generateAIVoice(aiText, aiVoice);
      addVoiceover(audioUrl, 'ai', aiText);
      setAiText('');
    } catch (err) {
      console.error("AI Voice error:", err);
    } finally {
      setIsGeneratingAi(false);
    }
  };

  // Watermark: Upload
  const handleWatermarkUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setVideoState(prev => ({ ...prev, watermarkUrl: url }));
    }
  };

  const handleExport = async () => {
    if (!videoRef.current || videoState.clips.length === 0) return;

    console.log("Starting export process...");
    setIsExporting(true);
    setExportProgress(0);
    setIsPlaying(false);
    
    const video = videoRef.current;
    video.pause();

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Cap resolution for performance (1080x2336 is very high for real-time capture)
    const MAX_DIM = 1280;
    let w = video.videoWidth || 1280;
    let h = video.videoHeight || 720;
    if (w > MAX_DIM || h > MAX_DIM) {
      const ratio = w / h;
      if (w > h) {
        w = MAX_DIM;
        h = Math.round(MAX_DIM / ratio);
      } else {
        h = MAX_DIM;
        w = Math.round(MAX_DIM * ratio);
      }
    }
    canvas.width = w;
    canvas.height = h;
    console.log(`Canvas initialized (capped): ${canvas.width}x${canvas.height}`);

    const stream = canvas.captureStream(30);
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 });
    
    // Ensure AudioContext is running
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
      // Small delay for audio hardware to warm up
      await new Promise(r => setTimeout(r, 100));
    }

    const dest = audioCtx.createMediaStreamDestination();
    const masterGain = audioCtx.createGain();
    masterGain.gain.value = 1.0;
    masterGain.connect(dest);
    masterGain.connect(audioCtx.destination);

    // Video Audio - Handle potential re-initialization
    let videoSource;
    try {
      videoSource = audioCtx.createMediaElementSource(video);
      videoSource.connect(masterGain);
    } catch (e) {
      console.warn("MediaElementSource already exists or failed to connect:", e);
    }

    const voiceoverAudios: HTMLAudioElement[] = [];
    const triggeredVoiceovers = new Set<string>();
    
    // Load watermark image if exists
    let watermarkImg: HTMLImageElement | null = null;
    if (videoState.watermarkUrl) {
      watermarkImg = new Image();
      watermarkImg.src = videoState.watermarkUrl;
      await new Promise((resolve) => {
        if (watermarkImg) {
          watermarkImg.onload = resolve;
          watermarkImg.onerror = resolve; // Continue even if watermark fails
        } else {
          resolve(null);
        }
      });
    }
    
    // Try to find a supported mime type
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') 
      ? 'video/webm;codecs=vp9,opus' 
      : 'video/webm';
    
    console.log(`Using mimeType: ${mimeType}`);

    const recorder = new MediaRecorder(new MediaStream([
      ...stream.getVideoTracks(),
      ...dest.stream.getAudioTracks()
    ]), { 
      mimeType,
      videoBitsPerSecond: 5000000,
    });

    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      console.log("Recorder stopped, generating blob...");
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vocalcut-export-${Date.now()}.webm`;
      a.click();
      setIsExporting(false);
      audioCtx.close();
      voiceoverAudios.forEach(a => {
        a.pause();
        a.src = "";
      });
    };

    let currentClipIndex = 0;
    let isTransitioning = false;
    let lastLogTime = 0;
    let currentImageElement: HTMLImageElement | null = null;
    let imageLoadPromise: Promise<void> | null = null;

    const processClip = async (index: number) => {
      const clip = videoState.clips[index];
      if (!clip) {
        console.log("No more clips, stopping recorder.");
        recorder.stop();
        return;
      }

      console.log(`Loading Clip ${index + 1}: ${clip.id} (${clip.type})`);
      isTransitioning = true;
      
      if (clip.type === 'video') {
        video.src = clip.url;
        video.muted = false; // Ensure audio is captured
        video.playbackRate = 1.0;
        
        await new Promise((resolve) => {
          const onCanPlay = () => {
            video.removeEventListener('canplay', onCanPlay);
            if (isFinite(clip.trimStart)) {
              video.currentTime = clip.trimStart;
            }
            console.log(`Clip ${index + 1} ready at ${clip.trimStart}s`);
            resolve(null);
          };
          video.addEventListener('canplay', onCanPlay);
          
          // Safety timeout
          setTimeout(() => {
            video.removeEventListener('canplay', onCanPlay);
            resolve(null);
          }, 5000);
        });

        isTransitioning = false;
        try {
          await video.play();
        } catch (e) {
          console.error("Video play failed during export:", e);
          setTimeout(() => video.play().catch(() => {}), 100);
        }
      } else {
        // Image clip
        currentImageElement = new Image();
        currentImageElement.src = clip.url;
        imageLoadPromise = new Promise((resolve) => {
          currentImageElement!.onload = () => resolve();
          currentImageElement!.onerror = () => resolve();
        });
        await imageLoadPromise;
        isTransitioning = false;
        // Images don't "play", but we need a source of truth for time
        // We'll use a manual clock in renderFrame
      }
    };

    recorder.start();
    console.log("Recorder started.");
    await processClip(0);

    // Use a local variable for tracking image time
    let imageStartTime = performance.now();
    let activeExport = true;

    const renderFrame = () => {
      if (!activeExport) return;

      if (!isTransitioning) {
        const clip = videoState.clips[currentClipIndex];
        let localTime = 0;
        
        if (clip.type === 'video') {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          localTime = video.currentTime;
        } else if (currentImageElement) {
          ctx.drawImage(currentImageElement, 0, 0, canvas.width, canvas.height);
          // Calculate local time for the image based on export clock
          const now = performance.now();
          localTime = clip.trimStart + (now - imageStartTime) / 1000;
        }

        const globalTime = getGlobalTime(clip.id, localTime);

        // Heartbeat log
        const now = Date.now();
        if (now - lastLogTime > 1000) {
          console.log(`Export Heartbeat: Global ${globalTime.toFixed(2)}s, Local ${localTime.toFixed(2)}s, Progress ${Math.round((globalTime / (totalDuration || 1)) * 100)}%, VideoPaused: ${video.paused}`);
          lastLogTime = now;
          
          // Kickstart if stuck
          if (video.paused && !isTransitioning) {
            console.log("Kickstarting stalled video...");
            video.play().catch(() => {});
          }
        }

        // Subtitles
        const activeSubs = showSubtitles ? videoState.subtitles.filter(s => globalTime >= s.start && globalTime <= s.end) : [];
        if (activeSubs.length > 0) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
          ctx.font = `${canvas.height * 0.05}px Inter, sans-serif`;
          ctx.textAlign = 'center';
          activeSubs.forEach((sub, i) => {
            const metrics = ctx.measureText(sub.text);
            const padding = 20;
            const rectWidth = metrics.width + padding * 2;
            const rectHeight = canvas.height * 0.07;
            ctx.fillRect(canvas.width / 2 - rectWidth / 2, canvas.height * 0.85 - rectHeight / 2 + (i * rectHeight * 1.2), rectWidth, rectHeight);
            ctx.fillStyle = 'white';
            ctx.fillText(sub.text, canvas.width / 2, canvas.height * 0.85 + (i * rectHeight * 1.2) + 10);
          });
        }

        // Voiceovers
        videoState.voiceovers.forEach(v => {
          const vGlobalTime = getVoiceoverGlobalTime(v);
          if (vGlobalTime === -1) return;

          if (!triggeredVoiceovers.has(v.id) && Math.abs(globalTime - vGlobalTime) < 0.1) {
            triggeredVoiceovers.add(v.id);
            console.log(`Triggering voiceover: ${v.id}`);
            const audio = new Audio(v.url);
            const source = audioCtx.createMediaElementSource(audio);
            source.connect(masterGain);
            audio.play().catch(() => {});
            voiceoverAudios.push(audio);
          }
        });

        // Draw Watermark in top right corner
        if (watermarkImg) {
          const padding = canvas.width * 0.03;
          const sizePercentage = (videoState.watermarkSize || 15) / 100;
          const size = canvas.width * sizePercentage;
          const aspect = watermarkImg.width / watermarkImg.height;
          let drawW = size;
          let drawH = size / aspect;
          
          if (drawH > size) {
            drawH = size;
            drawW = size * aspect;
          }
          
          ctx.globalAlpha = 0.8; // Slight transparency
          ctx.drawImage(watermarkImg, canvas.width - drawW - padding, padding, drawW, drawH);
          ctx.globalAlpha = 1.0;
        }

        setExportProgress((globalTime / (totalDuration || 1)) * 100);

        // Completion check: within 0.1s of end OR video naturally ended
        if ((clip.type === 'video' && (localTime >= clip.trimEnd - 0.1 || video.ended)) || 
            (clip.type === 'image' && localTime >= clip.trimEnd)) {
          if (clip.type === 'video') video.pause();
          currentClipIndex++;
          
          if (currentClipIndex < videoState.clips.length) {
            imageStartTime = performance.now(); // Reset image clock
            processClip(currentClipIndex);
          } else {
            console.log("All clips finished. Finalizing export...");
            activeExport = false;
            if (recorder.state !== 'inactive') {
              recorder.stop();
            }
            return;
          }
        }
      } else {
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'white';
        ctx.font = '30px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Preparing next segment...', canvas.width / 2, canvas.height / 2);
      }

      // Robust loop
      if (document.hidden) {
        setTimeout(renderFrame, 16);
      } else {
        requestAnimationFrame(renderFrame);
      }
    };

    renderFrame();
  };

  const addVoiceover = (url: string, type: 'recorded' | 'ai', text?: string, file?: File | Blob) => {
    const clipInfo = getClipAtTime(currentTime);
    
    // Calculate relative start time (time within the current clip's duration)
    let relativeStartTime = 0;
    if (clipInfo) {
      let clipGlobalStart = 0;
      for (const c of videoState.clips) {
        if (c.id === clipInfo.clip.id) break;
        clipGlobalStart += (c.trimEnd - c.trimStart);
      }
      relativeStartTime = currentTime - clipGlobalStart;
    }

    const newVoiceover: Voiceover = {
      id: Math.random().toString(36).substr(2, 9),
      url,
      file,
      clipId: clipInfo?.clip.id,
      relativeStartTime,
      type,
      text
    };
    setVideoState(prev => ({
      ...prev,
      voiceovers: [...prev.voiceovers, newVoiceover]
    }));
  };

  // Subtitles
  const addSubtitle = () => {
    const newSub: Subtitle = {
      id: Math.random().toString(36).substr(2, 9),
      text: 'New Subtitle',
      start: currentTime,
      end: Math.min(currentTime + 3, totalDuration)
    };
    setVideoState(prev => ({
      ...prev,
      subtitles: [...prev.subtitles, newSub]
    }));
  };

  const updateSubtitle = (id: string, updates: Partial<Subtitle>) => {
    setVideoState(prev => ({
      ...prev,
      subtitles: prev.subtitles.map(s => s.id === id ? { ...s, ...updates } : s)
    }));
  };

  const removeSubtitle = (id: string) => {
    setVideoState(prev => ({
      ...prev,
      subtitles: prev.subtitles.filter(s => s.id !== id)
    }));
  };

  const removeVoiceover = (id: string) => {
    setVideoState(prev => ({
      ...prev,
      voiceovers: prev.voiceovers.filter(v => v.id !== id)
    }));
  };

  // Active subtitles for display
  const activeSubtitles = videoState.subtitles.filter(
    s => currentTime >= s.start && currentTime <= s.end
  );

  // Play voiceovers when their time comes
  useEffect(() => {
    videoState.voiceovers.forEach(v => {
      const vGlobalTime = getVoiceoverGlobalTime(v);
      if (vGlobalTime === -1) return;

      // Simple threshold check
      if (Math.abs(currentTime - vGlobalTime) < 0.1 && isPlaying) {
        const audio = new Audio(v.url);
        audio.play().catch(() => {});
      }
    });
  }, [currentTime, isPlaying, videoState.voiceovers]);

  if (!isLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <div className="w-12 h-12 border-4 border-accent/20 border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-bg overflow-hidden">
      {/* Header */}
      <header className="h-16 border-b border-border flex items-center justify-between px-6 glass z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-accent rounded-lg flex items-center justify-center">
            <Scissors className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-lg tracking-tight">VocalCut</span>
        </div>
        <div className="flex items-center gap-4">
          {isExporting && (
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-3 px-4 py-1.5 bg-white/5 rounded-full border border-white/10">
                <span className="text-[9px] font-bold text-accent/60 uppercase tracking-widest">Recording</span>
                <div className="w-20 h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-accent transition-all duration-300"
                    style={{ width: `${exportProgress}%` }}
                  />
                </div>
                <span className="text-[10px] font-mono text-accent font-bold">{Math.round(exportProgress)}%</span>
              </div>
              <span className="text-[9px] text-slate-500 font-medium animate-pulse">Keep tab active for faster export</span>
            </div>
          )}
          <button 
            onClick={() => window.location.reload()}
            className="p-2 hover:bg-white/10 rounded-full transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
          <button 
            onClick={handleExport}
            disabled={isExporting}
            className="bg-accent hover:bg-accent-hover disabled:opacity-50 text-white px-4 py-2 rounded-full flex items-center gap-2 text-sm font-medium transition-all"
          >
            {isExporting ? (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            {isExporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </header>

      {/* Hidden file uploader for adding extra tracks */}
      <input 
        type="file" 
        ref={addTrackFileInputRef}
        accept="video/*,image/*" 
        multiple 
        onChange={handleFileUpload} 
        className="hidden" 
      />

      <main className="flex-1 flex overflow-hidden">
        {/* Left Sidebar: Tools */}
        <aside className="w-16 border-r border-border flex flex-col items-center py-6 gap-6 glass">
          <ToolButton 
            active={activeTab === 'trim'} 
            onClick={() => setActiveTab('trim')}
            icon={<Scissors className="w-5 h-5" />}
            label="Trim"
          />
          <ToolButton 
            active={activeTab === 'voice'} 
            onClick={() => setActiveTab('voice')}
            icon={<Mic className="w-5 h-5" />}
            label="Voice"
          />
          <ToolButton 
            active={activeTab === 'subtitles'} 
            onClick={() => setActiveTab('subtitles')}
            icon={<Type className="w-5 h-5" />}
            label="Subs"
          />
          <ToolButton 
            active={activeTab === 'watermark'} 
            onClick={() => setActiveTab('watermark')}
            icon={<ImageIcon className="w-5 h-5" />}
            label="Logo"
          />
        </aside>

        {/* Center: Preview & Timeline */}
        <section className="flex-1 flex flex-col relative bg-black/40">
          <div className="flex-1 flex items-center justify-center p-8 relative">
            {videoState.clips.length > 0 ? (
              <div className="relative max-w-4xl w-full aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl border border-white/5">
                {selectedClip?.type === 'video' ? (
                  <video 
                    key={selectedClip.id}
                    ref={videoRef}
                    src={selectedClip.url}
                    onLoadedMetadata={() => onLoadedMetadata(selectedClip.id)}
                    onTimeUpdate={handleTimeUpdate}
                    className="w-full h-full object-contain"
                    onClick={togglePlay}
                  />
                ) : selectedClip?.type === 'image' ? (
                  <img 
                    key={selectedClip.id}
                    src={selectedClip.url}
                    className="w-full h-full object-contain cursor-pointer"
                    onClick={togglePlay}
                    referrerPolicy="no-referrer"
                  />
                ) : null}
              
              {/* Subtitle Overlay */}
              <AnimatePresence>
                {showSubtitles && activeSubtitles.map(sub => (
                  <motion.div
                    key={sub.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="absolute bottom-12 left-0 right-0 text-center px-4 pointer-events-none"
                  >
                    <span className="bg-black/80 text-white px-4 py-2 rounded-lg text-lg font-medium backdrop-blur-sm border border-white/10">
                      {sub.text}
                    </span>
                  </motion.div>
                ))}
              </AnimatePresence>

              {/* Watermark Overlay */}
              {videoState.watermarkUrl && (
                <div 
                  className="absolute top-4 right-4 pointer-events-none"
                  style={{ width: `${videoState.watermarkSize || 15}%`, height: 'auto', maxWidth: '30%' }}
                >
                  <img 
                    src={videoState.watermarkUrl} 
                    alt="Watermark" 
                    className="w-full h-full object-contain opacity-80"
                    referrerPolicy="no-referrer"
                  />
                </div>
              )}

              {/* Playback Overlay */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                {!isPlaying && (
                  <motion.div 
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="w-20 h-20 bg-white/10 backdrop-blur-xl rounded-full flex items-center justify-center border border-white/20"
                  >
                    <Play className="w-10 h-10 text-white fill-white ml-1" />
                  </motion.div>
                )}
              </div>
            </div>
          ) : (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="max-w-md w-full glass p-12 rounded-3xl text-center space-y-8"
              >
                <div className="w-20 h-20 bg-accent/20 rounded-full flex items-center justify-center mx-auto">
                  <Upload className="w-10 h-10 text-accent" />
                </div>
                <div className="space-y-2">
                  <h1 className="text-3xl font-bold tracking-tight">VocalCut</h1>
                  <p className="text-slate-400">Upload video or images to start editing with AI voices and subtitles.</p>
                </div>
                <label className="block">
                  <span className="sr-only">Choose media files</span>
                  <input 
                    type="file" 
                    accept="video/*,image/*" 
                    multiple
                    onChange={handleFileUpload}
                    className="block w-full text-sm text-slate-500
                      file:mr-4 file:py-3 file:px-6
                      file:rounded-full file:border-0
                      file:text-sm file:font-semibold
                      file:bg-accent file:text-white
                      hover:file:bg-accent-hover cursor-pointer"
                  />
                </label>
              </motion.div>
            )}
          </div>

          {/* Timeline and Composition Layers */}
          <div className="h-[340px] glass border-t border-border flex flex-col overflow-hidden">
            {/* Timeline Toolbar */}
            <div className="h-12 border-b border-border bg-black/30 flex items-center justify-between px-6 shrink-0 select-none">
              <div className="flex items-center gap-4">
                <button 
                  onClick={togglePlay}
                  className="w-8 h-8 bg-white text-black rounded-full flex items-center justify-center hover:scale-105 transition-transform"
                >
                  {isPlaying ? <Pause className="w-4 h-4 fill-black" /> : <Play className="w-4 h-4 fill-black ml-0.5" />}
                </button>

                <button 
                  onClick={handleSplitClip}
                  disabled={!selectedClip}
                  className="h-8 px-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg flex items-center gap-1.5 text-xs font-semibold text-slate-200 transition-colors disabled:opacity-40"
                  title="Split selected clip at current playhead position"
                >
                  <Scissors className="w-3.5 h-3.5 text-accent" />
                  <span>Split Clip</span>
                </button>
              </div>

              {/* Time displays & Zoom */}
              <div className="flex items-center gap-3">
                <div className="text-xs font-mono bg-white/5 border border-white/10 rounded-lg px-2.5 py-1 text-slate-300">
                  <span className="text-accent font-bold">{formatTime(currentTime)}</span>
                  <span className="text-slate-500 mx-1.5">/</span>
                  <span className="text-slate-400">{formatTime(totalDuration)}</span>
                </div>

                {/* Zoom input */}
                <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1">
                  <span className="text-[10px] font-bold text-slate-400">ZOOM</span>
                  <input 
                    type="range"
                    min="20"
                    max="150"
                    value={zoom}
                    onChange={(e) => setZoom(parseInt(e.target.value))}
                    className="w-16 h-1 bg-white/15 rounded-full appearance-none cursor-pointer accent-accent"
                  />
                  <span className="text-[9px] font-mono text-slate-500">{zoom}px/s</span>
                </div>
              </div>
            </div>

            {/* Timeline Workspace (Multi-Track Grid scrollable both X and Y) */}
            <div className="flex-1 flex overflow-hidden">
              {/* Left Column: Track Labels and Actions (fixed width) */}
              <div className="w-48 bg-black/40 border-r border-border flex flex-col select-none overflow-y-auto custom-scrollbar">
                {/* Ruler Track spacer */}
                <div className="h-8 border-b border-white/10 flex items-center justify-between px-3 bg-white/[0.02] shrink-0">
                  <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold font-mono">Tracks</span>
                  <button 
                    onClick={() => addTrackFileInputRef.current?.click()}
                    className="p-1 hover:bg-white/10 text-accent rounded flex items-center gap-1 text-[10px] font-bold"
                    id="add-track-ruler"
                    title="Add Track (Upload Video/Image)"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>NEW</span>
                  </button>
                </div>

                {/* Subtitle Lane Label */}
                <div className="h-12 border-b border-white/5 flex items-center px-3 justify-between bg-yellow-500/[0.01] shrink-0">
                  <div className="flex items-center gap-2">
                    <Type className="w-3.5 h-3.5 text-yellow-500/80" />
                    <span className="text-xs font-bold text-slate-300">Subtitles</span>
                  </div>
                  <span className="text-[9px] font-mono text-slate-500 bg-white/5 px-1.5 py-0.5 rounded">AUTO</span>
                </div>

                {/* Video / Image Clip Lanes */}
                {videoState.clips.map((clip, idx) => (
                  <div 
                    key={clip.id} 
                    className={cn(
                      "h-12 border-b border-white/5 flex items-center justify-between px-3 transition-colors shrink-0",
                      selectedClipId === clip.id ? "bg-accent/5" : "bg-black/10"
                    )}
                  >
                    <div 
                      className="flex-1 flex flex-col min-w-0 cursor-pointer"
                      onClick={() => setSelectedClipId(clip.id)}
                    >
                      <span className="text-xs font-bold text-slate-300 truncate">
                        {clip.type === 'image' ? 'Image' : 'Video'}-{idx + 1}
                      </span>
                      <span className="text-[9px] font-mono text-slate-500">
                        {clip.type === 'image' ? 'still image' : `${clip.duration.toFixed(1)}s max`}
                      </span>
                    </div>

                    {/* Left Panel Actions */}
                    <div className="flex items-center gap-0.5">
                      <button 
                        disabled={idx === 0}
                        onClick={() => {
                          const newClips = [...videoState.clips];
                          const temp = newClips[idx];
                          newClips[idx] = newClips[idx - 1];
                          newClips[idx - 1] = temp;
                          setVideoState(prev => ({ ...prev, clips: newClips }));
                        }}
                        className="p-1 hover:bg-white/10 text-slate-400 rounded disabled:opacity-30"
                        title="Move Clip Up"
                      >
                        <ChevronLeft className="w-3 h-3 rotate-90" />
                      </button>
                      <button 
                        disabled={idx === videoState.clips.length - 1}
                        onClick={() => {
                          const newClips = [...videoState.clips];
                          const temp = newClips[idx];
                          newClips[idx] = newClips[idx + 1];
                          newClips[idx + 1] = temp;
                          setVideoState(prev => ({ ...prev, clips: newClips }));
                        }}
                        className="p-1 hover:bg-white/10 text-slate-400 rounded disabled:opacity-30"
                        title="Move Clip Down"
                      >
                        <ChevronRight className="w-3 h-3 rotate-90" />
                      </button>
                      <button 
                        onClick={() => {
                          setVideoState(prev => ({
                            ...prev,
                            clips: prev.clips.filter(c => c.id !== clip.id)
                          }));
                          if (selectedClipId === clip.id) setSelectedClipId(null);
                        }}
                        className="p-1 hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded transition-colors"
                        title="Delete Track"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}

                {/* Add Track Action Row */}
                <button
                  onClick={() => addTrackFileInputRef.current?.click()}
                  className="h-10 border-b border-white/5 flex items-center justify-center gap-2 px-3 text-xs font-semibold text-accent/80 hover:text-accent bg-accent/5 hover:bg-accent/10 transition-colors cursor-pointer shrink-0"
                  id="add-track-button"
                  title="Add Track (Upload Video/Image)"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Track</span>
                </button>

                {/* Voiceover Track Label */}
                <div className="h-12 border-b border-white/5 flex items-center px-3 justify-between bg-purple-500/[0.01] shrink-0">
                  <div className="flex items-center gap-2">
                    <Mic className="w-3.5 h-3.5 text-purple-500/80" />
                    <span className="text-xs font-bold text-slate-300">Voiceovers</span>
                  </div>
                  <span className="text-[9px] font-mono text-slate-500 bg-white/5 px-1.5 py-0.5 rounded font-mono">AUDIO</span>
                </div>
              </div>

              {/* Right Column: Interactive Timeline Tracks (horizontal scrollable) */}
              <div 
                ref={timelineRef}
                className="flex-1 relative overflow-x-auto overflow-y-auto select-none bg-black/25 custom-scrollbar"
                style={{ direction: 'ltr' }}
              >
                {/* Timescale Track Width calculated dynamically */}
                <div 
                  className="relative flex flex-col min-h-full"
                  style={{ width: `${Math.max(600, (totalDuration + 5) * zoom)}px` }}
                >
                  
                  {/* Ruler Row */}
                  <div 
                    className="h-8 bg-black/45 border-b border-white/10 relative cursor-pointer"
                    onClick={handleTimelineScrub}
                  >
                    {Array.from({ length: Math.ceil(totalDuration) + 6 }).map((_, i) => (
                      <div 
                        key={i} 
                        className="absolute bottom-0 flex flex-col items-center select-none"
                        style={{ left: `${i * zoom}px` }}
                      >
                        {/* Tick mark */}
                        <div className={cn("w-px bg-white/20", i % 5 === 0 ? "h-3 bg-white/50" : "h-1.5")} />
                        {/* Label */}
                        {i % 5 === 0 && (
                          <span className="text-[9px] font-mono text-slate-400 absolute bottom-3 translate-x-[1px]">
                            {i}s
                          </span>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Infinite Grid Lines */}
                  {Array.from({ length: Math.ceil(totalDuration) + 6 }).map((_, i) => (
                    <div 
                      key={i} 
                      className="absolute top-8 bottom-0 border-l border-white/5 pointer-events-none"
                      style={{ left: `${i * zoom}px` }}
                    />
                  ))}

                  {/* Subtitles Track Lane */}
                  <div className="h-12 border-b border-white/5 relative bg-yellow-500/[0.01]">
                    {videoState.subtitles.map(sub => (
                      <div
                        key={sub.id}
                        className="absolute top-2 bottom-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-2 text-[10px] text-yellow-300 font-bold flex items-center justify-between hover:bg-yellow-500/20 transition-colors cursor-pointer"
                        style={{ 
                          left: `${sub.start * zoom}px`, 
                          width: `${(sub.end - sub.start) * zoom}px` 
                        }}
                        onClick={() => setActiveTab('subtitles')}
                      >
                        <span className="truncate">{sub.text}</span>
                      </div>
                    ))}
                  </div>

                  {/* Media/Clip Tracks Lanes */}
                  {videoState.clips.map((clip) => {
                    const gStart = getClipGlobalStart(clip.id);
                    return (
                      <div 
                        key={clip.id} 
                        className={cn(
                          "h-12 border-b border-white/5 relative flex items-center transition-colors",
                          selectedClipId === clip.id ? "bg-accent/5" : ""
                        )}
                      >
                        <div
                          className={cn(
                            "absolute top-1.5 bottom-1.5 rounded-xl border flex items-center justify-between group cursor-pointer transition-all px-3 overflow-hidden",
                            selectedClipId === clip.id 
                              ? "bg-accent/20 border-accent shadow-[0_0_15px_rgba(59,130,246,0.3)] z-10" 
                              : "bg-white/5 border-white/10 hover:bg-white/10"
                          )}
                          style={{ 
                            left: `${gStart * zoom}px`, 
                            width: `${(clip.trimEnd - clip.trimStart) * zoom}px` 
                          }}
                          onClick={() => setSelectedClipId(clip.id)}
                        >
                          {/* Left handle for trimStart */}
                          {selectedClipId === clip.id && (
                            <div 
                              className="absolute left-0 top-0 bottom-0 w-2.5 bg-accent/80 hover:bg-accent cursor-col-resize z-25 flex items-center justify-center"
                              onMouseDown={(e) => {
                                e.stopPropagation();
                                setDraggingHandle({
                                  clipId: clip.id,
                                  type: 'start',
                                  initialTrimStart: clip.trimStart,
                                  initialTrimEnd: clip.trimEnd,
                                  initialClientX: e.clientX
                                });
                              }}
                            >
                              <div className="w-0.5 h-3 bg-white/70 rounded-full" />
                            </div>
                          )}

                          {/* Center Content */}
                          <div className="flex-1 flex items-center gap-1.5 overflow-hidden select-none pointer-events-none px-1">
                            {clip.type === 'image' ? (
                              <ImageIcon className="w-3 h-3 text-accent shrink-0" />
                            ) : (
                              <Scissors className="w-3 h-3 text-accent shrink-0" />
                            )}
                            <span className="text-[10px] font-bold uppercase tracking-wider truncate">
                              {clip.type === 'image' ? 'Image' : 'Video'}-{clip.id.substring(0, 4)}
                            </span>
                            <span className="text-[9px] text-slate-400 font-mono">
                              ({(clip.trimEnd - clip.trimStart).toFixed(1)}s)
                            </span>
                          </div>

                          {/* Right handle for trimEnd */}
                          {selectedClipId === clip.id && (
                            <div 
                              className="absolute right-0 top-0 bottom-0 w-2.5 bg-accent/80 hover:bg-accent cursor-col-resize z-25 flex items-center justify-center"
                              onMouseDown={(e) => {
                                e.stopPropagation();
                                setDraggingHandle({
                                  clipId: clip.id,
                                  type: 'end',
                                  initialTrimStart: clip.trimStart,
                                  initialTrimEnd: clip.trimEnd,
                                  initialClientX: e.clientX
                                });
                              }}
                            >
                              <div className="w-0.5 h-3 bg-white/70 rounded-full" />
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {/* Voiceovers Track Lane */}
                  <div className="h-12 border-b border-white/5 relative bg-purple-500/[0.01]">
                    {videoState.voiceovers.map(v => {
                      const vGlobalStart = getVoiceoverGlobalTime(v);
                      if (vGlobalStart === -1) return null;
                      // estimate visual duration as 4s
                      const vDur = 4;
                      return (
                        <div
                          key={v.id}
                          className="absolute top-2 bottom-2 bg-purple-500/10 border border-purple-500/30 rounded-lg px-2 text-[10px] text-purple-300 font-bold flex items-center gap-1 hover:bg-purple-500/20 transition-colors cursor-pointer"
                          style={{ 
                            left: `${vGlobalStart * zoom}px`, 
                            width: `${vDur * zoom}px` 
                          }}
                          onClick={() => setActiveTab('voice')}
                        >
                          <Mic className="w-3 h-3 text-purple-400 shrink-0" />
                          <span className="truncate">{v.text || 'Microphone Recording'}</span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Playhead indicator bar */}
                  <div 
                    className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-30 pointer-events-none shadow-[0_0_8px_rgba(239,68,68,0.8)]"
                    style={{ left: `${currentTime * zoom}px` }}
                  >
                    {/* Tick Handle */}
                    <div className="absolute top-0 -left-1.5 w-3.5 h-3.5 bg-red-500 rounded-b-full shadow border border-white/50" />
                  </div>

                </div>
              </div>
            </div>
          </div>

        </section>

        {/* Right Sidebar: Contextual Panel */}
        <aside className="w-80 border-l border-border glass flex flex-col overflow-hidden">
          <div className="p-6 border-b border-border flex items-center justify-between">
            <h2 className="font-bold capitalize">{activeTab}</h2>
            <div className="text-xs font-mono text-slate-500">
              {videoState.subtitles.length + videoState.voiceovers.length} Items
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
            {activeTab === 'trim' && (
              <div className="space-y-6">
                <div className="space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Clips</h3>
                  <Reorder.Group 
                    axis="y" 
                    values={videoState.clips} 
                    onReorder={(newClips) => setVideoState(prev => ({ ...prev, clips: newClips }))}
                    className="space-y-2"
                  >
                    {videoState.clips.map((clip, index) => (
                      <Reorder.Item 
                        key={clip.id} 
                        value={clip}
                        onClick={() => setSelectedClipId(clip.id)}
                        className={cn(
                          "group flex items-center gap-3 p-3 rounded-xl border transition-colors duration-150 select-none cursor-pointer",
                          selectedClipId === clip.id 
                            ? "bg-accent/10 border-accent/30" 
                            : "bg-white/5 border-white/10 hover:bg-white/10"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <GripVertical className="w-4 h-4 text-slate-600 group-hover:text-slate-400 cursor-grab active:cursor-grabbing" />
                          <div className="w-6 h-6 bg-white/10 rounded flex items-center justify-center text-[10px] font-bold">
                            {index + 1}
                          </div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">
                            {clip.type === 'image' ? 'Image' : 'Clip'} {index + 1}
                          </div>
                          <div className="text-[10px] text-slate-500 font-mono">
                            {formatTime(clip.trimEnd - clip.trimStart)}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              duplicateClip(clip);
                            }}
                            className="p-1.5 hover:bg-accent/20 text-slate-500 hover:text-accent rounded-lg"
                            title="Duplicate Clip"
                          >
                            <Plus className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              setVideoState(prev => ({
                                ...prev,
                                clips: prev.clips.filter(c => c.id !== clip.id)
                              }));
                              if (selectedClipId === clip.id) setSelectedClipId(null);
                            }}
                            className="p-1.5 hover:bg-red-500/20 text-slate-500 hover:text-red-500 rounded-lg"
                            title="Delete Clip"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </Reorder.Item>
                    ))}
                  </Reorder.Group>
                  
                  <label className="w-full py-3 bg-white/5 hover:bg-white/10 border border-dashed border-white/20 rounded-xl font-bold flex items-center justify-center gap-2 cursor-pointer transition-all">
                      <Plus className="w-4 h-4" />
                      <span className="text-sm">Add Media</span>
                      <input 
                        type="file" 
                        accept="video/*,image/*" 
                        multiple
                        onChange={handleFileUpload}
                        className="hidden"
                      />
                    </label>
                  </div>

                {selectedClip && (
                  <div className="space-y-6 pt-6 border-t border-border">
                    <div className="space-y-4">
                      <label className="text-sm font-medium text-slate-400">Start Time</label>
                      <div className="flex items-center gap-4">
                        <input 
                          type="number" 
                          value={selectedClip.trimStart.toFixed(2)}
                          onChange={(e) => setVideoState(prev => ({ 
                            ...prev, 
                            clips: prev.clips.map(c => c.id === selectedClip.id ? { ...c, trimStart: Math.max(0, parseFloat(e.target.value)) } : c)
                          }))}
                          className="flex-1 bg-white/5 border border-border rounded-lg px-3 py-2 text-sm font-mono"
                        />
                        <button 
                          onClick={() => setVideoState(prev => ({ 
                            ...prev, 
                            clips: prev.clips.map(c => c.id === selectedClip.id ? { ...c, trimStart: currentTime } : c)
                          }))}
                          className="p-2 bg-accent/10 text-accent rounded-lg hover:bg-accent/20"
                        >
                          <Save className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <div className="space-y-4">
                      <label className="text-sm font-medium text-slate-400">
                        {selectedClip.type === 'image' ? 'Duration' : 'End Time'}
                      </label>
                      <div className="flex items-center gap-4">
                        <input 
                          type="number" 
                          value={selectedClip.trimEnd.toFixed(2)}
                          onChange={(e) => setVideoState(prev => ({ 
                            ...prev, 
                            clips: prev.clips.map(c => c.id === selectedClip.id ? { 
                              ...c, 
                              trimEnd: parseFloat(e.target.value),
                              duration: c.type === 'image' ? Math.max(c.duration, parseFloat(e.target.value)) : c.duration
                            } : c)
                          }))}
                          className="flex-1 bg-white/5 border border-border rounded-lg px-3 py-2 text-sm font-mono"
                        />
                        <button 
                          onClick={() => setVideoState(prev => ({ 
                            ...prev, 
                            clips: prev.clips.map(c => c.id === selectedClip.id ? { ...c, trimEnd: currentTime } : c)
                          }))}
                          className="p-2 bg-accent/10 text-accent rounded-lg hover:bg-accent/20"
                        >
                          <Save className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <button 
                      onClick={() => duplicateClip(selectedClip)}
                      className="w-full py-4 bg-accent text-white rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-accent-hover transition-all shadow-lg shadow-accent/20"
                    >
                      <Plus className="w-5 h-5" />
                      Add Selection as New Clip
                    </button>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'voice' && (
              <div className="space-y-8">
                {/* Record Button */}
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Your Voice</h3>
                  <div className="flex flex-col gap-3">
                    <button 
                      onClick={isRecording ? stopRecording : startRecording}
                      className={cn(
                        "w-full py-4 rounded-2xl flex items-center justify-center gap-3 font-bold transition-all",
                        isRecording 
                          ? "bg-red-500 text-white animate-pulse" 
                          : "bg-white/5 hover:bg-white/10 text-white border border-white/10"
                      )}
                    >
                      <Mic className={cn("w-5 h-5", isRecording && "fill-white")} />
                      {isRecording ? "Stop Recording" : "Record Voiceover"}
                    </button>
                    
                    <label className="w-full py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl font-bold flex items-center justify-center gap-2 cursor-pointer transition-all">
                      <Upload className="w-4 h-4" />
                      <span className="text-sm">Upload Audio File</span>
                      <input 
                        type="file" 
                        accept="audio/*" 
                        onChange={handleAudioUpload}
                        className="hidden"
                      />
                    </label>
                  </div>
                </div>

                {/* AI Voice */}
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">AI Voice</h3>
                  <div className="grid grid-cols-5 gap-2">
                    {(['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'] as const).map(v => (
                      <button
                        key={v}
                        onClick={() => setAiVoice(v)}
                        className={cn(
                          "py-2 text-[10px] font-bold rounded-lg border transition-all",
                          aiVoice === v 
                            ? "bg-accent border-accent text-white" 
                            : "bg-white/5 border-white/10 text-slate-400 hover:bg-white/10"
                        )}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                  <textarea 
                    value={aiText}
                    onChange={(e) => setAiText(e.target.value)}
                    placeholder="Enter text for AI voiceover..."
                    className="w-full bg-white/5 border border-border rounded-xl p-4 text-sm min-h-[100px] focus:ring-1 ring-accent outline-none"
                  />
                  <button 
                    onClick={handleGenerateAIVoice}
                    disabled={isGeneratingAi || !aiText.trim()}
                    className="w-full py-3 bg-accent hover:bg-accent-hover disabled:opacity-50 text-white rounded-xl font-bold flex items-center justify-center gap-2 transition-all"
                  >
                    {isGeneratingAi ? (
                      <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      <Wand2 className="w-5 h-5" />
                    )}
                    Generate AI Voice
                  </button>
                </div>

                {/* List of Voiceovers */}
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Timeline</h3>
                  <div className="space-y-3">
                    {videoState.voiceovers.map(v => (
                      <div key={v.id} className="p-3 bg-white/5 rounded-xl border border-border flex items-center justify-between group">
                        <div className="flex items-center gap-3">
                          <div className={cn("p-2 rounded-lg", v.type === 'ai' ? "bg-purple-500/20 text-purple-400" : "bg-blue-500/20 text-blue-400")}>
                            {v.type === 'ai' ? <Wand2 className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                          </div>
                          <div>
                            <div className="text-[10px] font-bold text-accent uppercase mb-1">
                              {videoState.clips.find(c => c.id === v.clipId)?.type === 'image' ? 'Image' : 'Clip'} Associated
                            </div>
                            <div className="text-xs font-mono text-slate-400">{formatTime(getVoiceoverGlobalTime(v))}</div>
                            <div className="text-sm font-medium truncate max-w-[120px]">{v.text || 'Voice Recording'}</div>
                          </div>
                        </div>
                        <button 
                          onClick={() => removeVoiceover(v.id)}
                          className="p-2 text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'subtitles' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/10">
                  <div className="space-y-0.5">
                    <div className="text-sm font-bold">Burn-in Subtitles</div>
                    <div className="text-[10px] text-slate-500">Show subtitles in preview and export</div>
                  </div>
                  <button 
                    onClick={() => setShowSubtitles(!showSubtitles)}
                    className={cn(
                      "w-12 h-6 rounded-full transition-all relative",
                      showSubtitles ? "bg-accent" : "bg-white/10"
                    )}
                  >
                    <div className={cn(
                      "absolute top-1 w-4 h-4 bg-white rounded-full transition-all",
                      showSubtitles ? "left-7" : "left-1"
                    )} />
                  </button>
                </div>

                <button 
                  onClick={addSubtitle}
                  className="w-full py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl font-bold flex items-center justify-center gap-2 transition-all"
                >
                  <Plus className="w-5 h-5" />
                  Add Subtitle
                </button>

                <div className="space-y-4">
                  {videoState.subtitles.map(sub => (
                    <div key={sub.id} className="p-4 bg-white/5 rounded-2xl border border-border space-y-3 group">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-[10px] font-mono text-slate-500">
                          <input 
                            type="number" 
                            value={sub.start.toFixed(1)}
                            onChange={(e) => updateSubtitle(sub.id, { start: parseFloat(e.target.value) })}
                            className="w-12 bg-transparent border-b border-white/10 outline-none"
                          />
                          <span>→</span>
                          <input 
                            type="number" 
                            value={sub.end.toFixed(1)}
                            onChange={(e) => updateSubtitle(sub.id, { end: parseFloat(e.target.value) })}
                            className="w-12 bg-transparent border-b border-white/10 outline-none"
                          />
                        </div>
                        <button 
                          onClick={() => removeSubtitle(sub.id)}
                          className="p-1 text-slate-500 hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <textarea 
                        value={sub.text}
                        onChange={(e) => updateSubtitle(sub.id, { text: e.target.value })}
                        className="w-full bg-transparent text-sm font-medium outline-none resize-none h-12"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'watermark' && (
              <div className="space-y-8">
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Watermark Logo</h3>
                  <p className="text-xs text-slate-400">Add a logo to the top right corner of your video.</p>
                  
                  <div className="flex flex-col gap-4">
                    {!videoState.watermarkUrl ? (
                      <label className="w-full py-8 bg-white/5 hover:bg-white/10 border border-dashed border-white/20 rounded-2xl font-bold flex flex-col items-center justify-center gap-3 cursor-pointer transition-all group">
                        <div className="w-12 h-12 bg-accent/10 rounded-full flex items-center justify-center group-hover:scale-110 transition-transform">
                          <Upload className="w-6 h-6 text-accent" />
                        </div>
                        <span className="text-sm">Upload Logo</span>
                        <input 
                          type="file" 
                          accept="image/*" 
                          onChange={handleWatermarkUpload}
                          className="hidden"
                        />
                      </label>
                    ) : (
                      <div className="space-y-4">
                        <div className="relative aspect-square bg-white/5 rounded-2xl border border-white/10 overflow-hidden group">
                          <img 
                            src={videoState.watermarkUrl} 
                            alt="Watermark Preview" 
                            className="w-full h-full object-contain p-4"
                            referrerPolicy="no-referrer"
                          />
                          <button 
                            onClick={() => setVideoState(prev => ({ ...prev, watermarkUrl: undefined }))}
                            className="absolute top-2 right-2 p-2 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-all hover:bg-red-600"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                        <label className="w-full py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl font-bold flex items-center justify-center gap-2 cursor-pointer transition-all">
                          <Upload className="w-4 h-4" />
                          <span className="text-sm">Change Logo</span>
                          <input 
                            type="file" 
                            accept="image/*" 
                            onChange={handleWatermarkUpload}
                            className="hidden"
                          />
                        </label>

                        <div className="space-y-3 pt-4 border-t border-white/5">
                          <div className="flex justify-between items-center">
                            <span className="text-xs font-bold text-slate-400">Logo Size</span>
                            <span className="text-xs font-mono text-accent">{videoState.watermarkSize}%</span>
                          </div>
                          <input 
                            type="range"
                            min="5"
                            max="30"
                            step="1"
                            value={videoState.watermarkSize || 15}
                            onChange={(e) => setVideoState(prev => ({ ...prev, watermarkSize: parseInt(e.target.value) }))}
                            className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer accent-accent"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="p-4 bg-accent/10 rounded-2xl border border-accent/20">
                  <div className="flex gap-3">
                    <div className="w-8 h-8 bg-accent/20 rounded-lg flex items-center justify-center shrink-0">
                      <Save className="w-4 h-4 text-accent" />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-bold text-accent">Pro Tip</div>
                      <div className="text-[10px] text-slate-400 leading-relaxed">
                        Use a PNG with a transparent background for the best look. The logo will be placed in the top right corner with 80% opacity.
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

function ToolButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1 transition-all group",
        active ? "text-accent" : "text-slate-500 hover:text-slate-300"
      )}
    >
      <div className={cn(
        "w-10 h-10 rounded-xl flex items-center justify-center transition-all",
        active ? "bg-accent/10 shadow-[0_0_20px_rgba(59,130,246,0.2)]" : "group-hover:bg-white/5"
      )}>
        {icon}
      </div>
      <span className="text-[10px] font-bold uppercase tracking-tighter">{label}</span>
    </button>
  );
}

function formatTime(seconds: number) {
  if (!isFinite(seconds)) return "00:00.00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}
