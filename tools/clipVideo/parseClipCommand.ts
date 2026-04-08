/**
 * parseClipCommand
 * ----------------
 * Rule-based parser that extracts start/end times (in seconds)
 * from natural-language clip commands.
 *
 * Supported formats (case-insensitive):
 *   "cut 0:30 to 1:20"
 *   "clip from 30s to 90s"
 *   "trim from 1:00 to 2:30"
 *   "extract 30 to 90"
 *   "cut from 00:01:00 to 00:02:30"   ← h:mm:ss supported too
 */

export interface ParseResult {
  ok: true;
  startSeconds: number;
  endSeconds: number;
}

export interface ParseError {
  ok: false;
  error: string;
}

export type ClipCommand = ParseResult | ParseError;

/** Convert a time string like "1:30", "90", "1:30:45", "90s" → seconds */
function toSeconds(raw: string): number | null {
  const s = raw.trim().replace(/s$/i, ""); // strip trailing 's'
  const parts = s.split(":").map(Number);

  if (parts.some(isNaN)) return null;

  if (parts.length === 1) return parts[0];                             // "90"
  if (parts.length === 2) return parts[0] * 60 + parts[1];            // "1:30"
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]; // "1:30:45"
  return null;
}

/** Time token regex: matches  90  |  1:30  |  90s  |  00:01:30 */
const TIME_TOKEN = /\d+(?::\d{1,2}(?::\d{1,2})?)?s?/g;

export function parseClipCommand(input: string): ClipCommand {
  const lower = input.toLowerCase().trim();

  // Must contain a clip-intent keyword
  const hasKeyword = /\b(cut|clip|trim|extract|export|save)\b/.test(lower);
  if (!hasKeyword) {
    return {
      ok: false,
      error: 'Command must include a keyword like "cut", "clip", "trim", or "extract".',
    };
  }

  // Extract all time tokens
  const tokens = [...lower.matchAll(TIME_TOKEN)].map((m) => m[0]);

  if (tokens.length < 2) {
    return {
      ok: false,
      error:
        'Could not find two time values. Try: "cut from 0:30 to 1:20" or "clip 30s to 90s".',
    };
  }

  const startSeconds = toSeconds(tokens[0]);
  const endSeconds   = toSeconds(tokens[1]);

  if (startSeconds === null || endSeconds === null) {
    return { ok: false, error: "Could not parse the time values." };
  }

  if (startSeconds >= endSeconds) {
    return {
      ok: false,
      error: `Start time (${tokens[0]}) must be before end time (${tokens[1]}).`,
    };
  }

  return { ok: true, startSeconds, endSeconds };
}
