/**
 * Usage Limit segment for Claude Pro/Max/Team subscription users.
 * Reads OAuth credentials from macOS Keychain and fetches usage data from Anthropic API.
 *
 * This is complementary to the existing session/block/today segments which track
 * calculated costs for API users. This segment shows actual subscription usage limits.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import { execSync } from "child_process";
import { debug } from "../utils/logger";

// Types
export interface UsageLimitData {
  planName: string | null;  // 'Max', 'Pro', 'Team', or null for API users
  fiveHour: number | null;  // 0-100 percentage
  sevenDay: number | null;  // 0-100 percentage
  fiveHourResetAt: Date | null;
  sevenDayResetAt: Date | null;
  apiUnavailable?: boolean;
}

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    subscriptionType?: string;
    rateLimitTier?: string;
    expiresAt?: number;
    scopes?: string[];
  };
}

interface UsageApiResponse {
  five_hour?: {
    utilization?: number;
    resets_at?: string;
  };
  seven_day?: {
    utilization?: number;
    resets_at?: string;
  };
}

// Cache configuration
const CACHE_TTL_MS = 60_000; // 60 seconds
const CACHE_FAILURE_TTL_MS = 15_000; // 15 seconds for failed requests
const KEYCHAIN_TIMEOUT_MS = 10_000; // 10 seconds for keychain access (allows for permission dialog)

interface CacheFile {
  data: UsageLimitData;
  timestamp: number;
}

function getCachePath(homeDir: string): string {
  return path.join(homeDir, ".claude", "plugins", "claude-powerline", ".usage-cache.json");
}

function readCache(homeDir: string, now: number): UsageLimitData | null {
  try {
    const cachePath = getCachePath(homeDir);
    if (!fs.existsSync(cachePath)) return null;

    const content = fs.readFileSync(cachePath, "utf8");
    const cache: CacheFile = JSON.parse(content);

    const ttl = cache.data.apiUnavailable ? CACHE_FAILURE_TTL_MS : CACHE_TTL_MS;
    if (now - cache.timestamp >= ttl) return null;

    // Reconvert dates from ISO strings
    const data = cache.data;
    if (data.fiveHourResetAt) {
      data.fiveHourResetAt = new Date(data.fiveHourResetAt);
    }
    if (data.sevenDayResetAt) {
      data.sevenDayResetAt = new Date(data.sevenDayResetAt);
    }

    return data;
  } catch {
    return null;
  }
}

function writeCache(homeDir: string, data: UsageLimitData, timestamp: number): void {
  try {
    const cachePath = getCachePath(homeDir);
    const cacheDir = path.dirname(cachePath);

    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const cache: CacheFile = { data, timestamp };
    fs.writeFileSync(cachePath, JSON.stringify(cache), "utf8");
  } catch {
    // Ignore cache write failures
  }
}

/**
 * Read credentials from macOS Keychain.
 * Claude Code 2.x stores OAuth credentials in the Keychain under "Claude Code-credentials".
 */
function readKeychainCredentials(now: number): { accessToken: string; subscriptionType: string } | null {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const keychainData = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: KEYCHAIN_TIMEOUT_MS }
    ).trim();

    if (!keychainData) {
      return null;
    }

    const data: CredentialsFile = JSON.parse(keychainData);
    return parseCredentialsData(data, now);
  } catch (error) {
    debug("Failed to read from macOS Keychain:", error);
    return null;
  }
}

/**
 * Read credentials from file (legacy method for older Claude Code versions).
 */
function readFileCredentials(homeDir: string, now: number): { accessToken: string; subscriptionType: string } | null {
  const credentialsPath = path.join(homeDir, ".claude", ".credentials.json");

  if (!fs.existsSync(credentialsPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(credentialsPath, "utf8");
    const data: CredentialsFile = JSON.parse(content);
    return parseCredentialsData(data, now);
  } catch (error) {
    debug("Failed to read credentials file:", error);
    return null;
  }
}

function parseCredentialsData(data: CredentialsFile, now: number): { accessToken: string; subscriptionType: string } | null {
  const accessToken = data.claudeAiOauth?.accessToken;
  const subscriptionType = data.claudeAiOauth?.subscriptionType ?? "";

  if (!accessToken) {
    return null;
  }

  const expiresAt = data.claudeAiOauth?.expiresAt;
  if (expiresAt != null && expiresAt <= now) {
    debug("OAuth token expired");
    return null;
  }

  return { accessToken, subscriptionType };
}

function readCredentials(homeDir: string, now: number): { accessToken: string; subscriptionType: string } | null {
  // Try macOS Keychain first (Claude Code 2.x)
  const keychainCreds = readKeychainCredentials(now);
  if (keychainCreds) {
    if (!keychainCreds.subscriptionType) {
      debug("Keychain credentials missing subscriptionType, falling back to file");
    } else {
      debug("Using credentials from macOS Keychain");
      return keychainCreds;
    }
  }

  // Fall back to file-based credentials
  const fileCreds = readFileCredentials(homeDir, now);
  if (fileCreds) {
    debug("Using credentials from file");
    return fileCreds;
  }

  return null;
}

function getPlanName(subscriptionType: string): string | null {
  const lower = subscriptionType.toLowerCase();
  if (lower.includes("max")) return "Max";
  if (lower.includes("pro")) return "Pro";
  if (lower.includes("team")) return "Team";
  if (!subscriptionType || lower.includes("api")) return null;
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
}

function parseUtilization(value: number | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(100, value)));
}

function parseDate(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    debug("Invalid date string:", dateStr);
    return null;
  }
  return date;
}

function fetchUsageApi(accessToken: string): Promise<UsageApiResponse | null> {
  return new Promise((resolve) => {
    const options = {
      hostname: "api.anthropic.com",
      path: "/api/oauth/usage",
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-powerline/1.0",
      },
      timeout: 5000,
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });

      res.on("end", () => {
        if (res.statusCode !== 200) {
          debug("API returned non-200 status:", res.statusCode);
          resolve(null);
          return;
        }

        try {
          const parsed: UsageApiResponse = JSON.parse(data);
          resolve(parsed);
        } catch (error) {
          debug("Failed to parse API response:", error);
          resolve(null);
        }
      });
    });

    req.on("error", (error) => {
      debug("API request error:", error);
      resolve(null);
    });
    req.on("timeout", () => {
      debug("API request timeout");
      req.destroy();
      resolve(null);
    });

    req.end();
  });
}

/**
 * Provider for subscription usage limits (Pro/Max/Team users).
 */
export class UsageLimitProvider {
  async getUsageLimitInfo(): Promise<UsageLimitData | null> {
    const now = Date.now();
    const homeDir = os.homedir();

    // Check cache first
    const cached = readCache(homeDir, now);
    if (cached) {
      return cached;
    }

    try {
      const credentials = readCredentials(homeDir, now);
      if (!credentials) {
        return null;
      }

      const { accessToken, subscriptionType } = credentials;
      const planName = getPlanName(subscriptionType);

      if (!planName) {
        // API user, no usage limits
        return null;
      }

      const apiResponse = await fetchUsageApi(accessToken);
      if (!apiResponse) {
        const failureResult: UsageLimitData = {
          planName,
          fiveHour: null,
          sevenDay: null,
          fiveHourResetAt: null,
          sevenDayResetAt: null,
          apiUnavailable: true,
        };
        writeCache(homeDir, failureResult, now);
        return failureResult;
      }

      const fiveHour = parseUtilization(apiResponse.five_hour?.utilization);
      const sevenDay = parseUtilization(apiResponse.seven_day?.utilization);
      const fiveHourResetAt = parseDate(apiResponse.five_hour?.resets_at);
      const sevenDayResetAt = parseDate(apiResponse.seven_day?.resets_at);

      const result: UsageLimitData = {
        planName,
        fiveHour,
        sevenDay,
        fiveHourResetAt,
        sevenDayResetAt,
      };

      writeCache(homeDir, result, now);
      return result;
    } catch (error) {
      debug("getUsageLimitInfo failed:", error);
      return null;
    }
  }
}

/**
 * Format reset time as human-readable string.
 */
export function formatResetTime(resetAt: Date | null): string {
  if (!resetAt) return "";
  const now = new Date();
  const diffMs = resetAt.getTime() - now.getTime();
  if (diffMs <= 0) return "";

  const diffMins = Math.ceil(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;

  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Check if usage limit is reached.
 */
export function isLimitReached(data: UsageLimitData): boolean {
  return data.fiveHour === 100 || data.sevenDay === 100;
}
