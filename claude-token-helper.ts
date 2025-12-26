#!/usr/bin/env -S -P/${HOME}/.deno/bin:/opt/homebrew/bin:/usr/local/bin deno run --allow-all
/**
 * Claude Token Helper
 *
 * Extracts the Claude session token (sessionKey) and organization ID from Chrome.
 *
 * Usage: Run this script from the terminal or via the xbar plugin menu.
 * 
 * Environment variables:
 *   CHROME_PROFILE - Chrome profile name (default: "Default")
 */

import { existsSync } from "https://deno.land/std@0.208.0/fs/exists.ts";
import { join } from "https://deno.land/std@0.208.0/path/mod.ts";

// ============================================================================
// Types
// ============================================================================

interface ExtractionResult {
  success: boolean;
  browser: string;
  sessionKey?: string;
  orgId?: string;
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const HOME = Deno.env.get("HOME") || "";

// Chrome profile - configurable via environment variable, defaults to "Default"
const CHROME_PROFILE = Deno.env.get("CHROME_PROFILE") || "Default";
const CHROME_BASE_PATH = join(
  HOME,
  "Library/Application Support/Google/Chrome"
);

// Colors for terminal output - only use if TTY is detected
const isTTY = Deno.stdout.isTerminal();

const RESET = isTTY ? "\x1b[0m" : "";
const GREEN = isTTY ? "\x1b[32m" : "";
const RED = isTTY ? "\x1b[31m" : "";
const YELLOW = isTTY ? "\x1b[33m" : "";
const CYAN = isTTY ? "\x1b[36m" : "";
const BOLD = isTTY ? "\x1b[1m" : "";
const DIM = isTTY ? "\x1b[2m" : "";

// ============================================================================
// Utility Functions
// ============================================================================

function log(message: string, color = RESET): void {
  // Only output if running in a real terminal (not captured by xbar)
  if (isTTY) {
    console.log(`${color}${message}${RESET}`);
  }
}

function logSection(title: string): void {
  if (isTTY) {
    console.log(`\n${BOLD}${title}${RESET}\n`);
  }
}

async function runCommand(
  cmd: string,
  args: string[]
): Promise<{ success: boolean; output: string; error: string }> {
  try {
    const command = new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    return {
      success: result.success,
      output: new TextDecoder().decode(result.stdout).trim(),
      error: new TextDecoder().decode(result.stderr).trim(),
    };
  } catch (error) {
    return {
      success: false,
      output: "",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// ============================================================================
// Chrome Cookie Extraction
// ============================================================================

async function getChromeEncryptionKey(): Promise<string | null> {
  const result = await runCommand("security", [
    "find-generic-password",
    "-w",
    "-s",
    "Chrome Safe Storage",
  ]);

  if (!result.success || !result.output) {
    return null;
  }

  return result.output;
}

function deriveKey(password: string): Uint8Array {
  // Chrome uses PBKDF2 with specific parameters
  // For simplicity, we'll use a shell command to derive the key
  // since Deno's crypto API requires more setup

  // The derivation: PBKDF2(password, "saltysalt", 1003, 16, "sha1")
  // We'll use openssl for this
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);
  const salt = encoder.encode("saltysalt");

  // Use Web Crypto API for PBKDF2
  // This is synchronous approximation - in production use async
  // For now, we'll shell out to openssl

  return new Uint8Array(16); // Placeholder - actual implementation below
}

async function deriveKeyAsync(password: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);
  const salt = encoder.encode("saltysalt");

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    passwordBytes,
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 1003,
      hash: "SHA-1",
    },
    keyMaterial,
    128 // 16 bytes * 8 bits
  );

  return new Uint8Array(derivedBits);
}

async function decryptChromeValue(
  encryptedHex: string,
  derivedKey: Uint8Array
): Promise<string | null> {
  try {
    // Convert hex to bytes
    const encryptedBytes = new Uint8Array(
      encryptedHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
    );

    // Check for v10/v11 prefix (Chrome encryption version)
    const prefix = new TextDecoder().decode(encryptedBytes.slice(0, 3));
    if (prefix !== "v10" && prefix !== "v11") {
      // Not encrypted, return as-is
      return new TextDecoder().decode(encryptedBytes);
    }

    // Skip the version prefix (3 bytes)
    const ciphertext = encryptedBytes.slice(3);

    // IV is 16 bytes of space character (0x20)
    const iv = new Uint8Array(16).fill(0x20);

    // Import the key for AES-CBC
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      derivedKey,
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );

    // Decrypt
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv },
      cryptoKey,
      ciphertext
    );

    // Convert to string
    const rawDecrypted = new TextDecoder().decode(decrypted);
    
    // The decrypted value may contain a 32-byte hash prefix (Chrome v80+)
    // Extract the actual value by looking for known patterns
    
    // For sessionKey: look for "sk-ant-" pattern
    const sessionMatch = rawDecrypted.match(/sk-ant-sid\d+-[A-Za-z0-9_-]+/);
    if (sessionMatch) {
      return sessionMatch[0];
    }
    
    // For UUID (org ID): look for UUID pattern
    const uuidMatch = rawDecrypted.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch) {
      return uuidMatch[0];
    }
    
    // Fallback: return everything after the binary prefix
    // Find first printable ASCII sequence of reasonable length
    const printableMatch = rawDecrypted.match(/[\x20-\x7E]{8,}/);
    if (printableMatch) {
      return printableMatch[0];
    }
    
    return rawDecrypted;
  } catch {
    return null;
  }
}

async function extractFromChrome(): Promise<ExtractionResult> {
  log(`Checking Chrome profile: ${CHROME_PROFILE}...`, DIM);

  const cookiesPath = join(CHROME_BASE_PATH, CHROME_PROFILE, "Cookies");

  if (!existsSync(cookiesPath)) {
    return {
      success: false,
      browser: "Chrome",
      error: `Chrome profile "${CHROME_PROFILE}" not found. Set CHROME_PROFILE env var to change.`,
    };
  }

  // Get encryption key from keychain
  const keychainPassword = await getChromeEncryptionKey();
  if (!keychainPassword) {
    return {
      success: false,
      browser: "Chrome",
      error: "Could not get Chrome encryption key from Keychain",
    };
  }

  log("  Got encryption key from Keychain", DIM);

  // Derive the AES key
  const derivedKey = await deriveKeyAsync(keychainPassword);

  // Copy the database to a temp location (Chrome locks it while running)
  const tempDir = await Deno.makeTempDir({ prefix: "chrome-cookies-" });
  const tempDbPath = join(tempDir, "Cookies");

  try {
    await Deno.copyFile(cookiesPath, tempDbPath);

    // Also copy WAL and SHM files if they exist
    for (const ext of ["-wal", "-shm"]) {
      const source = cookiesPath + ext;
      if (existsSync(source)) {
        await Deno.copyFile(source, tempDbPath + ext);
      }
    }

    log("  Copied database to temp location", DIM);

    // Query for claude.ai cookies
    const query = `SELECT name, hex(encrypted_value) as encrypted_hex, host_key 
                   FROM cookies 
                   WHERE host_key LIKE '%claude.ai%' 
                   AND (name = 'sessionKey' OR name = 'lastActiveOrg');`;

    const result = await runCommand("sqlite3", [
      "-separator",
      "|",
      tempDbPath,
      query,
    ]);

    if (!result.success) {
      return {
        success: false,
        browser: "Chrome",
        error: `SQLite query failed: ${result.error}`,
      };
    }

    if (!result.output) {
      return {
        success: false,
        browser: "Chrome",
        error: "No Claude cookies found in Chrome",
      };
    }

    // Parse results
    let sessionKey: string | null = null;
    let orgId: string | null = null;

    for (const line of result.output.split("\n")) {
      const [name, encryptedHex] = line.split("|");
      if (!name || !encryptedHex) continue;

      const decrypted = await decryptChromeValue(encryptedHex, derivedKey);
      if (!decrypted) continue;

      if (name === "sessionKey") {
        sessionKey = decrypted;
      } else if (name === "lastActiveOrg") {
        orgId = decrypted;
      }
    }

    if (!sessionKey) {
      return {
        success: false,
        browser: "Chrome",
        error: "sessionKey cookie not found or could not be decrypted",
      };
    }

    return {
      success: true,
      browser: `Chrome (${CHROME_PROFILE})`,
      sessionKey,
      orgId: orgId || undefined,
    };
  } finally {
    // Cleanup temp files
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}





// ============================================================================
// xbar Variable Update
// ============================================================================

async function updateXbarVariables(
  sessionKey: string,
  orgId: string | null
): Promise<boolean> {
  const pluginPath = join(
    HOME,
    "Library/Application Support/xbar/plugins/claude.1m.ts"
  );

  if (!existsSync(pluginPath)) {
    log("\nPlugin file not found at expected location.", YELLOW);
    return false;
  }

  // xbar stores variables in a plist file
  const plistPath = join(
    HOME,
    "Library/Application Support/xbar/plugins/claude.1m.ts.vars.json"
  );

  try {
    const vars: Record<string, string> = {};

    // Try to read existing vars
    if (existsSync(plistPath)) {
      try {
        const existing = JSON.parse(await Deno.readTextFile(plistPath));
        Object.assign(vars, existing);
      } catch {
        // Ignore parse errors
      }
    }

    // Update with new values
    vars["SESSION_KEY"] = sessionKey;
    if (orgId) {
      vars["ORG_ID"] = orgId;
    }

    await Deno.writeTextFile(plistPath, JSON.stringify(vars, null, 2));
    return true;
  } catch (error) {
    log(`\nFailed to update xbar variables: ${error}`, RED);
    return false;
  }
}

// ============================================================================
// Manual Instructions
// ============================================================================

function showManualInstructions(): void {
  logSection("Manual Extraction Steps");

  log("1. Open https://claude.ai in Chrome", CYAN);
  log("2. Log in if needed", CYAN);
  log("3. Open Developer Tools: Cmd+Option+I", CYAN);
  log("4. Go to Application > Cookies > https://claude.ai", CYAN);
  log("5. Find and copy these values:", CYAN);
  log("   - sessionKey (this is your SESSION_KEY)", DIM);
  log("   - lastActiveOrg (this is your ORG_ID)", DIM);
  log("");
  log("6. Update xbar plugin variables with these values", CYAN);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  log(`${BOLD}Claude Token Helper v1.0${RESET}\n`);
  log("Extracting credentials from browser...", DIM);

  // Extract from Chrome
  const result = await extractFromChrome();
  let successResult: ExtractionResult | null = null;

  if (result.success) {
    successResult = result;
  } else {
    log(`${RED}✗${RESET} ${result.error}`, DIM);
  }

  if (successResult) {
    logSection("Success!");
    log(`${GREEN}✓${RESET} Found credentials in ${successResult.browser}\n`);

    log(`${BOLD}SESSION_KEY:${RESET}`);
    log(`${GREEN}${successResult.sessionKey}${RESET}\n`);

    if (successResult.orgId) {
      log(`${BOLD}ORG_ID:${RESET}`);
      log(`${GREEN}${successResult.orgId}${RESET}\n`);
    } else {
      log(`${YELLOW}ORG_ID not found - you'll need to set this manually${RESET}\n`);
    }

    // Try to update xbar variables automatically
    log("Attempting to update xbar plugin variables...", DIM);
    const updated = await updateXbarVariables(
      successResult.sessionKey!,
      successResult.orgId || null
    );

    if (updated) {
      log(`\n${GREEN}✓${RESET} Updated xbar plugin variables!`);
      log(`\n${BOLD}Refresh the xbar plugin to apply changes.${RESET}`);
    } else {
      logSection("Manual Setup Required");
      log("Copy the values above and set them in xbar plugin variables:");
      log("1. Click the xbar icon in your menu bar");
      log("2. Click on the Claude plugin");
      log("3. Select 'Open Plugin...' or configure variables in xbar preferences");
    }
  } else {
    logSection("Automatic Extraction Failed");
    log(`${RED}Could not extract credentials from any browser.${RESET}\n`);
    log("This can happen if:");
    log("  - You're not logged into claude.ai in any browser");
    log("  - Browser is running and has locked the cookie database");
    log("  - Permissions are preventing access to cookie files\n");

    showManualInstructions();
  }

  if (isTTY) {
    console.log("");
    log("Press Enter to exit...", DIM);
    
    // Wait for user input before closing
    const buf = new Uint8Array(1);
    await Deno.stdin.read(buf);
  }
}

main().catch((error) => {
  log(`\n${RED}Fatal error: ${error.message}${RESET}`);
  Deno.exit(1);
});
