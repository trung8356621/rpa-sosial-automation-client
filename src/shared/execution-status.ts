import type { ExecutionStatus } from "./contracts.js";

export function formatStepPhaseStatus(params: {
  stepNumber: number;
  totalSteps: number;
  phase: string;
  activeLanguage?: string | null;
  isFallback?: boolean;
}): ExecutionStatus {
  const prefix = params.isFallback && params.activeLanguage ? `${params.activeLanguage} · ` : "";
  return {
    text: `${prefix}Step ${params.stepNumber}/${params.totalSteps} — ${params.phase}`,
    tone: params.isFallback ? "fallback" : "running",
  };
}

export function formatFallbackTransitionStatus(params: {
  fromLanguage: string;
  toLanguage: string;
  stepNumber: number;
  totalSteps: number;
}): ExecutionStatus {
  return {
    text: `Fallback ${params.fromLanguage} → ${params.toLanguage} — Step ${params.stepNumber}/${params.totalSteps}`,
    tone: "fallback",
  };
}

export function formatStepFailedStatus(params: {
  stepNumber: number;
  totalSteps: number;
  code: string;
  activeLanguage?: string | null;
  isFallback?: boolean;
}): ExecutionStatus {
  const prefix = params.isFallback && params.activeLanguage ? `${params.activeLanguage} · ` : "";
  return {
    text: `${prefix}Step ${params.stepNumber}/${params.totalSteps} — Failed: ${params.code}`,
    tone: "failed",
  };
}
