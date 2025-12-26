#!/usr/bin/env -S -P/${HOME}/.deno/bin:/opt/homebrew/bin:/usr/local/bin deno run --allow-all
// <xbar.title>Claude Usage Meter</xbar.title>
// <xbar.desc>Shows Claude.ai usage limits and reset times with notifications</xbar.desc>
// <xbar.version>v2.0</xbar.version>
// <xbar.author>Gustavo Gomez</xbar.author>
// <xbar.dependencies>Deno</xbar.dependencies>

//  Variables
//  <xbar.var>string(SESSION_KEY=""): Claude session key from cookies (sessionKey)</xbar.var>
//  <xbar.var>string(ORG_ID=""): Claude organization ID</xbar.var>

import { xbar, separator } from "https://deno.land/x/xbar@v2.1.0/mod.ts";

// ============================================================================
// Types
// ============================================================================

interface UsageData {
  five_hour: {
    utilization: number;
    resets_at: string;
  } | null;
  seven_day: {
    utilization: number;
    resets_at: string;
  } | null;
  seven_day_sonnet: {
    utilization: number;
    resets_at: string | null;
  } | null;
  seven_day_opus: number | null;
  extra_usage: unknown | null;
}

type ErrorType =
  | "auth_expired"
  | "rate_limited"
  | "network_error"
  | "api_changed"
  | "unknown";

interface ErrorInfo {
  type: ErrorType;
  message: string;
  retryAfter?: number;
}

interface NotificationState {
  // Usage threshold tracking
  fiveHourNotifiedThreshold: number | null;
  sevenDayNotifiedThreshold: number | null;
  lastUsageNotificationAt: string | null;

  // Reset time tracking (to reset notifications on new period)
  lastFiveHourResetTime: string | null;
  lastSevenDayResetTime: string | null;

  // Auth error tracking
  lastAuthErrorAt: string | null;
  authErrorNotified: boolean;
}

// Custom error classes for better error handling
class AuthExpiredError extends Error {
  constructor(message = "Session expired") {
    super(message);
    this.name = "AuthExpiredError";
  }
}

class RateLimitedError extends Error {
  retryAfter: number;
  constructor(retryAfter: number | null) {
    super(`Rate limited${retryAfter ? ` - retry in ${retryAfter}s` : ""}`);
    this.name = "RateLimitedError";
    this.retryAfter = retryAfter ?? 60;
  }
}

class NetworkError extends Error {
  constructor(message = "Network error") {
    super(message);
    this.name = "NetworkError";
  }
}

class ApiChangedError extends Error {
  constructor(message = "API response format changed") {
    super(message);
    this.name = "ApiChangedError";
  }
}

// ============================================================================
// Constants
// ============================================================================

const HOME = Deno.env.get("HOME") || "";
const STATE_FILE = `${HOME}/.claude-xbar-state.json`;
const PLUGIN_DIR = `${HOME}/Library/Application Support/xbar/plugins`;

// ============================================================================
// xbar Variable Sanitization
// ============================================================================

/**
 * xbar adds a binary prefix to variable values that contains non-ASCII characters.
 * This function extracts the clean value by finding the actual content.
 * 
 * For SESSION_KEY: looks for "sk-ant-" prefix
 * For ORG_ID: looks for UUID pattern (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
 */
function sanitizeXbarVariable(value: string, type: "session" | "org"): string {
  if (!value) return "";
  
  // If the value is already clean (ASCII only), return as-is
  if (/^[\x20-\x7E]+$/.test(value)) {
    return value;
  }
  
  if (type === "session") {
    // Look for session key pattern: sk-ant-sid01-...
    const sessionMatch = value.match(/sk-ant-sid\d+-[A-Za-z0-9_-]+/);
    if (sessionMatch) {
      return sessionMatch[0];
    }
  }
  
  if (type === "org") {
    // Look for UUID pattern
    const uuidMatch = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch) {
      return uuidMatch[0];
    }
  }
  
  // Fallback: strip non-printable ASCII characters
  return value.replace(/[^\x20-\x7E]/g, "");
}
// Wrapper script path (no spaces)
const TOKEN_HELPER_CMD = `${HOME}/.local/bin/claude-token-helper`;

const NOTIFICATION_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between usage notifications
const FETCH_TIMEOUT_MS = 15000; // 15 second timeout

const USAGE_THRESHOLDS = [
  { level: 90, label: "Critical", sound: "Glass" },
  { level: 70, label: "Warning", sound: "Ping" },
];

// ============================================================================
// State Management
// ============================================================================

async function loadState(): Promise<NotificationState> {
  try {
    const text = await Deno.readTextFile(STATE_FILE);
    return JSON.parse(text);
  } catch {
    return {
      fiveHourNotifiedThreshold: null,
      sevenDayNotifiedThreshold: null,
      lastUsageNotificationAt: null,
      lastFiveHourResetTime: null,
      lastSevenDayResetTime: null,
      lastAuthErrorAt: null,
      authErrorNotified: false,
    };
  }
}

async function saveState(state: NotificationState): Promise<void> {
  try {
    await Deno.writeTextFile(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // Silently fail - don't break the plugin if state can't be saved
  }
}

// ============================================================================
// Notifications
// ============================================================================

function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function sendNotification(
  title: string,
  message: string,
  sound?: string
): Promise<void> {
  try {
    let script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`;
    if (sound) {
      script += ` sound name "${sound}"`;
    }
    const cmd = new Deno.Command("osascript", { args: ["-e", script] });
    await cmd.output();
  } catch {
    // Silently fail - don't break the plugin if notification fails
  }
}

async function checkAndNotifyUsage(
  usage: number,
  resetTime: string | null,
  label: string,
  state: NotificationState,
  thresholdKey: "fiveHourNotifiedThreshold" | "sevenDayNotifiedThreshold",
  resetTimeKey: "lastFiveHourResetTime" | "lastSevenDayResetTime"
): Promise<void> {
  const now = Date.now();

  // Reset notification tracking if we're in a new period
  if (resetTime && resetTime !== state[resetTimeKey]) {
    state[thresholdKey] = null;
    state[resetTimeKey] = resetTime;
  }

  // Check cooldown
  const lastNotifyTime = state.lastUsageNotificationAt
    ? new Date(state.lastUsageNotificationAt).getTime()
    : 0;
  if (now - lastNotifyTime < NOTIFICATION_COOLDOWN_MS) {
    return;
  }

  // Check thresholds (highest first)
  for (const threshold of USAGE_THRESHOLDS) {
    const alreadyNotified =
      state[thresholdKey] !== null && state[thresholdKey]! >= threshold.level;

    if (usage >= threshold.level && !alreadyNotified) {
      await sendNotification(
        `Claude ${threshold.label}`,
        `${label} usage at ${usage}%`,
        threshold.sound
      );
      state[thresholdKey] = threshold.level;
      state.lastUsageNotificationAt = new Date().toISOString();
      break; // Only send one notification per check
    }
  }
}

async function notifyAuthExpired(state: NotificationState): Promise<void> {
  if (state.authErrorNotified) {
    return;
  }

  await sendNotification(
    "Claude Session Expired",
    "Your session token has expired. Run the token helper to refresh.",
    "Basso"
  );
  state.authErrorNotified = true;
  state.lastAuthErrorAt = new Date().toISOString();
}

// ============================================================================
// API Fetching
// ============================================================================

function validateResponseFormat(data: unknown): asserts data is UsageData {
  if (typeof data !== "object" || data === null) {
    throw new ApiChangedError("Response is not an object");
  }

  // Check for expected structure - at least one of these should exist
  const d = data as Record<string, unknown>;
  const hasFiveHour = "five_hour" in d;
  const hasSevenDay = "seven_day" in d;

  if (!hasFiveHour && !hasSevenDay) {
    throw new ApiChangedError("Missing expected usage fields");
  }

  // Validate five_hour structure if present
  if (hasFiveHour && d.five_hour !== null) {
    const fiveHour = d.five_hour as Record<string, unknown>;
    if (typeof fiveHour.utilization !== "number") {
      throw new ApiChangedError("five_hour.utilization is not a number");
    }
  }

  // Validate seven_day structure if present
  if (hasSevenDay && d.seven_day !== null) {
    const sevenDay = d.seven_day as Record<string, unknown>;
    if (typeof sevenDay.utilization !== "number") {
      throw new ApiChangedError("seven_day.utilization is not a number");
    }
  }
}

async function fetchUsageData(
  sessionKey: string,
  orgId: string
): Promise<UsageData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://claude.ai/api/organizations/${orgId}/usage`,
      {
        headers: {
          "Cookie": `sessionKey=${sessionKey}`,
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://claude.ai/",
          "Origin": "https://claude.ai",
        },
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    // Handle specific HTTP status codes
    if (response.status === 401) {
      throw new AuthExpiredError();
    }

    // 403 could be Cloudflare block or auth issue - check response
    if (response.status === 403) {
      const text = await response.text();
      if (text.includes("cloudflare") || text.includes("cf-chl") || text.includes("Just a moment")) {
        throw new NetworkError("Blocked by Cloudflare - try again later");
      }
      throw new AuthExpiredError();
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      throw new RateLimitedError(retryAfter ? parseInt(retryAfter, 10) : null);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiChangedError("Invalid JSON response");
    }

    validateResponseFormat(data);
    return data;
  } catch (error) {
    clearTimeout(timeout);

    if (error instanceof AuthExpiredError) throw error;
    if (error instanceof RateLimitedError) throw error;
    if (error instanceof ApiChangedError) throw error;

    if (error instanceof Error) {
      if (error.name === "AbortError") {
        throw new NetworkError("Request timed out");
      }
      if (
        error.message.includes("NetworkError") ||
        error.message.includes("Failed to fetch") ||
        error.message.includes("network")
      ) {
        throw new NetworkError("Network connection failed");
      }
    }

    throw error;
  }
}

// ============================================================================
// Error Classification
// ============================================================================

function classifyError(error: unknown): ErrorInfo {
  if (error instanceof AuthExpiredError) {
    return { type: "auth_expired", message: error.message };
  }
  if (error instanceof RateLimitedError) {
    return {
      type: "rate_limited",
      message: error.message,
      retryAfter: error.retryAfter,
    };
  }
  if (error instanceof NetworkError) {
    return { type: "network_error", message: error.message };
  }
  if (error instanceof ApiChangedError) {
    return { type: "api_changed", message: error.message };
  }
  return {
    type: "unknown",
    message: error instanceof Error ? error.message : "Unknown error",
  };
}

// ============================================================================
// Formatting Helpers
// ============================================================================

function formatResetTime(isoString: string | null): string {
  if (!isoString) return "N/A";
  const date = new Date(isoString);
  const now = new Date();
  const diff = date.getTime() - now.getTime();

  if (diff < 0) return "Resetting...";

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return `${hours}h ${minutes}m`;
}

function getUsageColor(percentage: number): string {
  if (percentage >= 90) return "#ef4444"; // red
  if (percentage >= 70) return "#f59e0b"; // orange
  if (percentage >= 50) return "#eab308"; // yellow
  return "#10b981"; // green
}

function getUsageEmoji(percentage: number): string {
  if (percentage >= 90) return "🔴";
  if (percentage >= 70) return "🟠";
  if (percentage >= 50) return "🟡";
  return "🟢";
}

function getMiniBar(percentage: number): string {
  // Creates a mini bar using block characters: ▁▂▃▄▅▆▇█
  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const index = Math.min(Math.floor(percentage / 12.5), 7);
  return blocks[index];
}

// ============================================================================
// Menu Building
// ============================================================================

// deno-lint-ignore no-explicit-any
function buildSuccessMenu(data: UsageData): any[] {
  const fiveHourUsage = data.five_hour?.utilization ?? 0;
  const sevenDayUsage = data.seven_day?.utilization ?? 0;
  const sonnetUsage = data.seven_day_sonnet?.utilization ?? 0;

  const maxUsage = Math.max(fiveHourUsage, sevenDayUsage);
  const emoji = getUsageEmoji(maxUsage);
  const statusColor = getUsageColor(maxUsage);
  const bar5h = getMiniBar(fiveHourUsage);
  const bar7d = getMiniBar(sevenDayUsage);

  return [
    {
      text: `${emoji}  ${bar5h} ${fiveHourUsage}%  ${bar7d} ${sevenDayUsage}%`,
      color: statusColor,
    },
    separator,
    {
      text: "Plan usage limits",
      size: 14,
      font: "HelveticaNeue-Bold",
    },
    separator,
    {
      text: `Current session: ${fiveHourUsage}% used`,
      color: getUsageColor(fiveHourUsage),
      size: 13,
    },
    {
      text: `   Resets in ${formatResetTime(data.five_hour?.resets_at ?? null)}`,
      size: 11,
      color: "#888888",
    },
    separator,
    {
      text: "Weekly limits",
      size: 14,
      font: "HelveticaNeue-Bold",
    },
    separator,
    {
      text: `All models: ${sevenDayUsage}% used`,
      color: getUsageColor(sevenDayUsage),
      size: 13,
    },
    {
      text: `   Resets in ${formatResetTime(data.seven_day?.resets_at ?? null)}`,
      size: 11,
      color: "#888888",
    },
    {
      text: `Sonnet only: ${sonnetUsage}% used`,
      color: getUsageColor(sonnetUsage),
      size: 13,
    },
    {
      text:
        sonnetUsage === 0
          ? "   You haven't used Sonnet yet"
          : `   Resets in ${formatResetTime(data.seven_day_sonnet?.resets_at ?? null)}`,
      size: 11,
      color: "#888888",
    },
    separator,
    {
      text: "Actions",
      size: 14,
      font: "HelveticaNeue-Bold",
    },
    separator,
    {
      text: "Open Claude Settings",
      href: "https://claude.ai/settings/usage",
      size: 12,
    },
    {
      text: "Update Session Token...",
      bash: TOKEN_HELPER_CMD,
      terminal: true,
      size: 12,
    },
    {
      text: "Refresh",
      refresh: true,
      size: 12,
    },
  ];
}

// deno-lint-ignore no-explicit-any
function buildErrorMenu(error: ErrorInfo): any[] {
  const items: any[] = [];

  // Header based on error type
  let headerText = "Claude: Error";
  switch (error.type) {
    case "auth_expired":
      headerText = "Claude: Session Expired";
      break;
    case "rate_limited":
      headerText = "Claude: Rate Limited";
      break;
    case "network_error":
      headerText = "Claude: Offline";
      break;
    case "api_changed":
      headerText = "Claude: API Changed";
      break;
  }

  items.push({
    text: `⚠️ ${headerText}`,
    color: "#e35d4b",
  });

  items.push(separator);

  // Error message
  items.push({
    text: error.message,
    size: 11,
    color: "#e35d4b",
  });

  // Contextual help based on error type
  switch (error.type) {
    case "auth_expired":
      items.push({
        text: "Your session token has expired",
        size: 11,
      });
      items.push(separator);
      items.push({
        text: "Update Session Token...",
        bash: TOKEN_HELPER_CMD,
        terminal: true,
        size: 12,
        color: "#10b981",
      });
      break;

    case "rate_limited":
      items.push({
        text: `Try again in ${error.retryAfter ?? 60} seconds`,
        size: 11,
      });
      break;

    case "network_error":
      items.push({
        text: "Check your internet connection",
        size: 11,
      });
      break;

    case "api_changed":
      items.push({
        text: "The plugin may need to be updated",
        size: 11,
      });
      items.push({
        text: "Check for plugin updates",
        size: 11,
      });
      break;

    default:
      items.push({
        text: "Check your SESSION_KEY and ORG_ID",
        size: 11,
      });
  }

  items.push(separator);
  items.push({
    text: "Open Claude Settings",
    href: "https://claude.ai/settings/usage",
    size: 12,
  });
  items.push({
    text: "Refresh",
    refresh: true,
    size: 12,
  });

  return items;
}

// deno-lint-ignore no-explicit-any
function buildNotConfiguredMenu(): any[] {
  return [
    {
      text: "⚙️ Claude: Setup Required",
      color: "#f59e0b",
    },
    separator,
    {
      text: "SESSION_KEY and ORG_ID not configured",
      size: 11,
    },
    separator,
    {
      text: "Run Token Helper to configure...",
      bash: TOKEN_HELPER_CMD,
      terminal: true,
      size: 12,
      color: "#10b981",
    },
    separator,
    {
      text: "Or set variables manually in xbar",
      size: 11,
      color: "#888888",
    },
    {
      text: "Open xbar Preferences",
      href: "xbar://app.xbarapp.com/openPlugin?path=" +
        encodeURIComponent(PLUGIN_DIR + "/claude.1m.ts"),
      size: 12,
    },
  ];
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const env = Deno.env.toObject();
  const rawSessionKey = env.SESSION_KEY || "";
  const rawOrgId = env.ORG_ID || "";

  // Sanitize xbar variables (they may contain binary prefixes)
  const sessionKey = sanitizeXbarVariable(rawSessionKey, "session");
  const orgId = sanitizeXbarVariable(rawOrgId, "org");

  // Not configured
  if (!sessionKey || !orgId) {
    return xbar(buildNotConfiguredMenu());
  }

  // Load notification state
  const state = await loadState();

  try {
    const data = await fetchUsageData(sessionKey, orgId);

    // Clear auth error state on successful fetch
    state.authErrorNotified = false;
    state.lastAuthErrorAt = null;

    // Check and send usage notifications
    const fiveHourUsage = data.five_hour?.utilization ?? 0;
    const sevenDayUsage = data.seven_day?.utilization ?? 0;

    await checkAndNotifyUsage(
      fiveHourUsage,
      data.five_hour?.resets_at ?? null,
      "5-hour session",
      state,
      "fiveHourNotifiedThreshold",
      "lastFiveHourResetTime"
    );

    await checkAndNotifyUsage(
      sevenDayUsage,
      data.seven_day?.resets_at ?? null,
      "7-day",
      state,
      "sevenDayNotifiedThreshold",
      "lastSevenDayResetTime"
    );

    await saveState(state);

    return xbar(buildSuccessMenu(data));
  } catch (error) {
    const errorInfo = classifyError(error);

    // Send auth expired notification
    if (errorInfo.type === "auth_expired") {
      await notifyAuthExpired(state);
      await saveState(state);
    }

    return xbar(buildErrorMenu(errorInfo));
  }
}

main();
