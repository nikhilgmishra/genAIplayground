# platform/src/connectors/dsl: the bounded, non-executable mapping DSL (WP-06)

Status: **IMPLEMENTED**. A declarative profile maps reviewed operations and JSON fields only through this
interpreter; there is no expression language, no code loading and no way to build a host or path.

* **Pointers:** RFC 6901 JSON pointers with bounded depth and length (`parsePointer`, `readPointer`,
  `writePointer`).
* **Closed function set:** casts to declared field types, enum tables, unit conversion
  (`unit:<from>:<to>`), wall-clock-to-UTC zone conversion (`zone:<key>`), labels. A malformed `enum:`,
  `unit:` or `zone:` code is a definition error (`DSL_SEMANTIC_INVALID`), never silently a label.
* **Field classes:** REQUIRED, OPTIONAL and PROHIBITED. A prohibited field never leaves the mapping; a
  missing required field, a type mismatch or an unmapped enum value refuses the **whole record** with
  `ConnectorSchemaDriftError` (CONNECTOR_SCHEMA_DRIFT, typed issues `{kind, targetField}`, no values).
* **Limits:** at most 1 000 records per application, 2 000 000 interpreter steps and 8 000 000 mapped output
  characters per call (`DSL_LIMITS`); a call that would exceed one stops with `MappingLimitError`
  (`DSL_STEP_LIMIT`, `DSL_SIZE_LIMIT`) and returns nothing partial. Admissible mappings reach both bounds
  (200 depth-16 pointers over 1 000 records; 256 rules over a 4 000-character field), which `dsl.test.ts`
  exercises. The interpreter is total (property tests in `dsl.property.test.ts`).
* **Digests:** every compiled mapping has a digest, pinned in the checkpoint and the probe report.
* **Templates:** `checkOperationTemplate` / `renderRequest` render a reviewed path template with typed
  parameters (opaque id, token, integer, enum code, date, instant), so caller or model text cannot add a
  segment, a query or a host (`TemplateInputError`).
* **Metadata:** `parseMetadata` reads JSON Schema or field-describe metadata; `validateMappingAgainstMetadata`
  reports missing required fields, prohibited fields mapped, type and semantic mismatches.

Test: `cd platform && npx vitest run src/connectors/dsl`.
