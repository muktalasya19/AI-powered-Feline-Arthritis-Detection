import type { Timestamp } from "firebase/firestore";

export type RiskLevel = "low" | "watch" | "see_vet";
export type SessionStatus = "pending_upload" | "queued" | "checking" | "processing" | "done" | "rejected";

export interface Cat {
  id: string;
  name: string;
  ownerUid: string;
  birthYear?: number;
  sex?: "male" | "female";
  breed?: string;
  weightKg?: number;
  latestScore?: number;
  latestRiskLevel?: RiskLevel;
  sharedWith?: Record<string, string>;
}

export interface GaitFeatures {
  strideSymmetry: number;
  cadence: number;
  smoothness: number;
  spineCurvature: number;
  jointAngles: Record<string, number>;
}

export interface Session {
  id: string;
  status: SessionStatus;
  createdAt?: Timestamp;
  score?: number;
  confidence?: number;
  riskLevel?: RiskLevel;
  modelVersion?: string;
  rejectReason?: string;
  features?: GaitFeatures;
}

export const RISK_LABEL: Record<RiskLevel, string> = {
  low: "Low concern",
  watch: "Keep an eye on it",
  see_vet: "Worth a vet check",
};

export const STATUS_LABEL: Record<SessionStatus, string> = {
  pending_upload: "Uploading",
  queued: "Waiting for the analyser",
  checking: "Checking video quality",
  processing: "Analysing gait",
  done: "Done",
  rejected: "Video couldn't be used",
};
