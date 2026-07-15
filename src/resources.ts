import os from "node:os";
import { runProcess } from "./process.js";

export interface LocalResourceSnapshot {
  observedAt: string;
  ram: { totalBytes: number; freeBytes: number; usedPercent: number };
  gpu: Array<{ name: string; totalMiB: number; usedMiB: number; freeMiB: number; utilizationPercent: number }>;
  ollamaLoadedModels: Array<{ name: string; sizeBytes: number | null; sizeVramBytes: number | null; expiresAt: string | null }>;
  advisoryLocalSlots: number;
}

export async function observeLocalResources(ollamaUrl = "http://127.0.0.1:11434"): Promise<LocalResourceSnapshot> {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const [gpu, loaded] = await Promise.all([observeGpu(), observeOllamaLoads(ollamaUrl)]);
  const largestLoadedBytes = Math.max(0, ...loaded.map((model) => model.sizeBytes ?? 0));
  const assumedBytesPerSlot = Math.max(4 * 1024 ** 3, largestLoadedBytes);
  return {
    observedAt: new Date().toISOString(),
    ram: { totalBytes, freeBytes, usedPercent: Math.round((1 - freeBytes / totalBytes) * 1_000) / 10 },
    gpu,
    ollamaLoadedModels: loaded,
    // Advisory only. The capacity broker may queue work, but DevHarmonics does
    // not impose a product-level agent ceiling.
    advisoryLocalSlots: Math.max(1, Math.floor(freeBytes / assumedBytesPerSlot)),
  };
}

async function observeGpu(): Promise<LocalResourceSnapshot["gpu"]> {
  try {
    const result = await runProcess({
      command: "nvidia-smi",
      args: ["--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu", "--format=csv,noheader,nounits"],
      cwd: process.cwd(),
      timeoutMs: 3_000,
    });
    return result.exitCode === 0 ? parseNvidiaSmi(result.stdout) : [];
  } catch {
    return [];
  }
}

export function parseNvidiaSmi(value: string): LocalResourceSnapshot["gpu"] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const [name, total, used, free, utilization] = line.split(",").map((part) => part.trim());
    const numbers = [total, used, free, utilization].map(Number);
    if (!name || numbers.some((number) => !Number.isFinite(number))) return [];
    return [{ name, totalMiB: numbers[0]!, usedMiB: numbers[1]!, freeMiB: numbers[2]!, utilizationPercent: numbers[3]! }];
  });
}

async function observeOllamaLoads(baseUrl: string): Promise<LocalResourceSnapshot["ollamaLoadedModels"]> {
  try {
    const url = new URL(baseUrl);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return [];
    const response = await fetch(`${url.origin}/api/ps`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return [];
    const value = await response.json() as { models?: Array<{ name?: string; size?: number; size_vram?: number; expires_at?: string }> };
    return (value.models ?? []).filter((model) => model.name).map((model) => ({ name: model.name!, sizeBytes: model.size ?? null, sizeVramBytes: model.size_vram ?? null, expiresAt: model.expires_at ?? null }));
  } catch {
    return [];
  }
}
