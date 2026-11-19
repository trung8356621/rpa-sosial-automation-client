/**
 * Minimal Script Creator execution contracts (ORC-relevant slice).
 * Baseline: rpa-social-automation-v2 @ 8c06ef86179d7f90c21bdba81bf6a768227e148e
 * Do not invent alternate target schemas.
 */

export type Rect = { x: number; y: number; width: number; height: number };

export type Action =
  | "CLICK_TARGET"
  | "CLICK_AND_TYPE"
  | "UPLOAD_FILE"
  | "QUICK_TAG"
  | "TYPE_ONLY"
  | "WAIT_VERIFY"
  | "SCROLL"
  | "SLEEP";

export type OcrSegment = {
  id: string;
  text: string;
  bbox: Rect;
  confidence: number;
  kind?: "line" | "word" | "block";
};

export type OcrResult = {
  text: string;
  confidence: number;
  segments: OcrSegment[];
  language: "vie+eng";
  cropOffset?: { x: number; y: number };
  containerCrop?: Rect;
};

export type VisualEnvironment = { width: number; height: number; zoom: number };

export type VisualTarget = {
  matchTo?: "none" | "current" | "top" | "middle" | "bottom";
  environment?: VisualEnvironment;
  asset: string;
  roi: Rect;
  ocr?: Omit<OcrSegment, "id"> & { confirmed: true; language: "vie+eng" };
  clickOffset?: { x: number; y: number };
};

export type Payload = {
  action: Action;
  variableId?: string;
  text?: string;
  inputMethod?: "keyboard" | "clipboard";
  files?: string[];
  target?: VisualTarget;
  method?: "auto" | "image" | "ocr";
  deltaY?: number;
  timeoutMs?: number;
  threshold?: number;
  sleepMs?: number;
};

export type Capture = {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
  zoom: number;
  url: string;
  timestamp: string;
  backend: "cdp-surface";
  bounds?: Rect;
};

export type ResolutionTrace = {
  ocrOutcome?: "NOT_FOUND" | "OCR_LOW_CONFIDENCE" | "CONTEXT_REJECTED";
  context?: {
    x: number;
    y: number;
    confirmed: boolean;
    reason: string;
    imageScore?: number;
    anchor?: string;
  }[];
  mode: "auto";
  legacyMethod?: "image" | "ocr";
  selectedMethod?: "image" | "ocr";
  fallbackReason?: string;
  blockedReason?: string;
  attempts: {
    method: "image" | "ocr";
    outcome: "matched" | "not_confident" | "ambiguous" | "failed" | "unavailable";
    reason?: string;
    score?: number;
    confidence?: number;
    x?: number;
    y?: number;
  }[];
};

export type Result = {
  id: string;
  ok: boolean;
  status: "ACTION_SENT" | "VERIFIED" | "BLOCKED" | "FAILED" | "REJECTED";
  action: Action;
  message: string;
  clickSent?: boolean;
  resolution?: ResolutionTrace;
  match?: {
    score: number;
    x: number;
    y: number;
    method?: "image" | "ocr";
    text?: string;
    confidence?: number;
  };
  before?: Capture;
  after?: Capture;
  source: "base" | "override";
  stepId: string;
  version: number;
};
