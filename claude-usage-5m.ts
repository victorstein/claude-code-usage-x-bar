#!/usr/bin/env -S -P/${HOME}/.deno/bin:/opt/homebrew/bin:/usr/local/bin deno run --allow-all
// <xbar.title>Claude Usage Meter</xbar.title>
// <xbar.desc>Shows Claude.ai usage limits and reset times</xbar.desc>
// <xbar.version>v1.0</xbar.version>
// <xbar.author>Gustavo Gomez</xbar.author>
// <xbar.dependencies>Deno</xbar.dependencies>

//  Variables
//  <xbar.var>string(SESSION_KEY=""): Claude session key from cookies (sessionKey)</xbar.var>
//  <xbar.var>string(ORG_ID=""): Claude organization ID</xbar.var>

import { xbar, separator } from "https://deno.land/x/xbar@v2.1.0/mod.ts";

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

async function fetchUsageData(sessionKey: string, orgId: string): Promise<UsageData> {
  const response = await fetch(
    `https://claude.ai/api/organizations/${orgId}/usage`,
    {
      headers: {
        Cookie: `sessionKey=${sessionKey}`,
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

async function main() {
  const env = Deno.env.toObject();
  const { SESSION_KEY: sessionKey, ORG_ID: orgId } = env;

  if (!sessionKey || !orgId) {
    return xbar([
      {
        text: "⚡ Claude: Not configured",
        color: "#e35d4b",
      },
      separator,
      {
        text: "Set SESSION_KEY and ORG_ID in xbar plugin variables",
        size: 11,
      },
    ]);
  }

  try {
    const data = await fetchUsageData(sessionKey, orgId);

    const fiveHourUsage = data.five_hour?.utilization ?? 0;
    const sevenDayUsage = data.seven_day?.utilization ?? 0;
    const sonnetUsage = data.seven_day_sonnet?.utilization ?? 0;

    const emoji = getUsageEmoji(Math.max(fiveHourUsage, sevenDayUsage));

    return xbar([
      {
        text: `${emoji} 5h:${fiveHourUsage}% 7d:${sevenDayUsage}%`,
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
        text: sonnetUsage === 0
          ? "   You haven't used Sonnet yet"
          : `   Resets in ${formatResetTime(data.seven_day_sonnet?.resets_at ?? null)}`,
        size: 11,
        color: "#888888",
      },
      separator,
      {
        text: "Open Claude Settings",
        href: "https://claude.ai/settings/usage",
        size: 12,
      },
      {
        text: "Refresh",
        refresh: true,
        size: 12,
      },
    ]);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return xbar([
      {
        text: "⚡ Claude: Error",
        color: "#e35d4b",
      },
      separator,
      {
        text: errorMessage,
        size: 11,
        color: "#e35d4b",
      },
      {
        text: "Check your SESSION_KEY - it may have expired",
        size: 11,
      },
      separator,
      {
        text: "Refresh",
        refresh: true,
        size: 12,
      },
    ]);
  }
}

main();
