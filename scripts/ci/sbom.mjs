#!/usr/bin/env node
// CycloneDX 1.5 JSON SBOM from `pnpm list -r --json --depth Infinity` (spec section 14).
//
//   pnpm list -r --json --depth Infinity > pnpm-list.json
//   pnpm licenses list --json > licenses.json          (optional, adds licenses)
//   node scripts/ci/sbom.mjs --input pnpm-list.json [--licenses licenses.json] --output sbom.cdx.json
//
// Deterministic for a given input: components sorted by bom-ref, serial number
// derived from the content hash, timestamp from SOURCE_DATE_EPOCH when set.
// Components reachable only through devDependencies get scope "excluded".
// No network access, no dependencies beyond Node's standard library.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const TOOL = { name: "vsp-sbom", version: "1.0.0" };

// Common SPDX identifiers emitted as license.id; anything else is emitted as
// license.name (always schema-valid) or as an SPDX expression when it is one.
const SPDX_IDS = new Set([
  "0BSD", "Apache-2.0", "BlueOak-1.0.0", "BSD-2-Clause", "BSD-3-Clause", "CC-BY-3.0", "CC-BY-4.0",
  "CC0-1.0", "ISC", "MIT", "MIT-0", "MPL-2.0", "Python-2.0", "Unlicense", "Zlib", "WTFPL",
  "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later", "GPL-2.0-only",
  "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "AGPL-3.0-only", "AGPL-3.0-or-later",
  "EPL-2.0", "Artistic-2.0", "BSL-1.0", "Unicode-DFS-2016", "Unicode-3.0",
]);

export function purl(name, version) {
  const encoded = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

function splitName(name) {
  if (name.startsWith("@") && name.includes("/")) {
    const i = name.indexOf("/");
    return { group: name.slice(0, i), name: name.slice(i + 1) };
  }
  return { group: undefined, name };
}

export function licenseEntry(raw) {
  if (!raw || typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value === "" || /^unknown$/i.test(value)) return undefined;
  if (SPDX_IDS.has(value)) return [{ license: { id: value } }];
  if (/\s(OR|AND|WITH)\s/.test(value) || value.startsWith("(")) return [{ expression: value }];
  return [{ license: { name: value } }];
}

/** Index of name@version -> license string from `pnpm licenses list --json`. */
export function indexLicenses(licensesJson) {
  const index = new Map();
  if (!licensesJson || typeof licensesJson !== "object") return index;
  for (const [license, packages] of Object.entries(licensesJson)) {
    for (const pkg of packages ?? []) {
      for (const v of pkg.versions ?? []) index.set(`${pkg.name}@${v}`, pkg.license ?? license);
    }
  }
  return index;
}

function isLocal(info) {
  return typeof info?.version === "string" && (info.version.startsWith("link:") || info.version.startsWith("file:"));
}

/**
 * Builds the CycloneDX document.
 * @param {Array<object>} projects  output of `pnpm list -r --json --depth Infinity`
 * @param {{ licenses?: Map<string,string>, timestamp?: string }} options
 */
export function buildSbom(projects, options = {}) {
  if (!Array.isArray(projects) || projects.length === 0) throw new Error("SBOM_INPUT_INVALID: expected the pnpm list -r --json array");
  const licenses = options.licenses ?? new Map();
  const components = new Map();
  const edges = new Map();
  const prodRefs = new Set();

  const ensureComponent = (name, info) => {
    const ref = purl(name, info.version);
    if (!components.has(ref)) {
      const { group, name: short } = splitName(name);
      const component = { type: "library", "bom-ref": ref, name: short, version: info.version, purl: ref };
      if (group) component.group = group;
      const lic = licenseEntry(licenses.get(`${name}@${info.version}`));
      if (lic) component.licenses = lic;
      if (typeof info.resolved === "string" && /^https:\/\//.test(info.resolved)) {
        component.externalReferences = [{ type: "distribution", url: info.resolved }];
      }
      components.set(ref, component);
    }
    return ref;
  };

  const walk = (parentRef, deps, prod, seen) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      if (!info || typeof info.version !== "string" || isLocal(info)) continue;
      const ref = ensureComponent(name, info);
      if (!edges.has(parentRef)) edges.set(parentRef, new Set());
      edges.get(parentRef).add(ref);
      const key = `${ref}|${prod}`;
      if (prod) prodRefs.add(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      walk(ref, info.dependencies, prod, seen);
      walk(ref, info.optionalDependencies, prod, seen);
    }
  };

  const root = projects.find((p) => !p.version) ?? projects[0];
  const rootRef = purl(root.name, root.version ?? "0.0.0-workspace");
  const workspace = [];
  const seen = new Set();
  for (const project of projects) {
    const ref = project === root ? rootRef : purl(project.name, project.version ?? "0.0.0-workspace");
    if (project !== root) {
      workspace.push({ type: "application", "bom-ref": ref, name: project.name, version: project.version ?? "0.0.0-workspace", purl: ref, scope: "required" });
      if (!edges.has(rootRef)) edges.set(rootRef, new Set());
      edges.get(rootRef).add(ref);
    }
    walk(ref, project.dependencies, true, seen);
    walk(ref, project.optionalDependencies, true, seen);
    walk(ref, project.devDependencies, false, seen);
  }

  for (const [ref, c] of components) c.scope = prodRefs.has(ref) ? "required" : "excluded";

  const sortedComponents = [...workspace, ...[...components.values()]].sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));
  const dependencies = [...edges.entries()]
    .map(([ref, set]) => ({ ref, dependsOn: [...set].sort() }))
    .sort((a, b) => a.ref.localeCompare(b.ref));

  const body = {
    metadata: {
      tools: { components: [{ type: "application", name: TOOL.name, version: TOOL.version }] },
      component: { type: "application", "bom-ref": rootRef, name: root.name, version: root.version ?? "0.0.0-workspace" },
      properties: [
        { name: "vsp:sbom:source", value: "pnpm list -r --json --depth Infinity" },
        { name: "vsp:sbom:scope-note", value: "scope=excluded marks components reachable only through devDependencies" },
      ],
    },
    components: sortedComponents,
    dependencies,
  };
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const serial = `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const timestamp = options.timestamp ?? new Date().toISOString();
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: serial,
    version: 1,
    metadata: { timestamp, ...body.metadata },
    components: body.components,
    dependencies: body.dependencies,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k?.startsWith("--")) throw new Error(`unexpected argument ${k}`);
    args[k.slice(2)] = argv[i + 1];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output) {
    process.stderr.write("usage: sbom.mjs --input pnpm-list.json [--licenses licenses.json] --output sbom.cdx.json\n");
    process.exit(2);
  }
  const projects = JSON.parse(readFileSync(args.input, "utf8"));
  const licenses = args.licenses ? indexLicenses(JSON.parse(readFileSync(args.licenses, "utf8"))) : new Map();
  const epoch = process.env.SOURCE_DATE_EPOCH;
  const timestamp = epoch && /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000).toISOString() : undefined;
  const sbom = buildSbom(projects, { licenses, timestamp });
  writeFileSync(args.output, `${JSON.stringify(sbom, null, 2)}\n`);
  const excluded = sbom.components.filter((c) => c.scope === "excluded").length;
  const unlicensed = sbom.components.filter((c) => c.type === "library" && !c.licenses).length;
  process.stdout.write(
    `sbom: CycloneDX ${sbom.specVersion} ${sbom.components.length} components (${excluded} dev-only) ${unlicensed} without license data -> ${args.output}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
