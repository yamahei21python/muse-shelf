/**
 * Validation and sanitization helpers for muse-shelf.
 */

export const REPO_REGEX = /^[a-z0-9][a-z0-9._-]*$/;

export const MAX_BODY_SIZE = Math.floor(4.5 * 1024 * 1024); // 4,718,592 bytes (4.5 MB)

/**
 * Validates a repository name.
 * Must match ^[a-z0-9][a-z0-9._-]*$ (lowercase).
 * @param {any} repo
 * @returns {boolean}
 */
export function isValidRepo(repo) {
  if (typeof repo !== 'string') return false;
  return REPO_REGEX.test(repo);
}

/**
 * Sanitises a `<from>` identifier.
 * Lowercases, replaces non-alphanumeric chars with '-', strips leading non-alphanumerics,
 * and ensures the result matches ^[a-z0-9][a-z0-9._-]*$.
 * Returns null if the result is invalid or empty.
 * @param {any} raw
 * @returns {string | null}
 */
export function sanitizeFrom(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Convert to lowercase, replace non-allowed characters with hyphens, strip leading non-alphanumerics
  const sanitized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[^a-z0-9]+/, '');

  if (!sanitized || !REPO_REGEX.test(sanitized)) {
    return null;
  }
  return sanitized;
}

/**
 * Formats a Date object as UTC `YYYYMMDD-HHMMSS`.
 * @param {Date} [date]
 * @returns {string}
 */
export function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}
