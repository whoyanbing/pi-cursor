import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_URL,
  bridgeMaxPauseMs,
  clientVersion,
  getAgentUrl,
  normalizeBaseUrl,
  prewarmClientVersion,
  readCliAgentUrl,
  resetAgentUrlCache,
  resetClientVersionCache,
  streamIdleTimeoutMs,
} from "../config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const envSnapshot = { ...process.env };

beforeEach(() => {
  resetAgentUrlCache();
  resetClientVersionCache();
  delete process.env.PI_CURSOR_AGENT_URL;
  delete process.env.CURSOR_AGENT_URL;
  process.env.CURSOR_CONFIG_DIR = join(homedir(), ".pi", "agent", "cursor-config-missing");
});

afterEach(() => {
  process.env = { ...envSnapshot };
  resetAgentUrlCache();
  resetClientVersionCache();
});

describe("normalizeBaseUrl", () => {
  it("keeps http(s) URLs and strips trailing slashes, query and hash", () => {
    expect(normalizeBaseUrl("https://api.example.com/")).toBe("https://api.example.com");
    expect(normalizeBaseUrl("https://api.example.com/path/?x=1#y")).toBe("https://api.example.com/path");
    expect(normalizeBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("rejects non-URLs and other schemes", () => {
    expect(normalizeBaseUrl("not a url")).toBeUndefined();
    expect(normalizeBaseUrl("ftp://example.com")).toBeUndefined();
    expect(normalizeBaseUrl("")).toBeUndefined();
    expect(normalizeBaseUrl(42)).toBeUndefined();
    expect(normalizeBaseUrl(undefined)).toBeUndefined();
  });
});

describe("getAgentUrl", () => {
  it("defaults to the well-known agent host", () => {
    expect(getAgentUrl()).toBe(DEFAULT_AGENT_URL);
  });

  it("prefers PI_CURSOR_AGENT_URL", () => {
    process.env.PI_CURSOR_AGENT_URL = "https://custom.example.com/";
    expect(getAgentUrl()).toBe("https://custom.example.com");
  });

  it("accepts CURSOR_AGENT_URL as a second env source", () => {
    process.env.CURSOR_AGENT_URL = "https://second.example.com";
    expect(getAgentUrl()).toBe("https://second.example.com");
  });

  it("reads the Cursor CLI config cache when present", () => {
    const configDir = join(homedir(), ".pi", "agent", "cursor-cli-config");
    mkdirSync(configDir, { recursive: true });
    process.env.CURSOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "cli-config.json"),
      JSON.stringify({ serverConfigCache: { agentUrlConfig: { agentnUrl: "https://from-cli.example.com/" } } }),
      "utf8",
    );
    expect(readCliAgentUrl()).toBe("https://from-cli.example.com");
    expect(getAgentUrl()).toBe("https://from-cli.example.com");
    rmSync(configDir, { recursive: true, force: true });
  });

  it("falls back to agentUrl when agentnUrl is absent", () => {
    const configDir = join(homedir(), ".pi", "agent", "cursor-cli-config-2");
    mkdirSync(configDir, { recursive: true });
    process.env.CURSOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "cli-config.json"),
      JSON.stringify({ serverConfigCache: { agentUrlConfig: { agentUrl: "https://plain.example.com" } } }),
      "utf8",
    );
    expect(readCliAgentUrl()).toBe("https://plain.example.com");
    rmSync(configDir, { recursive: true, force: true });
  });

  it("env wins over the CLI cache", () => {
    const configDir = join(homedir(), ".pi", "agent", "cursor-cli-config-3");
    mkdirSync(configDir, { recursive: true });
    process.env.CURSOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "cli-config.json"),
      JSON.stringify({ serverConfigCache: { agentUrlConfig: { agentnUrl: "https://from-cli.example.com" } } }),
      "utf8",
    );
    process.env.PI_CURSOR_AGENT_URL = "https://env.example.com";
    expect(getAgentUrl()).toBe("https://env.example.com");
    rmSync(configDir, { recursive: true, force: true });
  });

  it("re-resolves env overrides on every call", () => {
    process.env.PI_CURSOR_AGENT_URL = "https://cached.example.com";
    expect(getAgentUrl()).toBe("https://cached.example.com");
    delete process.env.PI_CURSOR_AGENT_URL;
    expect(getAgentUrl()).toBe(DEFAULT_AGENT_URL);
  });

  it("caches the CLI agent URL until reset", () => {
    const configDir = join(homedir(), ".pi", "agent", "cursor-cli-config-ttl");
    mkdirSync(configDir, { recursive: true });
    process.env.CURSOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "cli-config.json"),
      JSON.stringify({ serverConfigCache: { agentUrlConfig: { agentnUrl: "https://cli-a.example.com" } } }),
      "utf8",
    );
    expect(getAgentUrl()).toBe("https://cli-a.example.com");
    writeFileSync(
      join(configDir, "cli-config.json"),
      JSON.stringify({ serverConfigCache: { agentUrlConfig: { agentnUrl: "https://cli-b.example.com" } } }),
      "utf8",
    );
    expect(getAgentUrl()).toBe("https://cli-a.example.com");
    resetAgentUrlCache();
    expect(getAgentUrl()).toBe("https://cli-b.example.com");
    rmSync(configDir, { recursive: true, force: true });
  });

  it("survives a malformed CLI config", () => {
    const configDir = join(homedir(), ".pi", "agent", "cursor-cli-bad");
    mkdirSync(configDir, { recursive: true });
    process.env.CURSOR_CONFIG_DIR = configDir;
    writeFileSync(join(configDir, "cli-config.json"), "{not json", "utf8");
    expect(readCliAgentUrl()).toBeUndefined();
    expect(getAgentUrl()).toBe(DEFAULT_AGENT_URL);
    rmSync(configDir, { recursive: true, force: true });
  });
});

describe("clientVersion", () => {
  it("has a cli-prefixed default", () => {
    delete process.env.PI_CURSOR_CLIENT_VERSION;
    resetClientVersionCache();
    expect(clientVersion()).toMatch(/^cli-/);
  });

  it("honours PI_CURSOR_CLIENT_VERSION", () => {
    process.env.PI_CURSOR_CLIENT_VERSION = "cli-test-123";
    expect(clientVersion()).toBe("cli-test-123");
  });

  it("does not let the env override poison the probe cache", () => {
    process.env.PI_CURSOR_CLIENT_VERSION = "cli-test-123";
    expect(clientVersion()).toBe("cli-test-123");
    delete process.env.PI_CURSOR_CLIENT_VERSION;
    resetClientVersionCache();
    expect(clientVersion()).toMatch(/^cli-/);
    expect(clientVersion()).not.toBe("cli-test-123");
  });

  it("never blocks the request path on the probe", () => {
    delete process.env.PI_CURSOR_CLIENT_VERSION;
    resetClientVersionCache();
    const started = Date.now();
    const value = clientVersion();
    expect(Date.now() - started).toBeLessThan(50);
    expect(value).toMatch(/^cli-/);
  });

  it("prewarm resolves to a cli-prefixed version and caches it", async () => {
    delete process.env.PI_CURSOR_CLIENT_VERSION;
    resetClientVersionCache();
    const value = await prewarmClientVersion();
    expect(value).toMatch(/^cli-/);
    expect(clientVersion()).toBe(value);
  });
});

describe("numeric tunables", () => {
  it("streamIdleTimeoutMs defaults to 3 minutes", () => {
    delete process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS;
    expect(streamIdleTimeoutMs()).toBe(180_000);
  });

  it("streamIdleTimeoutMs accepts 0 to disable", () => {
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "0";
    expect(streamIdleTimeoutMs()).toBe(0);
  });

  it("ignores invalid values", () => {
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "abc";
    expect(streamIdleTimeoutMs()).toBe(180_000);
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "-5";
    expect(streamIdleTimeoutMs()).toBe(180_000);
  });

  it("bridgeMaxPauseMs defaults to 15 minutes", () => {
    delete process.env.PI_CURSOR_BRIDGE_PAUSE_MS;
    expect(bridgeMaxPauseMs()).toBe(900_000);
  });
});
