/**
 * Layer-2 service discovery: finds the running containers of the local compose project by label
 * and reads their health, published ports and emulation labels (io.vsp.* in the compose fragments).
 * The compose files are the single source of the labels the test report carries.
 */
import { execFileSync } from "node:child_process";

export interface EmulationLabel {
  service: string;
  image: string;
  /** Production system the service stands in for. */
  emulates: string;
  protocol: string;
  /** What a passing test against this service does not prove. */
  notEmulated: string;
}

export interface DiscoveredService {
  service: string;
  container: string;
  image: string;
  /** "healthy", "unhealthy", "starting", or "running"/"exited" for services without a health check. */
  health: string;
  /** "<containerPort>/<proto>" -> host port on 127.0.0.1. */
  ports: Record<string, number>;
  label: EmulationLabel;
}

interface InspectEntry {
  Name: string;
  Config: { Image: string; Labels?: Record<string, string> | null };
  State: { Running: boolean; Status: string; Health?: { Status: string } | null };
  NetworkSettings: { Ports?: Record<string, { HostIp: string; HostPort: string }[] | null> | null };
}

export const COMPOSE_PROJECT = (): string => process.env.VSP_COMPOSE_PROJECT ?? "vsp-local";

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}

export function discoverServices(project = COMPOSE_PROJECT()): Record<string, DiscoveredService> {
  const ids = docker(["ps", "--quiet", "--filter", `label=com.docker.compose.project=${project}`])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (ids.length === 0) return {};
  const entries = JSON.parse(docker(["inspect", ...ids])) as InspectEntry[];
  const services: Record<string, DiscoveredService> = {};
  for (const e of entries) {
    const labels = e.Config.Labels ?? {};
    const service = labels["com.docker.compose.service"];
    if (!service) continue;
    const ports: Record<string, number> = {};
    for (const [containerPort, bindings] of Object.entries(e.NetworkSettings.Ports ?? {})) {
      const host = (bindings ?? []).find((b) => b.HostIp === "127.0.0.1" || b.HostIp === "0.0.0.0" || b.HostIp === "");
      if (host) ports[containerPort] = Number(host.HostPort);
    }
    services[service] = {
      service,
      container: e.Name.replace(/^\//, ""),
      image: e.Config.Image,
      health: e.State.Health?.Status ?? (e.State.Running ? "running" : e.State.Status),
      ports,
      label: {
        service,
        image: e.Config.Image,
        emulates: labels["io.vsp.emulates"] ?? "UNLABELLED",
        protocol: labels["io.vsp.protocol"] ?? "UNLABELLED",
        notEmulated: labels["io.vsp.not-emulated"] ?? "UNLABELLED",
      },
    };
  }
  return services;
}

export const isReady = (s: DiscoveredService): boolean => s.health === "healthy" || s.health === "running";
