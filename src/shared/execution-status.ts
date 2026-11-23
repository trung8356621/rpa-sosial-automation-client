import type { ExecutionStatus } from "./contracts.js";

export function resolveExecutionLanguageLabel(languageLabel?: string | null): string {
  const trimmed = typeof languageLabel === "string" ? languageLabel.trim() : "";
  return trimmed || "Default";
}

export function formatStepPhaseStatus(params: {
  stepNumber: number;
  totalSteps: number;
  phase: string;
  activeLanguage?: string | null;
  transitionFromLanguage?: string | null;
  isFallback?: boolean;
}): ExecutionStatus {
  const active = resolveExecutionLanguageLabel(params.activeLanguage);
  const from = params.transitionFromLanguage
    ? resolveExecutionLanguageLabel(params.transitionFromLanguage)
    : null;
  const languagePrefix = from ? `${from} → ${active}` : active;
  return {
    text: `${languagePrefix} · Step ${params.stepNumber}/${params.totalSteps} — ${params.phase}`,
    tone: params.isFallback ? "fallback" : "running",
  };
}

export function formatFallbackTransitionStatus(params: {
  fromLanguage: string;
  toLanguage: string;
  stepNumber: number;
  totalSteps: number;
}): ExecutionStatus {
  const from = resolveExecutionLanguageLabel(params.fromLanguage);
  const to = resolveExecutionLanguageLabel(params.toLanguage);
  return {
    text: `${from} → ${to} · Step ${params.stepNumber}/${params.totalSteps}`,
    tone: "fallback",
  };
}

export function formatStepFailedStatus(params: {
  stepNumber: number;
  totalSteps: number;
  code: string;
  activeLanguage?: string | null;
}): ExecutionStatus {
  const active = resolveExecutionLanguageLabel(params.activeLanguage);
  return {
    text: `${active} · Step ${params.stepNumber}/${params.totalSteps} — Failed: ${params.code}`,
    tone: "failed",
  };
}
