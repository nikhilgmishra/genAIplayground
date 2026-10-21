/**
 * Bounded mapping DSL and reviewed operation templates of the connector runtime (WP-06; follow-on
 * prompt section 6; FO-06-05, FO-06-20, FO-06-22, FO-06-23). Non-executable by construction: data in,
 * typed data out, through a closed function set with step and size limits. See README.md.
 */
export { CONNECTOR_SCHEMA_DRIFT, ConnectorSchemaDriftError, MappingDefinitionError, MappingLimitError } from "./errors.js";
export type { DriftIssue, DriftKind } from "./errors.js";
export { MAX_POINTER_DEPTH, MAX_POINTER_LENGTH, parsePointer, pointerWithin, readPointer, writePointer } from "./pointer.js";
export { MAX_STRING_LENGTH, UNITS, applySemantic, castValue, convertUnit, isKnownZone, normalizeInstant, parseSemantic, semanticAccepts, unitCompatible, zonedLocalToUtc } from "./values.js";
export type { CastResult, FieldType, MappedValue, Semantic } from "./values.js";
export { DSL_LIMITS, applyMapping, authoritativeFields, compileMapping, compileTables } from "./mapping.js";
export type { CompiledMapping, CompiledRule, CompiledTables, FieldProvenance, MappedRecord } from "./mapping.js";
export { TemplateInputError, checkOperationTemplate, paramWireValue, renderRequest } from "./template.js";
export type { ParamValue, RenderInput, RenderedRequest } from "./template.js";
export { parseMetadata, validateMappingAgainstMetadata } from "./metadata.js";
export type { FieldMeta, MetadataFormat, ObjectMetadata } from "./metadata.js";
