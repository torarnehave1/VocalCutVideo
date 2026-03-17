import { GoogleGenAI, Modality } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export async function generateAIVoice(text: string, voiceName: 'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr' = 'Kore') {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: `Say clearly: ${text}` }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (base64Audio) {
      return `data:audio/mpeg;base64,${base64Audio}`;
    }
    throw new Error("No audio data received from Gemini");
  } catch (error) {
    console.error("Error generating AI voice:", error);
    throw error;
  }
}

export async function transcribeAudio(audioBase64: string) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          inlineData: {
            mimeType: "audio/mpeg",
            data: audioBase64,
          },
        },
        { text: "Transcribe this audio into subtitles with timestamps in JSON format: [{text: string, start: number, end: number}]. Return ONLY the JSON array." },
      ],
    });

    const text = response.text;
    if (text) {
      const jsonMatch = text.match(/\[.*\]/s);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    }
    return [];
  } catch (error) {
    console.error("Error transcribing audio:", error);
    return [];
  }
}
