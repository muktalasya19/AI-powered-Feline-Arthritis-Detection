import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { doc } from "firebase/firestore";
import { ref, uploadBytesResumable } from "firebase/storage";
import { db, storage } from "../lib/firebase";
import { api } from "../lib/api";
import { useDoc } from "../hooks/useFirestore";
import RiskBadge from "../components/RiskBadge";
import { STATUS_LABEL, type Session } from "../lib/types";

type Phase = "idle" | "recording" | "review" | "uploading" | "tracking";

const MAX_SECONDS = 30;

export default function NewTest() {
  const { catId = "" } = useParams();
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [clip, setClip] = useState<Blob | null>(null);
  const [progress, setProgress] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: session } = useDoc<Session>(sessionId ? doc(db, "cats", catId, "sessions", sessionId) : null);

  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (phase === "recording" && seconds >= MAX_SECONDS) stopRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, phase]);

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      chunks.current = [];
      const recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
      recorder.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: recorder.mimeType });
        setClip(blob);
        if (videoRef.current) {
          videoRef.current.srcObject = null;
          videoRef.current.src = URL.createObjectURL(blob);
        }
        setPhase("review");
      };
      recorderRef.current = recorder;
      recorder.start(1000);
      setSeconds(0);
      setPhase("recording");
    } catch (e) {
      setError("Camera access is needed to record. You can also upload a video file instead.");
    }
  }

  function stopRecording() {
    recorderRef.current?.state === "recording" && recorderRef.current.stop();
  }

  function onFilePicked(file: File | undefined) {
    if (!file) return;
    setClip(file);
    if (videoRef.current) videoRef.current.src = URL.createObjectURL(file);
    setPhase("review");
  }

  async function upload() {
    if (!clip) return;
    setError(null);
    setPhase("uploading");
    try {
      const slot = await api<{ sessionId: string; uploadPath: string }>("/upload-slot", { catId });
      const task = uploadBytesResumable(ref(storage, slot.uploadPath), clip, {
        contentType: clip.type || "video/mp4",
      });
      task.on("state_changed", (s) => setProgress(Math.round((s.bytesTransferred / s.totalBytes) * 100)));
      await task;
      setSessionId(slot.sessionId);
      setPhase("tracking");
    } catch (e) {
      setError((e as Error).message);
      setPhase("review");
    }
  }

  return (
    <section className="space-y-5">
      <Link to={`/cats/${catId}`} className="text-sm text-stone-500">
        ← Back
      </Link>
      <h1 className="text-2xl font-semibold">New mobility test</h1>

      {phase === "idle" && (
        <ul className="card list-disc space-y-1 pl-9 text-sm text-stone-600">
          <li>Hold the phone sideways at floor level, 2–3 metres from your cat.</li>
          <li>Film from the side while your cat walks across the frame — a hallway works well.</li>
          <li>Aim for at least three full strides; a treat at the far end helps.</li>
          <li>Good, even light. Keep the phone still.</li>
        </ul>
      )}

      <div className="relative overflow-hidden rounded-xl bg-stone-900">
        <video ref={videoRef} className="aspect-video w-full object-contain" playsInline muted controls={phase === "review"} />
        {phase === "recording" && (
          <>
            {/* Framing guide: keep the cat inside the band, walking left↔right */}
            <div className="pointer-events-none absolute inset-x-[6%] bottom-[12%] top-[30%] rounded-lg border-2 border-dashed border-white/60" />
            <div className="absolute left-3 top-3 rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white">
              ● REC {seconds}s / {MAX_SECONDS}s
            </div>
          </>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {phase === "idle" && (
          <>
            <button className="btn-primary" onClick={startRecording}>
              Start recording
            </button>
            <label className="btn-ghost cursor-pointer">
              Upload a video
              <input type="file" accept="video/*" className="hidden" onChange={(e) => onFilePicked(e.target.files?.[0])} />
            </label>
          </>
        )}
        {phase === "recording" && (
          <button className="btn-primary" onClick={stopRecording}>
            Stop
          </button>
        )}
        {phase === "review" && (
          <>
            <button className="btn-primary" onClick={upload}>
              Analyse this video
            </button>
            <button className="btn-ghost" onClick={() => setPhase("idle")}>
              Retake
            </button>
          </>
        )}
      </div>

      {phase === "uploading" && <ProgressBar label="Uploading" value={progress} />}

      {phase === "tracking" && session && (
        <div className="card space-y-3">
          <p className="text-sm text-stone-500">{STATUS_LABEL[session.status]}</p>
          {session.status !== "done" && session.status !== "rejected" && (
            <ProgressBar label="" value={STAGE_PROGRESS[session.status]} />
          )}
          {session.status === "rejected" && (
            <p className="text-sm">
              {session.rejectReason ?? "We couldn't see enough strides."} Try again with the tips above.
            </p>
          )}
          {session.status === "done" && (
            <div className="flex items-center gap-4">
              <p className="text-5xl font-semibold tabular-nums">{session.score}</p>
              <div className="space-y-1">
                <RiskBadge level={session.riskLevel} />
                <p className="text-xs text-stone-500">
                  Confidence {Math.round((session.confidence ?? 0) * 100)}% · model {session.modelVersion}
                </p>
              </div>
              <Link to={`/cats/${catId}`} className="btn-ghost ml-auto">
                See details
              </Link>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const STAGE_PROGRESS: Record<string, number> = { uploaded: 10, checking: 30, processing: 65 };

function ProgressBar({ label, value }: { label: string; value: number }) {
  return (
    <div>
      {label && <p className="mb-1 text-sm text-stone-500">{label} {value}%</p>}
      <div className="h-2 overflow-hidden rounded-full bg-stone-200">
        <div className="h-full bg-stone-900 transition-all" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function pickMimeType() {
  const options = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"];
  return options.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}
