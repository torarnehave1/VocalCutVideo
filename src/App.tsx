import React, { useState, useRef, useEffect } from 'react';
import { 
  Play, Pause, Scissors, Mic, Type, Download, 
  Trash2, Plus, Volume2, Wand2, Upload, ChevronRight, 
  ChevronLeft, X, Save
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { generateAIVoice } from './services/gemini';
import { Subtitle, Voiceover, VideoState } from './types';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function App() {
  const [videoState, setVideoState] = useState<VideoState>({
    url: null,
    duration: 0,
    trimStart: 0,
    trimEnd: 0,
    subtitles: [],
    voiceovers: [],
  });

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeTab, setActiveTab] = useState<'trim' | 'voice' | 'subtitles'>('trim');
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [aiText, setAiText] = useState('');
  const [aiVoice, setAiVoice] = useState<'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr'>('Kore');
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Handle Video Upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setVideoState(prev => ({
        ...prev,
        url,
        trimStart: 0,
        trimEnd: 0, // Will be set once metadata loaded
        subtitles: [],
        voiceovers: [],
      }));
    }
  };

  const onLoadedMetadata = () => {
    if (videoRef.current) {
      const duration = videoRef.current.duration;
      setVideoState(prev => ({
        ...prev,
        duration,
        trimEnd: duration,
      }));
    }
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const time = videoRef.current.currentTime;
      setCurrentTime(time);
      
      // Handle trim loop/stop
      if (time >= videoState.trimEnd) {
        videoRef.current.currentTime = videoState.trimStart;
        if (!isPlaying) videoRef.current.pause();
      }
    }
  };

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

  // Voiceover: Upload
  const handleAudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      addVoiceover(url, 'recorded', file.name);
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

  const handleExport = async () => {
    if (!videoRef.current || !videoState.url) return;

    setIsExporting(true);
    setExportProgress(0);
    setIsPlaying(false);
    videoRef.current.pause();

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const video = videoRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const stream = canvas.captureStream(30);
    const audioCtx = new AudioContext({ sampleRate: 48000 });
    const dest = audioCtx.createMediaStreamDestination();
    
    // Master Gain to prevent clipping
    const masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.9; // Slightly lower than 1 to provide headroom
    masterGain.connect(dest);
    masterGain.connect(audioCtx.destination);

    // Video Audio
    const videoSource = audioCtx.createMediaElementSource(video);
    videoSource.connect(masterGain);

    // Voiceovers
    const voiceoverAudios: HTMLAudioElement[] = [];
    
    const recorder = new MediaRecorder(new MediaStream([
      ...stream.getVideoTracks(),
      ...dest.stream.getAudioTracks()
    ]), { 
      mimeType: 'video/webm;codecs=vp9,opus',
      videoBitsPerSecond: 5000000,
      audioBitsPerSecond: 128000
    });

    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'vocalcut-export.webm';
      a.click();
      setIsExporting(false);
      
      // Cleanup
      audioCtx.close();
      voiceoverAudios.forEach(a => a.pause());
    };

    video.currentTime = videoState.trimStart;
    recorder.start();

    const renderFrame = () => {
      // Draw Video
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Draw Subtitles
      const time = video.currentTime;
      const activeSubs = showSubtitles ? videoState.subtitles.filter(s => time >= s.start && time <= s.end) : [];
      
      if (activeSubs.length > 0) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.font = `${canvas.height * 0.05}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        
        activeSubs.forEach((sub, i) => {
          const text = sub.text;
          const metrics = ctx.measureText(text);
          const padding = 20;
          const rectWidth = metrics.width + padding * 2;
          const rectHeight = canvas.height * 0.07;
          
          ctx.fillRect(
            canvas.width / 2 - rectWidth / 2,
            canvas.height * 0.85 - rectHeight / 2 + (i * rectHeight * 1.2),
            rectWidth,
            rectHeight
          );
          
          ctx.fillStyle = 'white';
          ctx.fillText(text, canvas.width / 2, canvas.height * 0.85 + (i * rectHeight * 1.2) + 10);
        });
      }

      // Trigger Voiceovers
      videoState.voiceovers.forEach(v => {
        if (Math.abs(time - v.startTime) < 0.05) {
          const audio = new Audio(v.url);
          const source = audioCtx.createMediaElementSource(audio);
          source.connect(masterGain);
          audio.play();
          voiceoverAudios.push(audio);
        }
      });

      const progress = ((time - videoState.trimStart) / (videoState.trimEnd - videoState.trimStart)) * 100;
      setExportProgress(Math.min(100, progress));

      if (time >= videoState.trimEnd) {
        recorder.stop();
        video.pause();
      } else {
        requestAnimationFrame(renderFrame);
      }
    };

    video.play().then(() => {
      renderFrame();
    });
  };

  const addVoiceover = (url: string, type: 'recorded' | 'ai', text?: string) => {
    const newVoiceover: Voiceover = {
      id: Math.random().toString(36).substr(2, 9),
      url,
      startTime: currentTime,
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
      end: Math.min(currentTime + 3, videoState.trimEnd)
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
      // Simple threshold check
      if (Math.abs(currentTime - v.startTime) < 0.1 && isPlaying) {
        const audio = new Audio(v.url);
        audio.play();
      }
    });
  }, [currentTime, isPlaying, videoState.voiceovers]);

  if (!videoState.url) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-bg">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full glass p-12 rounded-3xl text-center space-y-8"
        >
          <div className="w-20 h-20 bg-accent/20 rounded-full flex items-center justify-center mx-auto">
            <Upload className="w-10 h-10 text-accent" />
          </div>
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight">VocalCut</h1>
            <p className="text-slate-400">Upload a video to start editing with AI voices and subtitles.</p>
          </div>
          <label className="block">
            <span className="sr-only">Choose video file</span>
            <input 
              type="file" 
              accept="video/*" 
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
            <div className="flex items-center gap-3 px-4 py-1.5 bg-white/5 rounded-full border border-white/10">
              <div className="w-20 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-accent transition-all duration-300"
                  style={{ width: `${exportProgress}%` }}
                />
              </div>
              <span className="text-[10px] font-mono text-accent font-bold">{Math.round(exportProgress)}%</span>
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
        </aside>

        {/* Center: Preview & Timeline */}
        <section className="flex-1 flex flex-col relative bg-black/40">
          <div className="flex-1 flex items-center justify-center p-8 relative">
            <div className="relative max-w-4xl w-full aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl border border-white/5">
              <video 
                ref={videoRef}
                src={videoState.url}
                onLoadedMetadata={onLoadedMetadata}
                onTimeUpdate={handleTimeUpdate}
                className="w-full h-full object-contain"
                onClick={togglePlay}
              />
              
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
          </div>

          {/* Timeline Controls */}
          <div className="h-48 glass border-t border-border p-6 space-y-6">
            <div className="flex items-center gap-6">
              <button 
                onClick={togglePlay}
                className="w-12 h-12 bg-white text-black rounded-full flex items-center justify-center hover:scale-105 transition-transform"
              >
                {isPlaying ? <Pause className="w-6 h-6 fill-black" /> : <Play className="w-6 h-6 fill-black ml-1" />}
              </button>
              
              <div className="flex-1 space-y-2">
                <div className="flex justify-between text-xs font-mono text-slate-500">
                  <span>{formatTime(currentTime)}</span>
                  <span>{formatTime(videoState.duration)}</span>
                </div>
                <div className="relative h-2 bg-white/10 rounded-full overflow-hidden group cursor-pointer">
                  <div 
                    className="absolute inset-y-0 left-0 bg-accent transition-all duration-100"
                    style={{ width: `${(currentTime / videoState.duration) * 100}%` }}
                  />
                  <input 
                    type="range"
                    min="0"
                    max={videoState.duration}
                    step="0.1"
                    value={currentTime}
                    onChange={(e) => {
                      const time = parseFloat(e.target.value);
                      if (videoRef.current) videoRef.current.currentTime = time;
                      setCurrentTime(time);
                    }}
                    className="absolute inset-0 w-full opacity-0 cursor-pointer"
                  />
                </div>
              </div>
            </div>

            {/* Trim Visualizer */}
            <div className="relative h-12 bg-white/5 rounded-xl border border-white/10 overflow-hidden">
               <div 
                className="absolute inset-y-0 bg-accent/20 border-x border-accent"
                style={{ 
                  left: `${(videoState.trimStart / videoState.duration) * 100}%`,
                  right: `${100 - (videoState.trimEnd / videoState.duration) * 100}%`
                }}
               />
               {/* Markers for voiceovers and subs */}
               {videoState.voiceovers.map(v => (
                 <div 
                  key={v.id}
                  className="absolute top-0 bottom-0 w-1 bg-yellow-500/50"
                  style={{ left: `${(v.startTime / videoState.duration) * 100}%` }}
                 />
               ))}
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
                  <label className="text-sm font-medium text-slate-400">Start Time</label>
                  <div className="flex items-center gap-4">
                    <input 
                      type="number" 
                      value={videoState.trimStart.toFixed(2)}
                      onChange={(e) => setVideoState(prev => ({ ...prev, trimStart: Math.max(0, parseFloat(e.target.value)) }))}
                      className="flex-1 bg-white/5 border border-border rounded-lg px-3 py-2 text-sm font-mono"
                    />
                    <button 
                      onClick={() => setVideoState(prev => ({ ...prev, trimStart: currentTime }))}
                      className="p-2 bg-accent/10 text-accent rounded-lg hover:bg-accent/20"
                    >
                      <Save className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div className="space-y-4">
                  <label className="text-sm font-medium text-slate-400">End Time</label>
                  <div className="flex items-center gap-4">
                    <input 
                      type="number" 
                      value={videoState.trimEnd.toFixed(2)}
                      onChange={(e) => setVideoState(prev => ({ ...prev, trimEnd: Math.min(videoState.duration, parseFloat(e.target.value)) }))}
                      className="flex-1 bg-white/5 border border-border rounded-lg px-3 py-2 text-sm font-mono"
                    />
                    <button 
                      onClick={() => setVideoState(prev => ({ ...prev, trimEnd: currentTime }))}
                      className="p-2 bg-accent/10 text-accent rounded-lg hover:bg-accent/20"
                    >
                      <Save className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-slate-500 leading-relaxed">
                  Trimming will loop the video between the selected points during preview.
                </p>
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
                            <div className="text-xs font-mono text-slate-400">{formatTime(v.startTime)}</div>
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
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}
