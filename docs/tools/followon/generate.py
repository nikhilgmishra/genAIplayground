#!/usr/bin/env python3
"""Generate and drift-check the follow-on ledger, plan and registers from their committed sources.

Sources (edit these):
  docs/followon/source/requirements/sNN.yaml  one record per requirement: text, acceptance, both status axes,
                                              qualification, evidence, gap, remediation, work package, capabilities
  docs/followon/source/packages.yaml          work packages, shared groups, ownership rules
  docs/followon/source/activations.yaml       activation register entries (AIN-NN)
  docs/followon/source/capabilities.yaml      capability catalogue
  docs/followon/source/narrative.yaml         metadata and the prose of docs/GAP_CLOSURE.md
  plus docs/requirements/catalog.yaml, docs/prerequisites.yaml and scenarios/fixtures/failures/*.json (read only)
  plus the working tree's file list (git ls-files --cached --others --exclude-standard; a directory walk when git is
  unavailable) and the relative imports of its TypeScript/JavaScript sources, for the file-ownership checks only: they
  validate, they never change an output

Outputs (never edit by hand):
  docs/followon/requirements.yaml, gap-ledger.yaml, work-packages.yaml, activation-register.yaml, capabilities.yaml,
  docs/GAP_CLOSURE.md, docs/ACTIVATION_REGISTER.md

Usage:
  python3 -I docs/tools/followon/generate.py           validate the sources and write the outputs
  python3 -I docs/tools/followon/generate.py --check   validate and fail (exit 1) when an output differs from the sources
  python3 -I docs/tools/followon/generate.py --out D   write the outputs under directory D instead of the repository

Exit codes: 0 ok, 1 drift (--check), 2 source validation failed (both modes validate, so every check below is part of --check).
Requires Python 3.10+ and PyYAML; reads no network and no environment variables; runs only `git ls-files`.

File-ownership checks over the working tree's files (ownershipRules in packages.yaml):
  * derived ownership: the owner of a source file D/Y.<ext> owns D/Y.test.<ext> and D/Y.<suffix>.test.<ext> (longest source
    wins); the owner of a directory-level pattern D/*.<ext> owns D/README.md;
  * no tracked file is owned by two packages that can run in parallel (file-level, after derived ownership);
  * every file has an owner unless unownedByDesign lists it, and no unownedByDesign path has an owner;
  * timely ownership: a source-tree file cited by a MISSING/IMPLEMENTED row of a phase B-F package (evidence, gap,
    remediation, acceptance) or by such a package's deliverables, acceptance or notes, a file imported by a source whose
    first owner is in phase B-F, and a file that imports such a source, has an owner before phase G (a first owner in phase
    G would leave a defect found in it during phases B-F without an owner).
"""
import argparse
import collections
import functools
import itertools
import json
import os
import re
import subprocess
import sys

import yaml

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
SRC = os.path.join(REPO, 'docs', 'followon', 'source')
OUTPUTS = ['docs/followon/requirements.yaml', 'docs/followon/gap-ledger.yaml', 'docs/followon/work-packages.yaml',
           'docs/followon/activation-register.yaml', 'docs/followon/capabilities.yaml', 'docs/GAP_CLOSURE.md',
           'docs/ACTIVATION_REGISTER.md']
GENERATOR = 'docs/tools/followon/generate.py'

SOFTWARE = ['MISSING', 'IMPLEMENTED', 'VERIFIED_LOCAL', 'RELEASE_PACKAGE_VERIFIED']  # prompt section 0; no fifth value (ADR-0018 decision 7.1)
ENVIRONMENT = ['NOT_CONFIGURED', 'CONFIGURED', 'VERIFIED_SANDBOX', 'APPROVED_PILOT', 'VERIFIED_PRODUCTION']
QUALIFICATION = ['NOT_RUN', 'FAIL', 'INCONCLUSIVE', 'PASS']
PHASES = 'BCDEFGH'
# Status vocabulary of docs/prerequisites.yaml records, most severe first (a prerequisite state, not a software status).
PRQ_SEVERITY = ['BLOCKED', 'EXPIRED', 'UNKNOWN', 'REQUESTED', 'IN_PROGRESS', 'EVIDENCED', 'APPROVED', 'NOT_APPLICABLE']
ID_RE = re.compile(r'^FO-\d{2}-\d{2,3}(a|\.[A-Z][A-Z0-9_]+)?$')
JOURNEY_TEXT = re.compile(r'^J\d{2}\b')  # a section 20 row whose text starts with its journey id is a journey row
DERIVED_RE = re.compile(r'^(ADR-\d{4}|TB-\d{2}|FOLLOWON-\d+( \(.+\))?|ORIGINAL-SPEC-\d+( \(.+\))?)$')
ERRORS = []


def fail(msg):
    ERRORS.append(msg)


def natkey(s):
    return [int(t) if t.isdigit() else t for t in re.split(r'(\d+)', s)]


def load_yaml(path):
    with open(path, encoding='utf-8') as fh:
        return yaml.safe_load(fh)


# ====================================================================== load
def load():
    reqs = []
    rdir = os.path.join(SRC, 'requirements')
    for name in sorted(os.listdir(rdir)):
        if not name.endswith('.yaml'):
            continue
        doc = load_yaml(os.path.join(rdir, name))
        for r in doc['requirements']:
            if r.get('section') != doc['section']:
                fail(f'{name}: {r.get("id")} has section {r.get("section")!r}, file is section {doc["section"]!r}')
            reqs.append(r)
    pk = load_yaml(os.path.join(SRC, 'packages.yaml'))
    acts = load_yaml(os.path.join(SRC, 'activations.yaml'))
    caps = load_yaml(os.path.join(SRC, 'capabilities.yaml'))['capabilities']
    narr = load_yaml(os.path.join(SRC, 'narrative.yaml'))
    catalog = load_yaml(os.path.join(REPO, 'docs', 'requirements', 'catalog.yaml'))
    prereq = load_yaml(os.path.join(REPO, 'docs', 'prerequisites.yaml'))
    plans = {}
    fdir = os.path.join(REPO, 'scenarios', 'fixtures', 'failures')
    for name in sorted(os.listdir(fdir)):
        if name.endswith('.json'):
            with open(os.path.join(fdir, name), encoding='utf-8') as fh:
                d = json.load(fh)
            plans[d['faultId']] = d
    return reqs, pk, acts, caps, narr, catalog, prereq, plans


WALK_SKIP = {'.git', 'node_modules', 'dist', 'coverage', '__pycache__', '.turbo', '.vite', '.terraform'}


def working_tree_files():
    """Repository-relative paths of the working tree's files: tracked plus untracked files that are not ignored."""
    try:
        res = subprocess.run(['git', '-C', REPO, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
                             capture_output=True, check=True, timeout=60)
        names = res.stdout.decode('utf-8').split('\0')
    except (OSError, subprocess.SubprocessError, UnicodeDecodeError):
        names = []
        for root, dirs, fnames in os.walk(REPO):
            dirs[:] = [d for d in dirs if d not in WALK_SKIP]
            for n in fnames:
                names.append(os.path.relpath(os.path.join(root, n), REPO).replace(os.sep, '/'))
    return sorted({n for n in names if n and os.path.isfile(os.path.join(REPO, n))})


# ====================================================================== globs and ownership
@functools.lru_cache(maxsize=None)
def glob_re(p):
    p = p.rstrip('/')
    out, i = '', 0
    while i < len(p):
        if p.startswith('**', i):
            out += '.*'
            i += 2
        elif p[i] == '*':
            out += '[^/]*'
            i += 1
        elif p[i] == '?':
            out += '[^/]'
            i += 1
        elif p[i] == '[':
            j = p.index(']', i)
            body = p[i + 1:j]
            if body.startswith('!'):
                body = '^' + body[1:]
            out += '[' + body + ']'
            i = j + 1
        else:
            out += re.escape(p[i])
            i += 1
    return re.compile(out + r'\Z')


def sample(p):
    p = p.rstrip('/')
    p = re.sub(r'\[!?([^\]])[^\]]*\]', lambda m: m.group(1), p)
    return p.replace('**', 'x/x').replace('*', 'x').replace('?', 'x')


WILD = re.compile(r'[*?\[]')


def overlaps(a, b):
    a, b = a.rstrip('/'), b.rstrip('/')
    if a == b:
        return True
    if glob_re(b).match(sample(a)) or glob_re(a).match(sample(b)):
        return True

    def root(x):
        m = WILD.search(x)
        return x if not m else x[:m.start()]
    if a.endswith('/**') and root(b).startswith(a[:-3] + '/'):
        return True
    if b.endswith('/**') and root(a).startswith(b[:-3] + '/'):
        return True
    return False


def covered(pattern, excludes):
    s = sample(pattern)
    return any(pattern.rstrip('/') == e.rstrip('/') or glob_re(e).match(s) for e in excludes)


# ====================================================================== file-level ownership (working tree)
SRC_EXT = ('ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs')
TEST_FILE = re.compile(r'^(?P<dir>(?:.*/)?)(?P<stem>[^/]+?)\.test\.(?:[cm]?[jt]sx?)$')
DIR_PATTERN_BASES = tuple('*.' + e for e in SRC_EXT)
# Trees whose files the timely-ownership check follows (citations and imports); docs, infra and scripts are cited as
# context far more often than they are edited, and their owners are listed explicitly.
CHECK_ROOTS = ('platform/src/', 'platform/test/', 'console/src/', 'console/e2e/', 'media/src/', 'media/test/', 'companion/src/', 'sidecars/')
SERVICES_SRC = re.compile(r'^services/[^/]+/src/')
PATH_TOKEN = re.compile(r'(?<![\w./-])((?:platform|console|media|companion|services|sidecars)/[A-Za-z0-9_./\-]+)')
IMPORT_SPEC = re.compile(r'''(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](\.{1,2}/[^"']+)["']''')


def in_check_roots(f):
    return f.startswith(CHECK_ROOTS) or bool(SERVICES_SRC.match(f))


def resolve_owners(files, eff):
    """Explicit owners per file (owns + ownsGroups minus excludes) plus the derived co-located test and README owners."""
    def literal_prefix(a):
        mm = WILD.search(a)
        return a if not mm else a[:mm.start()]
    compiled = {pid: [(literal_prefix(a.rstrip('/')), glob_re(a), [glob_re(e) for e in ex]) for a, ex in ents] for pid, ents in eff.items()}
    explicit = {}
    for f in files:
        explicit[f] = {pid for pid, ents in compiled.items()
                       if any(f.startswith(pre) and rx.match(f) and not any(e.match(f) for e in exs) for pre, rx, exs in ents)}
    owners = {f: set(o) for f, o in explicit.items()}
    fileset = set(files)
    derived = collections.defaultdict(set)
    for f in files:
        mm = TEST_FILE.match(f)
        if not mm:
            continue
        parts = mm['stem'].split('.')
        for i in range(len(parts), 0, -1):
            src = next((c for c in (mm['dir'] + '.'.join(parts[:i]) + '.' + e for e in SRC_EXT) if c in fileset and c != f), None)
            if src:
                derived[f] |= explicit[src] - owners[f]
                owners[f] |= explicit[src]
                break
    for pid, ents in eff.items():
        for a, ex in ents:
            d, _, base = a.rstrip('/').rpartition('/')
            readme = d + '/README.md'
            if base in DIR_PATTERN_BASES and not WILD.search(d) and readme in fileset and not covered(readme, ex) and pid not in owners[readme]:
                owners[readme].add(pid)
                derived[readme].add(pid)
    return explicit, owners, derived


def relative_imports(path):
    try:
        with open(os.path.join(REPO, path), encoding='utf-8') as fh:
            text = fh.read()
    except (OSError, UnicodeDecodeError):
        return []
    out = []
    for mm in IMPORT_SPEC.finditer(text):
        base = os.path.normpath(os.path.join(os.path.dirname(path), mm.group(1))).replace(os.sep, '/')
        stem = re.sub(r'\.(?:[cm]?js|jsx)$', '', base)
        out.append([base] + [stem + '.' + e for e in SRC_EXT] + [base + '/index.' + e for e in ('ts', 'tsx', 'js')])
    return out


def cited_files(strings, fileset):
    out = set()
    for s in strings:
        for mm in PATH_TOKEN.finditer(str(s)):
            t = mm.group(1).rstrip('.,;-')
            if t in fileset:
                out.add(t)
    return out


# ====================================================================== validation + derivation
def build(reqs, pk, acts, caps, narr, catalog, prereq, plans, files):
    meta = narr['meta']
    titles = narr['sectionTitles']
    RID = {}
    for r in reqs:
        rid = r.get('id', '?')
        if rid in RID:
            fail(f'duplicate requirement id {rid}')
        RID[rid] = r
        if not ID_RE.match(rid):
            fail(f'{rid}: id does not match {ID_RE.pattern}')
        if r['section'] not in titles:
            fail(f'{rid}: unknown section {r["section"]}')
        for k in ('text', 'acceptance', 'kind', 'evidence', 'gap', 'remediation', 'size', 'environmentDependency', 'capabilityIds', 'originalIds'):
            if k not in r:
                fail(f'{rid}: missing field {k}')
    pkgs = pk['packages']
    PKG = {p['id']: p for p in pkgs}
    cat_ids = [c['id'] for c in catalog['requirements']]
    cat_set = set(cat_ids)
    invariants = [c['id'] for c in catalog['requirements'] if c.get('kind') == 'invariant']
    CAP = {c['id']: c for c in caps}

    # ---- per requirement
    for r in reqs:
        rid = r['id']
        st = r.get('softwareStatus')
        if st not in SOFTWARE:
            fail(f'{rid}: software status {st!r} outside {SOFTWARE}')
        if r.get('environmentStatus') not in ENVIRONMENT:
            fail(f'{rid}: environment status {r.get("environmentStatus")!r} outside {ENVIRONMENT}')
        q = r.get('qualification')
        if q not in QUALIFICATION:
            fail(f'{rid}: qualification {q!r} outside {QUALIFICATION}')
        if q != 'NOT_RUN' and not r.get('qualificationEvidence'):
            fail(f'{rid}: qualification {q} without qualificationEvidence')
        if q == 'NOT_RUN' and r.get('qualificationEvidence'):
            fail(f'{rid}: qualificationEvidence on a NOT_RUN row')
        if st in ('MISSING', 'IMPLEMENTED'):
            if r.get('workPackage') not in PKG:
                fail(f'{rid}: {st} needs an existing workPackage (got {r.get("workPackage")!r})')
            if 'regressionPackage' in r:
                fail(f'{rid}: {st} row must not carry regressionPackage')
        elif st in ('VERIFIED_LOCAL', 'RELEASE_PACKAGE_VERIFIED'):
            if r.get('regressionPackage') not in PKG:
                fail(f'{rid}: {st} needs an existing regressionPackage')
            if 'workPackage' in r:
                fail(f'{rid}: {st} row must not carry workPackage')
        if 'notApplicableReason' in r:
            fail(f'{rid}: notApplicableReason is retired; a constraint whose trigger has not occurred is IMPLEMENTED with a "not yet triggered" gap')
        if not isinstance(r.get('evidence'), list) or not all(isinstance(e, str) and e for e in r['evidence']):
            fail(f'{rid}: evidence must be a list of non-empty strings')
        elif not r['evidence'] and st != 'MISSING':
            fail(f'{rid}: a {st} row needs evidence (only MISSING rows may cite none)')
        for o in r.get('originalIds') or []:
            if o not in cat_set:
                fail(f'{rid}: originalId {o} is not in docs/requirements/catalog.yaml (move it to derivedFrom)')
        for d in r.get('derivedFrom') or []:
            if not DERIVED_RE.match(d):
                fail(f'{rid}: derivedFrom {d!r} is not an ADR, TB, FOLLOWON or ORIGINAL-SPEC reference')
        if not r.get('capabilityIds'):
            fail(f'{rid}: no capabilityIds')
        for c in r.get('capabilityIds') or []:
            if c not in CAP:
                fail(f'{rid}: unknown capability {c}')
        for x in r.get('relatedIds') or []:
            if x not in RID:
                fail(f'{rid}: relatedIds names unknown {x}')
        for x in r.get('secondaryPackages') or []:
            if x not in PKG:
                fail(f'{rid}: secondaryPackages names unknown {x}')
    covered_cat = {o for r in reqs for o in r.get('originalIds') or []}
    for c in cat_ids:
        if c not in covered_cat:
            fail(f'catalog id {c} is not mapped from any FO requirement')
    inv_rows = {}
    for n in range(1, len(invariants) + 1):
        rid = f'FO-02-{n:02d}'
        r = RID.get(rid)
        if not r:
            fail(f'{rid}: invariant row missing')
            continue
        if not r.get('secondaryPackages'):
            fail(f'{rid}: invariant row without secondaryPackages')
        inv = [o for o in r['originalIds'] if o in invariants]
        if len(inv) != 1:
            fail(f'{rid}: expected exactly one invariant originalId, got {inv}')
        else:
            inv_rows[rid] = inv[0]
    if sorted(inv_rows.values()) != sorted(invariants):
        fail('FO-02-01..27 do not map one-to-one onto the 27 catalog invariants')
    for c in CAP:
        if not any(c in r['capabilityIds'] for r in reqs):
            fail(f'capability {c} has no member requirement')

    # ---- fault matrix
    fault_rows = {rid.split('.', 1)[1]: r for rid, r in RID.items() if rid.startswith('FO-17-24.')}
    for fid in plans:
        if fid not in fault_rows:
            fail(f'fault plan {fid} (scenarios/fixtures/failures) has no FO-17-24.{fid} requirement')
    for fid, r in fault_rows.items():
        src = r.get('faultSource')
        if fid in plans and not str(src).startswith('registry'):
            fail(f'FO-17-24.{fid}: has a plan but faultSource is {src!r}')
        if fid not in plans and src != 'prompt section 17':
            fail(f'FO-17-24.{fid}: no plan, so faultSource must be "prompt section 17"')

    # ---- packages
    for p in pkgs:
        if p['phase'] not in PHASES:
            fail(f'{p["id"]}: unknown phase {p["phase"]}')
        for d in p['dependsOn']:
            if d not in PKG:
                fail(f'{p["id"]}: unknown dependency {d}')
    if ERRORS:
        return None
    ph = {p['id']: PHASES.index(p['phase']) for p in pkgs}
    anc = {}

    def ancestors(pid, stack=()):
        if pid in anc:
            return anc[pid]
        if pid in stack:
            fail('dependency cycle: ' + ' -> '.join(stack + (pid,)))
            return set()
        s = set()
        for d in PKG[pid]['dependsOn']:
            s.add(d)
            s |= ancestors(d, stack + (pid,))
        anc[pid] = s
        return s

    for p in pkgs:
        ancestors(p['id'])
    # ---- fault matrix ownership: the owner of a FO-17-24.<FAULT_ID> row runs its Layer-2 [FAULT:] test, so it must be (or depend on) every package
    # that builds the injection point and every package whose component the asserted postconditions observe (no dependency inversion).
    for rid, r in RID.items():
        is_fault = rid.startswith('FO-17-24.')
        for k in ('injectionPointPackages', 'postconditionPackages'):
            v = r.get(k)
            if not is_fault:
                if v is not None:
                    fail(f'{rid}: {k} is only for FO-17-24.<FAULT_ID> rows')
                continue
            if not isinstance(v, list) or not v:
                fail(f'{rid}: fault row needs a non-empty {k} list')
                continue
            owner = r.get('workPackage') or r.get('regressionPackage')
            for x in v:
                if x not in PKG:
                    fail(f'{rid}: {k} names unknown package {x}')
                elif owner in PKG and x != owner and x not in anc[owner]:
                    fail(f'{rid}: {k} names {x}, but the owning package {owner} neither is nor depends on it (dependency inversion)')
    # ---- journey ownership: the owner of a journey row (J01-J20 and their split legs) runs the journey, so it must be (or depend on)
    # every package that builds a component the journey's acceptance exercises or asserts (componentPackages; no dependency inversion).
    for rid, r in RID.items():
        v = r.get('componentPackages')
        journey = r['section'] == '20' and bool(JOURNEY_TEXT.match(r.get('text', '')))
        if v is None:
            if journey:
                fail(f'{rid}: journey row needs a non-empty componentPackages list')
            continue
        if r['section'] != '20':
            fail(f'{rid}: componentPackages is only for section 20 journey rows')
            continue
        if not isinstance(v, list) or not v:
            fail(f'{rid}: componentPackages must be a non-empty list')
            continue
        owner = r.get('workPackage') or r.get('regressionPackage')
        for x in v:
            if x not in PKG:
                fail(f'{rid}: componentPackages names unknown package {x}')
            elif owner in PKG and x != owner and x not in anc[owner]:
                fail(f'{rid}: componentPackages names {x}, but the owning package {owner} neither is nor depends on it (dependency inversion)')
    for p in pkgs:
        for d in p['dependsOn']:
            dp = PKG[d]
            if ph[d] > ph[p['id']]:
                if not dp.get('earlyStart'):
                    fail(f'{p["id"]} depends on later {d} that is not marked earlyStart')
                elif any(ph[x] > ph[p['id']] for x in dp['dependsOn']):
                    fail(f'{p["id"]} depends on early-start {d}, whose own dependencies are in later phases')
    wave = {}

    def wv(pid):
        if pid not in wave:
            wave[pid] = 1 + max([wv(d) for d in PKG[pid]['dependsOn']], default=0)
        return wave[pid]

    for p in pkgs:
        wv(p['id'])

    groups = pk['sharedGroups']
    G = {g['group']: g for g in groups}
    for g in groups:
        for phase, owners in g['ownerByPhase'].items():
            owners = owners if isinstance(owners, list) else [owners]
            for o in owners:
                if o not in PKG:
                    fail(f'shared group {g["group"]}: unknown owner {o}')
                    continue
                if PKG[o]['phase'] != phase:
                    fail(f'shared group {g["group"]}: owner {o} listed for phase {phase} is a phase {PKG[o]["phase"]} package')
                if g['group'] not in PKG[o].get('ownsGroups', []):
                    fail(f'shared group {g["group"]}: owner {o} does not list it in ownsGroups')
            for a, b in zip(owners, owners[1:]):
                if a not in anc.get(b, set()):
                    fail(f'shared group {g["group"]} phase {phase}: {b} must depend on {a} (ordered owners)')
    for p in pkgs:
        for gname in p.get('ownsGroups', []):
            if gname not in G:
                fail(f'{p["id"]}: unknown shared group {gname}')
                continue
            owners = G[gname]['ownerByPhase'].get(p['phase'])
            owners = owners if isinstance(owners, list) else ([owners] if owners else [])
            if p['id'] not in owners:
                fail(f'{p["id"]}: lists group {gname} but is not its phase {p["phase"]} owner')

    def entries(p):
        out = [(a, list(p.get('excludes', []))) for a in p['owns']]
        for gname in p.get('ownsGroups', []):
            g = G[gname]
            for a in g['files']:
                out.append((a, list(p.get('excludes', [])) + list(g.get('excludes', []))))
        return out

    DERIVED = ('schemas/protocol/',)
    eff = {p['id']: entries(p) for p in pkgs}
    for i, p in enumerate(pkgs):
        for q in pkgs[i + 1:]:
            if p['id'] in anc[q['id']] or q['id'] in anc[p['id']]:
                continue
            for a, ea in eff[p['id']]:
                if a.startswith(DERIVED) or covered(a, ea):
                    continue
                for b, eb in eff[q['id']]:
                    if b.startswith(DERIVED) or covered(b, eb):
                        continue
                    if covered(b, ea) or covered(a, eb):
                        continue
                    if overlaps(a, b):
                        fail(f'ownership conflict between parallel packages: {p["id"]} {a} <-> {q["id"]} {b}')

    # ---- file-level ownership over the working tree (derived co-located ownership, no parallel co-owners, no unowned file,
    # no file needed before its first owner)
    explicit, owners, derived = resolve_owners(files, eff)
    fileset = set(files)
    parallel = lambda a, b: a not in anc[b] and b not in anc[a]  # noqa: E731
    for f in files:
        if f.startswith(DERIVED):
            continue
        for a, b in itertools.combinations(sorted(owners[f], key=natkey), 2):
            if parallel(a, b):
                fail(f'ownership conflict between parallel packages on {f}: {a} and {b}' + (' (derived co-located ownership)' if f in derived else ''))
    by_design = [(glob_re(u['path']), u) for u in pk.get('unownedByDesign', [])]
    for u in pk.get('unownedByDesign', []):
        if not u.get('reason'):
            fail(f'unownedByDesign {u.get("path")!r} needs a reason')
    for f in files:
        listed = [u['path'] for rx, u in by_design if rx.match(f)]
        if owners[f] and listed:
            fail(f'{f} is listed in unownedByDesign ({listed[0]}) but owned by {", ".join(sorted(owners[f], key=natkey))}')
        elif not owners[f] and not listed:
            fail(f'{f} has no owner: add it to a package, a shared group or unownedByDesign (with a reason)')
    first = {f: min(ph[x] for x in o) for f, o in owners.items() if o}
    G_IDX = PHASES.index('G')

    # A file a phase B-F package needs must not wait for phase G: a module owned from its feature phase onwards is the plan's
    # phasing (earlier rows cite it as context), but a file whose first owner is a phase G package cannot be fixed by anyone
    # before closure, so a defect found in it during phases B-F would have no owner.
    def need(f, by_phase, who):
        if not in_check_roots(f):
            return
        if f not in first or first[f] >= G_IDX:
            got = f'first owned in phase {PHASES[first[f]]} by {", ".join(sorted((x for x in owners[f] if ph[x] == first[f]), key=natkey))}' if f in first else 'unowned'
            fail(f'{who} needs {f} in phase {PHASES[by_phase]}, but it is {got}: give it an owner before phase G (timely ownership)')

    for r in reqs:
        if r['softwareStatus'] not in ('MISSING', 'IMPLEMENTED') or ph[r['workPackage']] >= G_IDX:
            continue
        for f in sorted(cited_files(list(r['evidence']) + [r['gap'], r['remediation'], r['acceptance']], fileset)):
            need(f, ph[r['workPackage']], f'{r["id"]} ({r["workPackage"]})')
    for p in pkgs:
        if ph[p['id']] >= G_IDX:
            continue
        for f in sorted(cited_files(p['deliverables'] + p['acceptance'] + p.get('notes', []), fileset)):
            need(f, ph[p['id']], f'{p["id"]} deliverables/acceptance')
    for g in files:
        if g.rsplit('.', 1)[-1] not in SRC_EXT or not in_check_roots(g):
            continue
        late = first.get(g, G_IDX) >= G_IDX
        for cands in relative_imports(g):
            hit = next((c for c in cands if c in fileset), None)
            if not hit:
                continue
            if not late:
                need(hit, first[g], f'{g} (imports it; first owned in phase {PHASES[first[g]]})')
            elif hit in first and first[hit] < G_IDX:
                # the reverse direction: a phase B-F change to the imported file can break this file (typecheck, default suites),
                # and nobody could repair it before phase G
                got = f'first owned in phase {PHASES[first[g]]} by {", ".join(sorted((x for x in owners[g] if ph[x] == first[g]), key=natkey))}' if g in first else 'unowned'
                fail(f'{g} imports {hit} (first owned in phase {PHASES[first[hit]]}), so a change there can break it, but {g} is {got}: '
                     'give it an owner before phase G (timely ownership)')

    # ---- membership
    member = {p['id']: {'requirementIds': [], 'regressionIds': []} for p in pkgs}
    for r in reqs:
        if r['softwareStatus'] in ('MISSING', 'IMPLEMENTED'):
            member[r['workPackage']]['requirementIds'].append(r['id'])
        elif r['softwareStatus'] in ('VERIFIED_LOCAL', 'RELEASE_PACKAGE_VERIFIED'):
            member[r['regressionPackage']]['regressionIds'].append(r['id'])
    obligations = collections.defaultdict(list)
    for rid, inv in inv_rows.items():
        for x in RID[rid]['secondaryPackages']:
            obligations[x].append(inv)
    fault_of = collections.defaultdict(list)
    fault_inj = collections.defaultdict(list)
    for fid, r in fault_rows.items():
        owner = r.get('workPackage') or r.get('regressionPackage')
        if r['softwareStatus'] in ('MISSING', 'IMPLEMENTED'):
            fault_of[r['workPackage']].append(fid)
        for x in r['injectionPointPackages']:
            if x != owner:
                fault_inj[x].append((fid, owner))

    # ---- activation
    PRQ = {x['id']: x for x in prereq['records']}
    act = acts['entries']
    covered_prq = set()
    for i, a in enumerate(act, 1):
        if a['id'] != f'AIN-{i:02d}':
            fail(f'activation ids must be AIN-01.. in order; got {a["id"]} at position {i}')
        for x in a['prq'] + a.get('relatedPrq', []):
            if x not in PRQ:
                fail(f'{a["id"]}: unknown prerequisite {x}')
        if bool(a.get('proposed')) != (not a['prq']):
            fail(f'{a["id"]}: proposed must be true exactly when no PRQ record is mapped')
        for w in a['workPackages']:
            if w not in PKG:
                fail(f'{a["id"]}: unknown work package {w}')
        for x in a.get('extraIds', []):
            if x not in RID:
                fail(f'{a["id"]}: extraIds names unknown requirement {x}')
        covered_prq.update(a['prq'])
    if ERRORS:
        return None
    blocking = {}
    hits = {}
    for a in act:
        ids = set(a.get('extraIds', []))
        rx = [re.compile(x) for x in a['patterns']]
        for r in reqs:
            ed = (r.get('environmentDependency') or '').strip()
            low = ed.lower()
            if (low in ('none', '') or low.startswith('none (')) and not re.search(r'PRQ-\d{3}', ed):
                continue
            if any(x.search(ed) for x in rx):
                ids.add(r['id'])
        blocking[a['id']] = sorted(ids, key=natkey)
        hits[a['id']] = len(ids)
        states = [PRQ[x]['status'] for x in a['prq']]
        if states:
            a['_state'] = sorted(states, key=PRQ_SEVERITY.index)[0]
            a['_stateSource'] = 'docs/prerequisites.yaml (' + ', '.join(f'{x}={PRQ[x]["status"]}' for x in a['prq']) + ')'
        else:
            a['_state'] = 'UNKNOWN'
            a['_stateSource'] = 'proposed: no record in docs/prerequisites.yaml; a proposed addition to the prerequisite register, not requested or approved'
    act_by_req = collections.defaultdict(list)
    for a in act:
        for rid in blocking[a['id']]:
            act_by_req[rid].append(a['id'])
    for r in reqs:
        ed = (r.get('environmentDependency') or 'none').strip()
        if not re.match(r'^none\b', ed, re.I) and r['id'] not in act_by_req:
            fail(f'{r["id"]}: environment dependency {ed[:80]!r} maps to no activation entry')
    for a in act:
        if not blocking[a['id']]:
            fail(f'{a["id"]}: blocks no requirement (add a pattern or extraIds)')
    act_ids = {a['id'] for a in act}
    for p in pkgs:
        for s in p['externalActivation']:
            for m in re.findall(r'\b(ACT-\d{2}|AIN-\d{2})\b', s):
                if m.startswith('ACT-'):
                    fail(f'{p["id"]}: externalActivation uses the retired activation prefix {m}')
                elif m not in act_ids:
                    fail(f'{p["id"]}: externalActivation names unknown {m}')
    uncovered_prq = sorted(set(PRQ) - covered_prq)
    if uncovered_prq:
        fail('prerequisite records mapped to no activation entry: ' + ', '.join(uncovered_prq))
    if ERRORS:
        return None
    return dict(meta=meta, titles=titles, reqs=reqs, RID=RID, pk=pk, pkgs=pkgs, PKG=PKG, G=G, wave=wave, anc=anc,
                member=member, obligations=obligations, fault_of=fault_of, fault_inj=fault_inj, act=act, blocking=blocking, act_by_req=act_by_req,
                PRQ=PRQ, covered_prq=covered_prq, caps=caps, CAP=CAP, narr=narr, plans=plans, fault_rows=fault_rows,
                cat_ids=cat_ids, invariants=invariants)


# ====================================================================== rendering helpers
class Dumper(yaml.SafeDumper):
    pass


def _str(d, s):
    if '\n' in s:
        return d.represent_scalar('tag:yaml.org,2002:str', s, style='|')
    return d.represent_scalar('tag:yaml.org,2002:str', s)


Dumper.add_representer(str, _str)


def dump(obj):
    return yaml.dump(obj, Dumper=Dumper, sort_keys=False, allow_unicode=True, width=4096, default_flow_style=False)


def md_cell(s, limit=None):
    s = ' '.join(str(s).split())
    if limit and len(s) > limit:
        s = s[:limit].rsplit(' ', 1)[0] + ' ...'
    return s.replace('|', '\\|')


def rollup(statuses, order):
    return min(statuses, key=order.index)


# ====================================================================== render
def render(m):
    meta, reqs, RID, pkgs = m['meta'], m['reqs'], m['RID'], m['pkgs']
    head = meta['baseCommit']
    as_of = meta['asOf']
    out = {}
    status_counts = collections.Counter(r['softwareStatus'] for r in reqs)
    env_counts = collections.Counter(r['environmentStatus'] for r in reqs)
    qual_counts = collections.Counter(r['qualification'] for r in reqs)
    origin_counts = collections.Counter(r['provenance'].get('origin', 'extraction') for r in reqs)
    repair_moves = collections.Counter((r['provenance']['repairStatusFrom'], r['softwareStatus']) for r in reqs if r['provenance'].get('repairStatusFrom'))

    # ---------------- requirements.yaml
    req_rows = []
    for r in reqs:
        x = {'id': r['id'], 'section': r['section']}
        if r.get('subsection'):
            x['subsection'] = r['subsection']
        x.update({'text': r['text'], 'kind': r['kind'], 'originalIds': r.get('originalIds') or []})
        if r.get('derivedFrom'):
            x['derivedFrom'] = r['derivedFrom']
        x['capabilityIds'] = r['capabilityIds']
        if r.get('relatedIds'):
            x['relatedIds'] = r['relatedIds']
        x['acceptance'] = r['acceptance']
        req_rows.append(x)
    req_doc = {
        'schemaVersion': 'vsp.followon.requirements.v2', 'asOf': as_of, 'source': 'docs/spec/voice-support-followon-specification.txt',
        'baseCommit': head, 'generator': GENERATOR, 'method': meta['method'],
        'idScheme': ('FO-<section>-<nn>; a split row adds a suffix "a" (FO-16-44a); fault-matrix rows are FO-17-24.<FAULT_ID>. originalIds are ids of '
                     'docs/requirements/catalog.yaml only; derivedFrom holds ADR, TB and follow-on prompt section references. capabilityIds name '
                     'docs/followon/capabilities.yaml entries.'),
        'sections': {k: v for k, v in sorted(m['titles'].items(), key=lambda kv: int(kv[0]))},
        'kinds': sorted({r['kind'] for r in reqs}), 'count': len(reqs), 'requirements': req_rows,
    }
    out['docs/followon/requirements.yaml'] = ('# Follow-on requirement extraction (machine-readable). Human rendering: docs/GAP_CLOSURE.md.\n'
                                              f'# GENERATED by {GENERATOR} from docs/followon/source/; do not edit by hand.\n') + dump(req_doc)

    # ---------------- gap-ledger.yaml
    entries = []
    for r in reqs:
        e = {'id': r['id'], 'softwareStatus': r['softwareStatus'], 'environmentStatus': r['environmentStatus'], 'qualification': r['qualification']}
        if r.get('qualificationEvidence'):
            e['qualificationEvidence'] = r['qualificationEvidence']
        e['capabilityIds'] = r['capabilityIds']
        e['evidence'] = r['evidence']
        e['gap'] = r['gap']
        e['remediation'] = r['remediation']
        e['size'] = r['size']
        e['environmentDependency'] = r['environmentDependency']
        e['activation'] = m['act_by_req'].get(r['id'], [])
        e['workPackage'] = r.get('workPackage')
        if 'regressionPackage' in r:
            e['regressionPackage'] = r['regressionPackage']
        if r.get('secondaryPackages'):
            e['secondaryPackages'] = r['secondaryPackages']
        if r.get('faultSource'):
            e['faultSource'] = r['faultSource']
        if r.get('injectionPointPackages'):
            e['injectionPointPackages'] = r['injectionPointPackages']
            e['postconditionPackages'] = r['postconditionPackages']
        if r.get('componentPackages'):
            e['componentPackages'] = r['componentPackages']
        e['provenance'] = r['provenance']
        entries.append(e)
    ledger_doc = {
        'schemaVersion': 'vsp.followon.gap-ledger.v2', 'asOf': as_of, 'baseCommit': head, 'generator': GENERATOR,
        'requirementsFile': 'docs/followon/requirements.yaml', 'workPackagesFile': 'docs/followon/work-packages.yaml',
        'activationRegisterFile': 'docs/followon/activation-register.yaml', 'capabilitiesFile': 'docs/followon/capabilities.yaml',
        'statusRules': {
            'softwareStatus': {
                'MISSING': 'No real code for the production path. An interface plus a mock, a fixture-only adapter, a NotImplemented/refusal in non-local composition, canned success, TEST ids, an empty history or a log line is MISSING (prompt sections 6 and 21). A constraint whose trigger has occurred but which nothing enforces is MISSING.',
                'IMPLEMENTED': 'Real code for the production path exists but is not exercised by passing local tests against real protocols or emulators, misses a named element of its own acceptance, or holds only because nothing it governs exists yet (the gap then says "not yet triggered" and names the package that introduces the trigger or, where no package does, the package whose check fails when the trigger appears without its decision record).',
                'VERIFIED_LOCAL': 'Every named element of the acceptance is exercised in its production form by a passing local test on the real protocol or an emulator (PGlite single connection, OPA WASM, loopback HTTP, in-process production code, Docker emulators). PGlite single-connection tests never verify multi-connection concurrency (ADR-0018 decision 7.2). A fixture SDK client is not the real protocol. A README, header comment or ADR evidences only a documentation element of the acceptance; every behaviour element cites the test that exercises it. An acceptance element that needs a sandbox, tenant or human step is split into its own qualification row. Fixture-only, mock, canned or refusing paths are MISSING for production capabilities. The blanket non-local refusal is a cross-cutting blocker, not a per-item downgrade.',
                'RELEASE_PACKAGE_VERIFIED': 'Verified inside a reproducible release bundle; no requirement has reached this state.',
            },
            'vocabulary': 'These four values are the only software statuses (prompt section 0, ADR-0018 decision 7.1). There is no NOT_APPLICABLE: a constraint whose trigger has not occurred is IMPLEMENTED with a not-yet-triggered gap and a package that enforces or watches the trigger.',
            'environmentStatus': 'NOT_CONFIGURED for every requirement: no sandbox, staging or production environment, tenant or vendor configuration exists.',
            'qualification': "NOT_RUN unless a committed file under evidence/ (or docs/TEST_EVIDENCE.md) records a result for the requirement's own acceptance check; unit-test pass counts are software evidence, not qualification, except for requirements that are themselves the test command and whose command exists.",
            'workPackage': 'Every MISSING and IMPLEMENTED requirement belongs to exactly one work package; VERIFIED_LOCAL items name the package that re-runs them on real protocols (regressionPackage). secondaryPackages on the FO-02 invariant rows name the packages that add positive, adversarial and failure-injection tests at their own boundary. A FO-17-24.<FAULT_ID> row belongs to the package that runs its Layer-2 [FAULT:] test; injectionPointPackages build the injection point and postconditionPackages own the components the asserted postconditions observe, and the owner is each of them or depends on each of them (generator-checked). A journey row (FO-20, J01-J20 and their split legs) names componentPackages, the packages that build the components its acceptance exercises or asserts, under the same rule (generator-checked).',
            'capabilityIds': 'Every entry names at least one capability of docs/followon/capabilities.yaml; both status axes and qualification are reported per capability there.',
        },
        'summary': {
            'requirements': len(reqs),
            'softwareStatus': {k: status_counts.get(k, 0) for k in SOFTWARE},
            'environmentStatus': {k: env_counts.get(k, 0) for k in ENVIRONMENT if env_counts.get(k, 0)},
            'qualification': {k: qual_counts.get(k, 0) for k in QUALIFICATION if qual_counts.get(k, 0)},
            'capabilities': len(m['caps']),
            'origin': dict(sorted(origin_counts.items())),
            'phaseARepairStatusChanges': {f'{a} -> {b}': n for (a, b), n in sorted(repair_moves.items())},
        },
        'overlaps': m['narr']['overlaps'],
        'entries': entries,
    }
    out['docs/followon/gap-ledger.yaml'] = ('# Follow-on gap ledger (machine-readable). Human rendering: docs/GAP_CLOSURE.md.\n'
                                            f'# GENERATED by {GENERATOR} from docs/followon/source/; do not edit by hand.\n') + dump(ledger_doc)

    # ---------------- work-packages.yaml
    wave, member, obligations, fault_of, fault_inj = m['wave'], m['member'], m['obligations'], m['fault_of'], m['fault_inj']
    pk_rows = []
    for p in pkgs:
        pid = p['id']
        ids = member[pid]['requirementIds']
        reg = member[pid]['regressionIds']
        cnt = collections.Counter(RID[i]['softwareStatus'] for i in ids)
        capset = sorted({c for i in ids + reg for c in RID[i]['capabilityIds']}, key=[c['id'] for c in m['caps']].index)
        acc = list(p['acceptance'])
        inv = sorted(set(obligations.get(pid, [])), key=m['invariants'].index)
        if inv:
            acc.append('Invariant obligations at this package\'s boundary (FO-02 secondaryPackages): positive, adversarial and failure-injection tests tagged '
                       + ' '.join(f'[{x}]' for x in inv) + ' pass in this package\'s own suites.')
        flts = sorted(fault_of.get(pid, []))
        if flts:
            acc.append('Fault-matrix obligations (FO-17-24.<FAULT_ID> rows owned here): Layer-2 tests tagged ' + ' '.join(f'[FAULT:{x}]' for x in flts)
                       + ' reach the fault at its injection point and assert its postconditions.')
        seams = sorted(fault_inj.get(pid, []))
        if seams:
            acc.append('Fault injection points built here for Layer-2 runs owned by later packages: ' + ', '.join(f'[FAULT:{f}] (run by {o})' for f, o in seams)
                       + '; each seam has a local test proving it produces the fault, and the owning package\'s [FAULT:<id>] test drives it.')
        row = {'id': pid, 'phase': p['phase'], 'title': p['title'], 'goal': p['goal'], 'size': p['size'], 'dependsOn': p['dependsOn']}
        if p.get('earlyStart'):
            row['earlyStart'] = p['earlyStart']
        row.update({
            'earliestWave': wave[pid], 'requirementIds': ids, 'regressionIds': reg,
            'counts': {'MISSING': cnt.get('MISSING', 0), 'IMPLEMENTED': cnt.get('IMPLEMENTED', 0), 'regression': len(reg)},
            'capabilityIds': capset, 'invariantObligations': inv, 'faultObligations': flts,
            'faultInjectionPoints': [{'fault': f, 'runBy': o} for f, o in seams],
            'owns': p['owns'], 'ownsGroups': p.get('ownsGroups', []), 'excludes': p.get('excludes', []),
            'deliverables': p['deliverables'], 'acceptance': acc, 'externalActivation': p['externalActivation'], 'notes': p.get('notes', []),
        })
        pk_rows.append(row)
    shared = []
    for g in m['pk']['sharedGroups']:
        x = {'group': g['group'], 'files': g['files']}
        if g.get('excludes'):
            x['excludes'] = g['excludes']
        x['ownerByPhase'] = g['ownerByPhase']
        shared.append(x)
    wp_doc = {
        'schemaVersion': 'vsp.followon.work-packages.v2', 'asOf': as_of, 'baseCommit': head, 'generator': GENERATOR,
        'phases': m['pk']['phases'], 'ownershipRules': m['pk']['ownershipRules'], 'sharedFiles': shared,
        'unownedByDesign': m['pk'].get('unownedByDesign', []), 'generatedArtifacts': m['pk']['generatedArtifacts'],
        'summary': {
            'packages': len(pkgs), 'byPhase': dict(collections.Counter(p['phase'] for p in pkgs)),
            'requirementsAssigned': sum(len(member[p['id']]['requirementIds']) for p in pkgs),
            'regressionItems': sum(len(member[p['id']]['regressionIds']) for p in pkgs),
            'waves': max(wave.values()), 'earlyStart': [p['id'] for p in pkgs if p.get('earlyStart')],
        },
        'packages': pk_rows,
    }
    out['docs/followon/work-packages.yaml'] = ('# Follow-on work packages (machine-readable): ordered, dependency-aware plan for phases B-H.\n'
                                               '# Every MISSING/IMPLEMENTED requirement in docs/followon/gap-ledger.yaml belongs to exactly one package.\n'
                                               f'# GENERATED by {GENERATOR} from docs/followon/source/; do not edit by hand.\n') + dump(wp_doc)

    # ---------------- capabilities.yaml
    act_caps = collections.defaultdict(set)
    for a in m['act']:
        for rid in m['blocking'][a['id']]:
            for c in RID[rid]['capabilityIds']:
                act_caps[a['id']].add(c)
    cap_rows = []
    cap_order = [c['id'] for c in m['caps']]
    for c in m['caps']:
        mem = [r for r in reqs if c['id'] in r['capabilityIds']]
        sw = collections.Counter(r['softwareStatus'] for r in mem)
        en = collections.Counter(r['environmentStatus'] for r in mem)
        ql = collections.Counter(r['qualification'] for r in mem)
        owners = sorted({r.get('workPackage') or r.get('regressionPackage') for r in mem if (r.get('workPackage') or r.get('regressionPackage'))}, key=natkey)
        aids = sorted({a for r in mem for a in m['act_by_req'].get(r['id'], [])}, key=natkey)
        cap_rows.append({
            'id': c['id'], 'title': c['title'], 'description': c['description'],
            'softwareRollup': rollup([r['softwareStatus'] for r in mem], SOFTWARE),
            'environmentRollup': rollup([r['environmentStatus'] for r in mem], ENVIRONMENT),
            'softwareStatus': {k: sw.get(k, 0) for k in SOFTWARE if sw.get(k, 0)},
            'environmentStatus': {k: en.get(k, 0) for k in ENVIRONMENT if en.get(k, 0)},
            'qualification': {k: ql.get(k, 0) for k in QUALIFICATION if ql.get(k, 0)},
            'owningPackages': owners, 'activationIds': aids, 'requirementCount': len(mem),
            'memberRequirementIds': [r['id'] for r in mem],
        })
    cap_doc = {
        'schemaVersion': 'vsp.followon.capabilities.v1', 'asOf': as_of, 'baseCommit': head, 'generator': GENERATOR,
        'rules': [
            'A capability groups the requirements that must all hold before the capability can be activated; a requirement may belong to more than one capability.',
            'softwareRollup is the least advanced software status among the members; environmentRollup likewise for the environment axis. A capability is never reported ahead of its weakest member.',
            'activationIds are the activation register entries that block at least one member; owningPackages are the packages that own or re-run the members.',
            'Readiness (WP-32), the activation map (WP-07, WP-31), ActivationRecords (WP-45) and IMPLEMENTATION_STATUS (WP-44) use these ids.',
        ],
        'summary': {'capabilities': len(cap_rows), 'softwareRollup': dict(collections.Counter(c['softwareRollup'] for c in cap_rows)),
                    'environmentRollup': dict(collections.Counter(c['environmentRollup'] for c in cap_rows))},
        'capabilities': cap_rows,
    }
    out['docs/followon/capabilities.yaml'] = ('# Capability catalogue with both status axes per capability (prompt section 0).\n'
                                              f'# GENERATED by {GENERATOR} from docs/followon/source/; do not edit by hand.\n') + dump(cap_doc)

    # ---------------- activation-register.yaml
    act = m['act']
    bystate = collections.Counter(a['_state'] for a in act)
    act_doc = {
        'schemaVersion': 'vsp.followon.activation-register.v2', 'asOf': as_of, 'generator': GENERATOR, 'rules': m['acts_rules'],
        'summary': {'entries': len(act), 'byState': dict(sorted(bystate.items())), 'proposed': [a['id'] for a in act if a.get('proposed')],
                    'prqCovered': len(m['covered_prq']), 'prqTotal': len(m['PRQ']), 'prqNotMapped': sorted(set(m['PRQ']) - m['covered_prq'])},
        'entries': [{
            'id': a['id'], 'title': a['title'], 'kind': a['kind'], 'ownerRole': a['ownerRole'], 'prq': a['prq'], 'relatedPrq': a.get('relatedPrq', []),
            'proposed': bool(a.get('proposed')), 'approvalScopes': a['approvalScopes'], 'approvalRequests': a['approvalRequests'],
            'currentState': a['_state'], 'stateSource': a['_stateSource'], 'unlocks': a['unlocks'], 'softwarePrerequisites': a['workPackages'],
            'capabilityIds': sorted(act_caps[a['id']], key=cap_order.index),
            'activationSteps': a['steps'], 'expectedEvidence': a['evidence'], 'blockingRequirementIds': m['blocking'][a['id']],
        } for a in act],
    }
    out['docs/followon/activation-register.yaml'] = ('# Activation register (machine-readable): every external input or authority the follow-on product needs.\n'
                                                     '# Human rendering: docs/ACTIVATION_REGISTER.md. Prerequisite records: docs/prerequisites.yaml.\n'
                                                     f'# GENERATED by {GENERATOR} from docs/followon/source/; do not edit by hand.\n') + dump(act_doc)

    # ---------------- GAP_CLOSURE.md
    titles = m['titles']
    L = ['# Gap closure ledger (follow-on programme)', '']
    L.append(f'Human-readable gap ledger for the follow-on prompt ([`spec/voice-support-followon-specification.txt`](spec/voice-support-followon-specification.txt)), '
             f'prompt section 1 ("gap ledger") and section 19 (`GAP_CLOSURE`). It is generated by [`tools/followon/generate.py`](tools/followon/generate.py) from the '
             f'sources in [`followon/source/`](followon/source/) together with the machine-readable files [`followon/requirements.yaml`](followon/requirements.yaml), '
             f'[`followon/gap-ledger.yaml`](followon/gap-ledger.yaml), [`followon/work-packages.yaml`](followon/work-packages.yaml) and '
             f'[`followon/capabilities.yaml`](followon/capabilities.yaml); external inputs are in [`ACTIVATION_REGISTER.md`](ACTIVATION_REGISTER.md). '
             f'As of {as_of}, branch `{meta["branch"]}` at `{head}` (fix wave 5 merged). Run `python3 -I docs/tools/followon/generate.py --check` to confirm that '
             f'this file matches its sources.')
    L.append('')
    L.append('How the ledger was built: ' + meta['method'])
    L.append('')
    L.append('Status axes (prompt section 0): Software `MISSING` / `IMPLEMENTED` / `VERIFIED_LOCAL` / `RELEASE_PACKAGE_VERIFIED`; '
             'Environment `NOT_CONFIGURED` / `CONFIGURED` / `VERIFIED_SANDBOX` / `APPROVED_PILOT` / `VERIFIED_PRODUCTION`; '
             'Qualification `NOT_RUN` / `FAIL` / `INCONCLUSIVE` / `PASS`. `VERIFIED_LOCAL` needs a passing local test on the real protocol or an emulator that '
             'covers every named element of the acceptance; single-connection PGlite never verifies multi-connection concurrency; a fixture-only adapter, an interface '
             'plus a mock, a refusal in non-local composition, canned success, TEST ids, an empty history or a log line counts as `MISSING` for a production capability; '
             'a row that holds only because nothing it governs exists yet is `IMPLEMENTED` with a not-yet-triggered note and a package that enforces or watches the trigger. '
             'There is no fifth software status. A README, header comment or ADR evidences only a documentation element; behaviour elements cite tests. '
             'None of this is a compliance determination or a readiness statement; nothing here is approved for patient use.')
    L.append('')
    L.append('## Summary')
    L.append('')
    n_fault = len(m['fault_rows'])
    n_split = origin_counts.get('repair-split', 0) - n_fault
    L.append(f'{len(reqs)} requirements: {origin_counts.get("extraction", 0)} extracted, {origin_counts.get("challenge-missed", 0)} added by the skeptic challenge, '
             f'{origin_counts.get("challenge-split", 0)} split by the challenge, {n_split} split by the Phase A repair, {n_fault} per-fault rows of the FO-17-24 fault '
             f'matrix and {origin_counts.get("repair-added", 0)} section 23 constraint rows. Environment status is `NOT_CONFIGURED` for every requirement: no sandbox, '
             f'staging or production environment, tenant or vendor configuration exists.')
    L.append('')
    L.append('| Software status | Requirements |')
    L.append('|---|---|')
    for k in SOFTWARE:
        L.append(f'| `{k}` | {status_counts.get(k, 0)} |')
    L.append('')
    L.append('| Qualification | Requirements | Evidence |')
    L.append('|---|---|---|')
    for k in QUALIFICATION:
        if not qual_counts.get(k):
            continue
        ids = [r['id'] for r in reqs if r['qualification'] == k]
        L.append(f'| `{k}` | {qual_counts[k]} | {", ".join(ids) if k != "NOT_RUN" else "no committed result for the requirement acceptance"} |')
    L.append('')
    L.append('By prompt section:')
    L.append('')
    L.append('| Section | Total | MISSING | IMPLEMENTED | VERIFIED_LOCAL | Work packages |')
    L.append('|---|---|---|---|---|---|')
    by_sec = collections.OrderedDict()
    for r in reqs:
        by_sec.setdefault(r['section'], []).append(r)
    for sec in sorted(by_sec, key=int):
        rs = by_sec[sec]
        c = collections.Counter(r['softwareStatus'] for r in rs)
        wps = sorted({r['workPackage'] for r in rs if r.get('workPackage')}, key=natkey)
        L.append(f'| {sec}. {titles[sec]} | {len(rs)} | {c.get("MISSING", 0)} | {c.get("IMPLEMENTED", 0)} | {c.get("VERIFIED_LOCAL", 0)} | '
                 f'{", ".join(wps)} |')
    wave_moves = collections.Counter((u['wave'], u['package'], u['from'], u['to']) for r in reqs for u in r['provenance'].get('waveUpdates') or [])
    if wave_moves:
        L.append('')
        L.append('## Implementation waves')
        L.append('')
        L.append('Status changes applied after each wave from the independent verifier\'s verified status (`provenance.waveUpdates` on each row; '
                 'docs/followon/CONTINUATION.md records the runs):')
        L.append('')
        for w in sorted({k[0] for k in wave_moves}, key=natkey):
            L.append(f'* {w}: ' + ', '.join(f'{p} {a} -> {b}: {n}' for (ww, p, a, b), n in sorted(wave_moves.items(), key=lambda kv: (natkey(kv[0][1]), kv[0][2], kv[0][3])) if ww == w) + '.')
    L.append('')
    L.append('## Phase A repair')
    L.append('')
    L.append('The completeness critic re-checked the planner output, and further critic passes re-checked the repaired ledger. The repair rounds applied '
             'their findings to the ledger, plan and registers:')
    L.append('')
    L.append('* Status changes (both rounds): ' + (', '.join(f'{a} -> {b}: {n}' for (a, b), n in sorted(repair_moves.items())) or 'none') + '. Every `VERIFIED_LOCAL` row was '
             're-opened against its cited tests under the strict rule; rows that missed a named acceptance element, rested on single-connection PGlite for '
             'concurrency, on a mock, or held only because nothing they govern exists yet moved to `IMPLEMENTED` and into the `requirementIds` of the package '
             'whose deliverable covers them. FO-00-07 and FO-15-40 are `MISSING`.')
    L.append(f'* Fault matrix: FO-17-24 is the gate and {len(m["fault_rows"])} rows `FO-17-24.<FAULT_ID>` hold one fault each (the {len(m["plans"])} plans in '
             '`scenarios/fixtures/failures` plus every prompt section 17 item). Each row belongs to the package that runs its Layer-2 test; that package builds '
             'the injection point or depends on the packages that do (`injectionPointPackages`), and depends on every package whose component the asserted '
             'postconditions observe (`postconditionPackages`). The generator rejects any other assignment.')
    splits = [r for r in reqs if r['provenance'].get('splitFrom') and not r['id'].startswith('FO-17-24.')]
    L.append('* Splits: ' + ', '.join(f'{r["id"]} (from {r["provenance"]["splitFrom"]}, {r.get("workPackage") or r.get("regressionPackage")})' for r in splits) + '.')
    L.append('* Section 23 constraints are rows FO-23-01..' + f'{sum(1 for r in reqs if r["section"] == "23"):02d}' + '; original ids resolve to '
             f'`docs/requirements/catalog.yaml` and all {len(m["cat_ids"])} catalog ids are mapped; ADR, TB and follow-on prompt references moved to `derivedFrom`.')
    L.append(f'* Capability axis: {len(m["caps"])} capabilities in [`followon/capabilities.yaml`](followon/capabilities.yaml); every row names its capabilities.')
    L.append('* Activation ids are `AIN-NN` (no collision with the invariant ids ACT-01..ACT-05); entries without a PRQ record are marked proposed.')
    L.append('* The 27 invariant rows name the packages that add boundary tests (`secondaryPackages`); those obligations are part of each package\'s acceptance.')
    L.append('')
    for key, label in (('recheckRepair', 'Second critic pass (round 2):'), ('recheckRepair3', 'Third critic pass (round 3):'),
                       ('recheckRepair4', 'Fourth critic pass (round 4, applied with wave B1):')):
        if m['narr'].get(key):
            L.append(label)
            L.append('')
            for b in m['narr'][key]:
                L.append('* ' + b)
            L.append('')
    L.append('## By capability')
    L.append('')
    L.append('Both status axes per capability (prompt section 0). The rollup is the least advanced status among the members. Full membership: '
             '[`followon/capabilities.yaml`](followon/capabilities.yaml).')
    L.append('')
    L.append('| Capability | Rows | MISSING | IMPLEMENTED | VERIFIED_LOCAL | Software rollup | Environment rollup | Activation | Packages |')
    L.append('|---|---|---|---|---|---|---|---|---|')
    for c in cap_rows:
        sw = c['softwareStatus']
        L.append(f'| `{c["id"]}` {md_cell(c["title"])} | {c["requirementCount"]} | {sw.get("MISSING", 0)} | {sw.get("IMPLEMENTED", 0)} | {sw.get("VERIFIED_LOCAL", 0)} | '
                 f'`{c["softwareRollup"]}` | `{c["environmentRollup"]}` | {", ".join(c["activationIds"]) or "-"} | {", ".join(c["owningPackages"])} |')
    L.append('')
    L.append('## Cross-cutting findings')
    L.append('')
    for b in m['narr']['crossCuttingFindings']:
        L.append('* ' + b)
    L.append('')
    L.append('## Defects found during verification')
    L.append('')
    L.append('Found by the skeptic challenge and the completeness critic beyond missing features; each is tracked by the requirement and package named.')
    L.append('')
    L.append('| Defect | Evidence | Requirement | Package |')
    L.append('|---|---|---|---|')
    for d in m['narr']['defects']:
        r = RID[d['requirement']]
        pk_of = r.get('workPackage') or r.get('regressionPackage')
        if d['package'] != pk_of:
            fail(f'defect table names {d["package"]} for {d["requirement"]}, but the ledger assigns {pk_of}')
        L.append(f'| {md_cell(d["defect"])} | {d["evidence"]} | {d["requirement"]} | {d["package"]} |')
    L.append('')
    L.append('## Fault matrix')
    L.append('')
    L.append('The fixed denominator of FO-17-24: one row per fault. "Plan" means a fault plan exists in `scenarios/fixtures/failures`; no fault has a run over its '
             'real injection point yet, so none is `VERIFIED_LOCAL`. "Package" runs the Layer-2 `[FAULT:<id>]` test; it is, or depends on, every package in the '
             'two columns before it.')
    L.append('')
    L.append('| Fault | Source | Plan | Software | Injection point built by | Postconditions observe | Package |')
    L.append('|---|---|---|---|---|---|---|')
    for fid in sorted(m['fault_rows']):
        r = m['fault_rows'][fid]
        L.append(f'| `{fid}` | {r["faultSource"]} | {"yes" if fid in m["plans"] else "no"} | `{r["softwareStatus"]}` | '
                 f'{", ".join(r["injectionPointPackages"])} | {", ".join(r["postconditionPackages"])} | {r.get("workPackage") or r.get("regressionPackage") or "-"} |')
    L.append('')
    L.append('## Journeys')
    L.append('')
    L.append('One row per mandatory journey (prompt section 20) and per split leg. "Components" are the packages that build what the journey\'s acceptance '
             'exercises or asserts (`componentPackages`); "Package" runs the journey and is, or depends on, every one of them (generator-checked).')
    L.append('')
    L.append('| Row | Journey | Software | Components | Package |')
    L.append('|---|---|---|---|---|')
    for r in reqs:
        if r['section'] != '20' or not r.get('componentPackages'):
            continue
        L.append(f'| {r["id"]} | {md_cell(r["text"], 110)} | `{r["softwareStatus"]}` | {", ".join(r["componentPackages"])} | '
                 f'{r.get("workPackage") or r.get("regressionPackage")} |')
    L.append('')
    L.append('## Section 1 baseline observations reconciled with current truth')
    L.append('')
    L.append(f'Each observation from the reviewed main commit `4b0a5f9` checked against the working tree at `{head}`.')
    L.append('')
    L.append('| Observation (prompt section 1) | Current truth | Software | Package |')
    L.append('|---|---|---|---|')
    for x in m['narr']['section1Reconciliation']:
        r = RID[x['requirement']]
        L.append(f'| {md_cell(x["observation"])} | {md_cell(x["currentTruth"])} | `{r["softwareStatus"]}` | {r.get("workPackage") or r.get("regressionPackage") or "-"} |')
    L.append('')
    L.append('## Work packages')
    L.append('')
    L.append('Full definitions (goal, owned paths, deliverables, acceptance commands, external activation): [`followon/work-packages.yaml`](followon/work-packages.yaml). '
             'Earliest wave is the longest dependency chain; packages in the same wave with disjoint ownership can run in parallel. WP-23 starts early (phase D '
             'package that the phase C audio journey needs).')
    L.append('')
    L.append('| Package | Phase | Wave | Title | MISSING | IMPLEMENTED | Regression | Depends on |')
    L.append('|---|---|---|---|---|---|---|---|')
    for row in pk_rows:
        L.append(f'| {row["id"]} | {row["phase"]} | {row["earliestWave"]} | {md_cell(row["title"], 120)} | {row["counts"]["MISSING"]} | '
                 f'{row["counts"]["IMPLEMENTED"]} | {row["counts"]["regression"]} | {", ".join(row["dependsOn"]) or "-"} |')
    L.append('')
    L.append('Overlapping requirements handled as one piece of work: ' + '; '.join(f'{", ".join(o["ids"])} ({o["note"]})' for o in m['narr']['overlaps']))
    L.append('')
    L.append('## Ledger by prompt section')
    L.append('')
    L.append('Columns: requirement (shortened; full text in requirements.yaml), Software status, Environment status, first evidence citation, gap (shortened), '
             'work package (for `VERIFIED_LOCAL` the package that re-runs it on real protocols, in parentheses). Qualification is `NOT_RUN` unless the summary '
             'table above names the requirement.')
    for sec in sorted(by_sec, key=int):
        L.append('')
        L.append(f'### {sec}. {titles[sec]}')
        L.append('')
        L.append('| ID | Requirement | Software | Environment | Evidence | Gap | WP |')
        L.append('|---|---|---|---|---|---|---|')
        for r in by_sec[sec]:
            if r['softwareStatus'] in ('VERIFIED_LOCAL', 'RELEASE_PACKAGE_VERIFIED'):
                wp = f'({r["regressionPackage"]})'
            else:
                wp = r.get('workPackage') or '-'
            L.append(f'| {r["id"]} | {md_cell(r["text"], 140)} | `{r["softwareStatus"]}` | `{r["environmentStatus"]}` | '
                     f'{md_cell(r["evidence"][0] if r["evidence"] else "-", 110)} | {md_cell(r["gap"], 160)} | {wp} |')
    out['docs/GAP_CLOSURE.md'] = '\n'.join(L) + '\n'

    # ---------------- ACTIVATION_REGISTER.md
    M = ['# Activation register', '']
    M.append('One register of every external input or authority the follow-on product needs before a capability can leave `NOT_CONFIGURED`: credentials, BAAs, '
             'approvals, tenant configurations, staffed routes, paid tests, PHI processing, vendor entitlements, model access and legal reviews (prompt sections 0 and '
             '19, `ACTIVATION_REGISTER`). Machine-readable form: [`followon/activation-register.yaml`](followon/activation-register.yaml), generated by '
             '[`tools/followon/generate.py`](tools/followon/generate.py); capability ids: [`followon/capabilities.yaml`](followon/capabilities.yaml). Prerequisite '
             'records: [`prerequisites.yaml`](prerequisites.yaml) and [`PREREQUISITES.md`](PREREQUISITES.md); approval records: '
             '[`../approvals/README.md`](../approvals/README.md); approval requests: [`release/approval-requests.md`](release/approval-requests.md).')
    M.append('')
    M.append('Rules:')
    M.append('')
    for rule in m['acts_rules']:
        M.append('* ' + rule)
    M.append('* A missing BAA is not missing code, and an adapter stub is not a missing BAA: software gaps are tracked in [`GAP_CLOSURE.md`](GAP_CLOSURE.md), never here.')
    M.append('* No paid test, PHI access, notification, live call, routing change, production mutation or release runs from a safe local default (OPS-05); every '
             'step below that touches an external system requires the named approval first.')
    M.append('')
    M.append('## Summary')
    M.append('')
    prop = [a['id'] for a in act if a.get('proposed')]
    M.append(f'{len(act)} entries; current state: ' + ', '.join(f'`{k}` {v}' for k, v in sorted(bystate.items())) +
             f'. {len(m["covered_prq"])} of {len(m["PRQ"])} prerequisite records are mapped; every PRQ record is mapped to at least one entry. '
             f'{len(prop)} entries are proposed (no PRQ record exists yet; proposed additions, not requests): {", ".join(prop)}. '
             'Nothing is `APPROVED` or `EVIDENCED`: no external input has been supplied.')
    M.append('')
    M.append('| ID | External input or authority | Owner role | PRQ | State | Unlocks | Blocked requirements | Software first |')
    M.append('|---|---|---|---|---|---|---|---|')
    for a in act:
        prq = ', '.join(a['prq']) or 'none (proposed)'
        M.append(f'| {a["id"]} | {md_cell(a["title"], 150)} | {md_cell(a["ownerRole"], 80)} | {prq} | `{a["_state"]}` | {md_cell(a["unlocks"], 140)} | '
                 f'{len(m["blocking"][a["id"]])} | {", ".join(a["workPackages"])} |')
    M.append('')
    M.append('## Entries')
    for a in act:
        M.append('')
        M.append(f'### {a["id"]} {a["title"]}')
        M.append('')
        M.append('| Field | Value |')
        M.append('|---|---|')
        M.append(f'| Kind | {md_cell(a["kind"])} |')
        M.append(f'| Owner role | {md_cell(a["ownerRole"])} |')
        M.append(f'| Prerequisite records | {", ".join(a["prq"]) or "none: proposed addition to the prerequisite register"} |')
        if a.get('relatedPrq'):
            M.append(f'| Related records (do not cover this entry) | {", ".join(a["relatedPrq"])} |')
        M.append(f'| Approval scopes | {", ".join("`" + s + "`" for s in a["approvalScopes"]) or "none"} |')
        M.append(f'| Approval requests | {", ".join(a["approvalRequests"]) or "none"} |')
        M.append(f'| Current state | `{a["_state"]}`: {md_cell(a["_stateSource"])} |')
        M.append(f'| Unlocks | {md_cell(a["unlocks"])} |')
        M.append(f'| Capabilities | {", ".join("`" + c + "`" for c in sorted(act_caps[a["id"]], key=cap_order.index))} |')
        M.append(f'| Software that must exist first | {", ".join(a["workPackages"])} |')
        M.append(f'| Expected evidence | {md_cell(a["evidence"])} |')
        M.append('')
        M.append('Activation steps (commands are delivered by the packages above; they do not exist before those packages land):')
        M.append('')
        for i, s in enumerate(a['steps'], 1):
            M.append(f'{i}. {s}')
        M.append('')
        ids = m['blocking'][a['id']]
        M.append(f'Blocked requirements ({len(ids)}): ' + ', '.join(ids) + '.')
    out['docs/ACTIVATION_REGISTER.md'] = '\n'.join(M) + '\n'
    return out


# ====================================================================== output checks (mirror the docs-pack rules)
def check_markdown(out):
    phone = re.compile(r'(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b')
    claim = re.compile(r'HIPAA[- ]complian(t|ce)|production[- ]read(y|iness)', re.I)
    neg = re.compile(r"\b(not|never|no|cannot|without)\b|n't", re.I)
    for rel, text in out.items():
        if not rel.endswith('.md'):
            continue
        body = re.sub(r'```[\s\S]*?```', '', text)
        for i, line in enumerate(text.split('\n'), 1):
            if claim.search(line) and not neg.search(line):
                fail(f'{rel}:{i}: affirmative compliance/readiness phrasing (docs-pack OPS-03 rule)')
            for mm in phone.finditer(line):
                if not re.search(r'555[\s.-]?01\d\d', mm.group(0)):
                    fail(f'{rel}:{i}: phone-number-shaped string (docs-pack DATA-01 rule)')
        for mm in re.finditer(r'\[[^\]]*\]\(([^)\s]+)\)', body):
            target = mm.group(1)
            if re.match(r'^(https?:|mailto:|#)', target):
                continue
            path = target.split('#')[0]
            if not path:
                continue
            abs_target = os.path.normpath(os.path.join(REPO, os.path.dirname(rel), path))
            if not os.path.exists(abs_target) and os.path.relpath(abs_target, REPO) not in OUTPUTS:
                fail(f'{rel}: link target {target} does not exist')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--check', action='store_true', help='fail when an output differs from what the sources generate')
    ap.add_argument('--out', help='write the outputs under this directory instead of the repository')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()
    reqs, pk, acts, caps, narr, catalog, prereq, plans = load()
    m = build(reqs, pk, acts, caps, narr, catalog, prereq, plans, working_tree_files())
    out = None
    if m is not None:
        m['acts_rules'] = acts['rules']
        out = render(m)
        check_markdown(out)
    if ERRORS:
        for e in ERRORS:
            print('SOURCE ERROR:', e, file=sys.stderr)
        print(f'{len(ERRORS)} source validation error(s); nothing written', file=sys.stderr)
        return 2
    if args.check:
        drift = []
        for rel in OUTPUTS:
            path = os.path.join(REPO, rel)
            cur = open(path, encoding='utf-8').read() if os.path.exists(path) else None
            if cur != out[rel]:
                drift.append(rel)
        if drift:
            for rel in drift:
                print('DRIFT:', rel, file=sys.stderr)
            print('outputs differ from docs/followon/source/; run python3 -I docs/tools/followon/generate.py', file=sys.stderr)
            return 1
        if not args.quiet:
            print(f'OK: {len(OUTPUTS)} outputs match their sources')
        return 0
    root = os.path.abspath(args.out) if args.out else REPO
    for rel in OUTPUTS:
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(out[rel])
    if not args.quiet:
        c = collections.Counter(r['softwareStatus'] for r in reqs)
        q = collections.Counter(r['qualification'] for r in reqs)
        print(f'wrote {len(OUTPUTS)} outputs under {root}')
        print('requirements', len(reqs), {k: c.get(k, 0) for k in SOFTWARE}, dict(q))
        print('packages', len(m['pkgs']), 'waves', max(m['wave'].values()), 'activation entries', len(m['act']), 'capabilities', len(caps))
    return 0


if __name__ == '__main__':
    sys.exit(main())
