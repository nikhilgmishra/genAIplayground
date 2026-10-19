# Single documented entry point (prompt section 19). Every target delegates to scripts/vsp/runner.mts,
# which preserves the real exit code of the tool it runs; GNU make reports any failing recipe as 2.
# No target calls a billable endpoint (OPS-05): the composition is local emulators only.
#
#   make up [PROFILE=core[,media,...]]            start the Layer-2 composition, wait for health checks
#   make down [PURGE=1] [PURGE_AUDIT=1]           stop it; volumes only with PURGE=1, audit volumes only with PURGE_AUDIT=1
#                                                 (command-line assignments only: an exported PURGE or PURGE_AUDIT is ignored)
#   make ps | make logs [SERVICE=name]            inspect it
#   make test-unit [ARGS="-- <vitest args>"]      Layer 1, writes evidence/test-reports/vitest-unit.json
#   make test-integration [SUITE=_harness] [FILTER=a,b]
#                                                 Layer 2 against the running composition, writes vitest-integration.json
#   make check-runtime | make check-deps          runtime LTS pin; exact, locked, installed and licensed dependency pins
#   make check-deps ARGS=--inventory              every direct dependency with locked version and licence
#
# test-unit and test-integration remove the reports of an earlier run before they start; a package or
# run that writes no report counts as failed (non-zero exit) and contributes no counts.
#
# Other commands named in prompt section 19 (doctor, configure, seed-synthetic, demo, test-contract,
# test-audio, test-chaos, eval, load, ...) are added by the packages that own them (docs/followon/work-packages.yaml).

SHELL := /usr/bin/env bash
NODE ?= node
RUNNER := $(NODE) scripts/vsp/runner.mts
PROFILE ?= core
TRUE_VALUES := 1 true yes

# Destructive switches count only when assigned on the make command line (`make down PURGE=1`, which
# recursive makes receive through MAKEFLAGS as command-line assignments too). GNU make imports every
# environment variable as a make variable, so without the origin check an exported PURGE or
# PURGE_AUDIT left in a shell would purge volumes, audit evidence included, on a plain `make down`
# (FO-19-64, threat row T-FO-03-05). `$(call cmdline_true,NAME)` is non-empty only for a command-line
# assignment of a true value; `$(call env_ignored,NAME)` names a switch that came from the environment.
cmdline_true = $(and $(filter command line,$(origin $(1))),$(filter $(TRUE_VALUES),$($(1))))
env_ignored = $(if $(filter environment,$(firstword $(origin $(1)))),$(1))
DESTRUCTIVE_FROM_ENV = $(strip $(call env_ignored,PURGE) $(call env_ignored,PURGE_AUDIT))

.DEFAULT_GOAL := help
.PHONY: help up down ps logs test-unit test-integration check-runtime check-deps

help:
	@$(RUNNER) help

up:
	$(RUNNER) up --profile "$(PROFILE)" $(if $(TIMEOUT),--timeout "$(TIMEOUT)")

down:
	$(if $(DESTRUCTIVE_FROM_ENV),@echo "down: ignoring $(DESTRUCTIVE_FROM_ENV) from the environment; destructive switches count only on the make command line (make down PURGE=1 [PURGE_AUDIT=1])" >&2)
	$(RUNNER) down $(if $(call cmdline_true,PURGE),--purge) $(if $(call cmdline_true,PURGE_AUDIT),--purge-audit)

ps:
	@$(RUNNER) ps

logs:
	@$(RUNNER) logs $(SERVICE)

test-unit:
	$(RUNNER) test-unit $(ARGS)

test-integration:
	$(RUNNER) test-integration $(if $(SUITE),--suite "$(SUITE)") $(if $(FILTER),--filter "$(FILTER)") $(ARGS)

check-runtime:
	$(RUNNER) check-runtime $(ARGS)

check-deps:
	$(RUNNER) check-deps $(ARGS)
