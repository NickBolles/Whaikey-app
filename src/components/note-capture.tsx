"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Mic, MicOff, Sparkles } from "lucide-react";
import { FLAVOR_WHEEL, leafLabel, wedgeForLeaf } from "@/lib/flavor-wheel";

/**
 * Mirror of the server-side ExtractedTastingNote shape (src/lib/ai/extract.ts).
 * Re-declared here so this client component never pulls in server-only AI code.
 */
export interface ExtractedTastingNote {
  nose: string | null;
  palate: string | null;
  finish: string | null;
  /** leaf id -> intensity 1-3 */
  flavorTags: Record<string, number>;
  /** 0.5-5.0 in half-star steps, or null */
  suggestedRating: number | null;
  servingStyle: string | null;
}

export interface NoteCaptureProps {
  /** Controlled freeform text (the pour flow's "Anything else" field). */
  freeform: string;
  onFreeformChange: (value: string) => void;
  /** Called when the user accepts an extraction — parent merges it into its state. */
  onApplyExtraction: (result: ExtractedTastingNote) => void;
  /**
   * Whether AI is configured. When explicitly false the auto-fill button is
   * hidden and a friendly note shown. When omitted/true the button is shown and
   * a runtime 503 degrades gracefully to the same note.
   */
  aiConfigured?: boolean;
}

// --- Minimal Web Speech API typings (not in lib.dom for all targets) ---------

interface SpeechResultAlternative {
  transcript: string;
}
interface SpeechRecognitionResultLike extends ArrayLike<SpeechResultAlternative> {
  isFinal: boolean;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function hasMediaRecorder(): boolean {
  return typeof window !== "undefined" && "MediaRecorder" in window;
}

/** Append dictated text with a sensible separator. */
function appendDictation(base: string, chunk: string): string {
  const trimmedChunk = chunk.trim();
  if (!trimmedChunk) return base;
  if (!base.trim()) return trimmedChunk;
  return `${base.replace(/\s+$/, "")} ${trimmedChunk}`;
}

/** Wedge color for a leaf, for the little chip dot. */
function leafColor(leafId: string): string {
  const wedgeId = wedgeForLeaf(leafId);
  return FLAVOR_WHEEL.find((w) => w.id === wedgeId)?.color ?? "var(--muted)";
}

/**
 * Freeform + voice tasting-note capture. Enriches the pour flow's free-form
 * field: type or dictate a note, then "Auto-fill from notes" runs AI extraction
 * (POST /api/extract-note). Extraction is shown for CONFIRMATION — the user
 * accepts or discards; nothing is auto-applied. Degrades gracefully when neither
 * voice APIs nor AI are available: the textarea always works.
 */
export function NoteCapture({
  freeform,
  onFreeformChange,
  onApplyExtraction,
  aiConfigured,
}: NoteCaptureProps) {
  // Capability gate. useSyncExternalStore keeps SSR (false) and client renders
  // consistent without a hydration mismatch. Capabilities don't change, so the
  // subscribe callback is a no-op.
  const micSupported = useSyncExternalStore(
    () => () => {},
    () => hasMediaRecorder() || getSpeechRecognitionCtor() !== null,
    () => false,
  );
  const [recording, setRecording] = useState(false);
  const [micHint, setMicHint] = useState<string | null>(null);

  const [extracting, setExtracting] = useState(false);
  const [result, setResult] = useState<ExtractedTastingNote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiOff, setAiOff] = useState(aiConfigured === false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Live copy of the freeform text so dictation callbacks never read a stale value.
  const freeformRef = useRef(freeform);
  useEffect(() => {
    freeformRef.current = freeform;
  }, [freeform]);

  // Stop any in-flight recognition on unmount.
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  const stopRecording = () => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setRecording(false);
  };

  const startRecording = () => {
    setMicHint(null);
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      // MediaRecorder exists but no live transcription in this browser.
      setMicHint("Voice dictation isn't supported in this browser — type your notes below.");
      return;
    }
    try {
      const recognition = new Ctor();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang =
        (typeof navigator !== "undefined" && navigator.language) || "en-US";
      recognition.onresult = (event) => {
        let finalText = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const res = event.results[i];
          if (res.isFinal && res[0]) finalText += `${res[0].transcript} `;
        }
        if (finalText.trim()) {
          const next = appendDictation(freeformRef.current, finalText);
          freeformRef.current = next;
          onFreeformChange(next);
        }
      };
      recognition.onerror = () => {
        setMicHint("Couldn't hear that — try again or type your notes.");
        stopRecording();
      };
      recognition.onend = () => {
        recognitionRef.current = null;
        setRecording(false);
      };
      recognitionRef.current = recognition;
      recognition.start();
      setRecording(true);
    } catch {
      setMicHint("Couldn't start the microphone — type your notes below.");
      setRecording(false);
    }
  };

  const toggleRecording = () => {
    if (recording) stopRecording();
    else startRecording();
  };

  const handleExtract = async () => {
    const text = freeform.trim();
    if (!text || extracting) return;
    setExtracting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/extract-note", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.status === 503) {
        setAiOff(true);
        return;
      }
      if (!res.ok) {
        setError("Couldn't read your notes just now — try again, or fill the fields in yourself.");
        return;
      }
      const data = (await res.json()) as ExtractedTastingNote;
      setResult(data);
    } catch {
      setError("Couldn't reach the note reader — check your connection, or fill the fields in yourself.");
    } finally {
      setExtracting(false);
    }
  };

  const applyResult = () => {
    if (!result) return;
    onApplyExtraction(result);
    setResult(null);
  };

  const flavorEntries = result
    ? Object.entries(result.flavorTags).filter(([leafId]) => leafLabel(leafId))
    : [];

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="section-label">Anything else</span>
        <textarea
          value={freeform}
          onChange={(e) => onFreeformChange(e.target.value)}
          rows={3}
          placeholder="Free-form thoughts — type or use the mic…"
          className="rounded-xl bg-surface border border-border-subtle p-3 text-sm placeholder:text-muted focus:outline-none focus:border-accent resize-y"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        {micSupported && (
          <button
            type="button"
            onClick={toggleRecording}
            aria-pressed={recording}
            aria-label={recording ? "Stop dictation" : "Dictate notes"}
            className={`chip min-h-11 inline-flex items-center gap-2 px-4 text-sm ${
              recording ? "chip-active font-medium" : "hover:bg-surface-raised"
            }`}
          >
            {recording ? (
              <MicOff size={18} strokeWidth={1.8} aria-hidden />
            ) : (
              <Mic size={18} strokeWidth={1.8} aria-hidden />
            )}
            {recording ? "Stop" : "Dictate"}
            {recording && (
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full bg-accent animate-pulse motion-reduce:animate-none"
              />
            )}
          </button>
        )}

        {!aiOff && (
          <button
            type="button"
            onClick={handleExtract}
            disabled={extracting || !freeform.trim()}
            aria-label="Auto-fill tasting fields from your notes"
            className="chip min-h-11 inline-flex items-center gap-2 px-4 text-sm hover:bg-surface-raised disabled:opacity-50"
          >
            <Sparkles size={18} strokeWidth={1.8} className="text-accent" aria-hidden />
            {extracting ? "Reading your notes…" : "Auto-fill from notes"}
          </button>
        )}
      </div>

      {/* Screen-reader announcement of recording state. */}
      <span className="sr-only" aria-live="polite">
        {recording ? "Recording. Speak your tasting note." : ""}
      </span>

      {micHint && <p className="text-xs text-muted px-1">{micHint}</p>}

      {aiOff && (
        <p className="card-flat text-sm text-muted p-3">
          Auto-fill is off right now — jot your thoughts here and use the flavor wheel and
          nose/palate/finish fields above. Your note saves either way.
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-muted rounded-xl border border-border-subtle bg-surface p-3">
          {error}
        </p>
      )}

      {result && (
        <div className="card flex flex-col gap-3 p-4" role="group" aria-label="Suggested tasting note">
          <div className="flex items-center gap-2">
            <Sparkles size={18} strokeWidth={1.8} className="text-accent" aria-hidden />
            <span className="section-label">Suggested from your notes</span>
          </div>

          {result.suggestedRating != null && (
            <p className="text-sm">
              Suggested rating:{" "}
              <span className="text-accent font-medium">
                {result.suggestedRating.toFixed(1)}★
              </span>
            </p>
          )}

          {flavorEntries.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label="Suggested flavors">
              {flavorEntries.map(([leafId, intensity]) => (
                <li key={leafId}>
                  <span className="chip inline-flex items-center gap-1.5 px-3 py-1.5 text-xs">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: leafColor(leafId) }}
                      aria-hidden
                    />
                    <span className="text-foreground/90">
                      {leafLabel(leafId)}{" "}
                      <span className="text-accent">{"×".repeat(Math.max(1, Math.min(3, intensity)))}</span>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {(result.nose || result.palate || result.finish) && (
            <dl className="flex flex-col gap-1.5 text-sm">
              {(
                [
                  ["Nose", result.nose],
                  ["Palate", result.palate],
                  ["Finish", result.finish],
                ] as const
              )
                .filter(([, v]) => v)
                .map(([label, v]) => (
                  <div key={label} className="flex gap-2">
                    <dt className="text-muted shrink-0 w-14">{label}</dt>
                    <dd className="text-foreground/90">{v}</dd>
                  </div>
                ))}
            </dl>
          )}

          {result.suggestedRating == null &&
            flavorEntries.length === 0 &&
            !result.nose &&
            !result.palate &&
            !result.finish && (
              <p className="text-sm text-muted">
                Nothing clear to pull from that note — add a little more detail, or fill the fields in
                yourself.
              </p>
            )}

          <p className="text-xs text-muted">
            You stay the author — apply fills empty fields, and you can edit everything after.
          </p>

          <div className="flex gap-2">
            <button type="button" onClick={applyResult} className="btn-primary px-5 py-2.5 text-sm">
              Apply
            </button>
            <button
              type="button"
              onClick={() => setResult(null)}
              className="btn-secondary px-5 py-2.5 text-sm font-medium"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
