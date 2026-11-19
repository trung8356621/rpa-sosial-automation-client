import type { AuthScriptVariable } from "../auth/auth-script-types.js";
import {
  resolveCredentialBindings,
  type AccountCredentialSource,
} from "../auth/credential-mapper.js";

/**
 * Bind manifest variables from Job.input (e.g. title) + Account credentials.
 * Job.input wins for non-secret keys; password/username still from Account APIs.
 */
export async function resolveJobVariableBindings(params: {
  variables: AuthScriptVariable[];
  jobInput: Record<string, unknown>;
  account: AccountCredentialSource;
}): Promise<{ ok: true; values: Record<string, string> } | { ok: false; message: string }> {
  const fromInput = flattenJobInput(params.jobInput);
  const cred = await resolveCredentialBindings(params.variables, params.account);
  if (!cred.ok) return cred;

  const values: Record<string, string> = { ...cred.values };
  for (const variable of params.variables) {
    const key = (variable.key || "").trim();
    if (!key) continue;
    if (fromInput[key] !== undefined) {
      values[key] = fromInput[key];
    }
  }

  // Also expose raw job input keys even if not declared (Creator may use step.variable_key).
  for (const [key, value] of Object.entries(fromInput)) {
    if (values[key] === undefined) values[key] = value;
  }

  return { ok: true, values };
}

export function flattenJobInput(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      out[key] = value;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
      continue;
    }
  }
  return out;
}

export function requireTitleBinding(
  values: Record<string, string>,
  variables: AuthScriptVariable[]
): { ok: true; title: string } | { ok: false; message: string } {
  const wantsTitle = variables.some((v) => (v.key || "").trim().toLowerCase() === "title");
  const title = (values.title || values.Title || "").trim();
  if (wantsTitle && !title) {
    return { ok: false, message: "Job input thiếu biến title bắt buộc." };
  }
  if (!title) {
    // Script may still run if title not declared — caller decides.
    return { ok: true, title: "" };
  }
  return { ok: true, title };
}
