// Gemini client singleton. One instance per process — the SDK pools its
// own HTTP connections, so creating multiple clients just wastes memory.
//
// Lazy init so importing this module doesn't blow up at boot when the
// app is being typechecked or run in a context without GEMINI_API_KEY
// (e.g. local sandbox without the player's paid key wired in).
import { GoogleGenAI } from '@google/genai';

let _client: GoogleGenAI | undefined;

export function getGemini(): GoogleGenAI {
  if (!_client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY is not set. Stage 4 (transcription) requires the player\'s Gemini API key — add it to Dokploy env for the Barkeep service.'
      );
    }
    _client = new GoogleGenAI({ apiKey });
  }
  return _client;
}
