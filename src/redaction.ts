export const REDACTED = "[REDACTED]";

const sensitiveKey = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|secret|private[_-]?key|client[_-]?secret|credential)/i;

export function redactText(value: string): string {
  return value
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
      REDACTED,
    )
    .replace(/(\bBearer\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/(https?:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${REDACTED}@`)
    .replace(
      /(\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|OPENROUTER_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_OPENAI_API_KEY)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|private[_-]?key|client[_-]?secret|credential)["']?)\s*[:=]\s*)(["'])(.*?)\2/gi,
      `$1"${REDACTED}"`,
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|private[_-]?key|client[_-]?secret|credential)\s*[:=]\s*)(?!["'])[^\s,;]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, REDACTED)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED)
    .replace(/\b4\/[A-Za-z0-9_-]{20,}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED);
}

export function redactValue(value: unknown, key?: string): unknown {
  if (key && sensitiveKey.test(key)) return REDACTED;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}
