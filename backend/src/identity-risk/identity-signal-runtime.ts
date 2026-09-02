import {
  IDENTITY_RISK_ENGINE_VERSION,
  IDENTITY_SIGNAL_CATALOG_VERSION,
  IDENTITY_SIGNAL_MAX_EVIDENCE_ITEMS,
  IDENTITY_SIGNAL_MAX_EVIDENCE_REFERENCES,
  IDENTITY_SIGNAL_MAX_EVIDENCE_REFERENCE_LENGTH,
  IDENTITY_SIGNAL_MAX_SUBJECT_REFERENCE_LENGTH,
  IDENTITY_SIGNAL_RULE_IDS,
  type ApprovedCatalog,
  type AuthEvent,
  type BehaviorBaseline,
  type CatalogType,
  type IdentitySignalCandidate,
  type IdentitySignalEvaluationContext,
  type IdentitySignalRuleId,
  type NetworkContextEntry,
} from './identity-signal-contract.js'

const MAX_CATALOG_VALUES = 4_096
const MAX_ACCOUNT_CLASSES = 4_096
const MAX_CONTEXT_ENTRIES = 1_024
const MAX_CANDIDATE_COLLECTION_ITEMS = 2_048
const MAX_GENERAL_STRING_LENGTH = 256
const MAX_CATALOG_VERSION_LENGTH = 64
const RULE_ID_SET = new Set<string>(IDENTITY_SIGNAL_RULE_IDS)
const CATALOG_TYPES = new Set<CatalogType>([
  'PRIVILEGED_ROLE_GROUP',
  'HIGH_IMPACT_OPERATION',
  'HIGH_IMPACT_APPLICATION_PERMISSION',
  'LEGACY_CLIENT',
  'ACCOUNT_CLASS',
  'NETWORK_CONTEXT',
])
const ACCOUNT_CLASSES = new Set(['HUMAN', 'PRIVILEGED_HUMAN', 'SERVICE', 'SHARED', 'BREAK_GLASS', 'UNKNOWN'])
const NETWORK_CONTEXT_TYPES = new Set(['SHARED_EGRESS', 'SHARED_DEVICE', 'EXPECTED_AUTH_RETRY', 'TRAVEL_EXCEPTION', 'MAINTENANCE'])
const SUSPICIOUS_REFERENCE = /(?:bearer|password|passwd|secret|token|authorization|cookie|supabase|microsoft|entra|exchange|resend|amazonses|amazonaws|google|https?)/iu
const JWT_SHAPE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/u
const OPAQUE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const CATALOG_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const CATALOG_VERSION = /^[a-z0-9][a-z0-9._/-]*$/u

const BASE_FIELDS = ['ruleId', 'subject', 'evidenceReferences', 'evidence', 'evidenceState', 'requiresFullCapability'] as const
const RULE_FIELDS: Readonly<Record<IdentitySignalRuleId, readonly string[]>> = Object.freeze({
  'HV-ID-EXP-001.v1': ['privileged', 'enabled', 'effectiveMfa'],
  'HV-ID-EXP-002.v1': ['privileged', 'enabled', 'userType'],
  'HV-ID-EXP-003.v1': ['privileged', 'enabled', 'baseline', 'lastSuccessfulInteractiveSignInAt'],
  'HV-ID-CHG-001.v1': ['lifecycle', 'lifecycleAt', 'privilegeAt', 'privilegeOperation', 'privilegeSucceeded'],
  'HV-ID-CHG-002.v1': ['userType', 'authoritativeCreatedAt', 'privilegeAt', 'privilegeOperation', 'privilegeSucceeded'],
  'HV-ID-CHG-003.v1': ['anchorAt', 'actorId', 'events'],
  'HV-ID-CHG-004.v1': ['operation', 'actorBaselineEvents', 'tenantBaselineEvents', 'actorOperationCount', 'tenantOperationCount', 'baselineActiveDays', 'succeeded'],
  'HV-ID-CHG-005.v1': ['change', 'before', 'after', 'succeeded'],
  'HV-ID-APP-001.v1': ['declaredPermissions', 'authoritativeCreatedAt', 'observedAt'],
  'HV-ID-APP-002.v1': ['applicationPermissionIds', 'credentialMetadataChanged', 'authoritativeComparable', 'succeeded'],
  'HV-ID-MBX-001.v1': ['enabled', 'recipientAddresses', 'verifiedAcceptedDomains'],
  'HV-ID-MBX-002.v1': ['enabled', 'conditionsCompleteness', 'actionsCompleteness', 'populatedConditionCount', 'populatedExceptionCount', 'actions'],
  'HV-ID-MBX-003.v1': ['projectionComplete', 'mailboxChangeAt', 'independentSignInAt', 'independentSignInRuleId', 'baseSeverity'],
  'HV-ID-AUTH-001.v1': ['disabledAt', 'activityAt', 'outcome'],
  'HV-ID-AUTH-002.v1': ['baseline', 'eventAt', 'lastSuccessfulInteractiveSignInAt', 'successfulInteractive'],
  'HV-ID-AUTH-003.v1': ['baseline', 'properties', 'sourceFingerprint'],
  'HV-ID-AUTH-004.v1': ['baseline', 'previous', 'current'],
  'HV-ID-AUTH-005.v1': ['events'],
  'HV-ID-AUTH-006.v1': ['events', 'normalizedMfaDetailComplete'],
  'HV-ID-AUTH-007.v1': ['privileged', 'succeeded', 'client'],
  'HV-ID-AUTH-008.v1': ['events', 'tenantWideComplete'],
  'HV-ID-AUTH-009.v1': ['successfulInteractive', 'occurredAt'],
})

type RecordValue = Record<string, unknown>

function isPlainRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

function hasOnlyDataKeys(value: unknown, allowed: readonly string[]): value is RecordValue {
  if (!isPlainRecord(value)) return false
  const allowedKeys = new Set(allowed)
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))) return false
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return Boolean(descriptor && 'value' in descriptor && descriptor.enumerable)
  })
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value))
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isEnum(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value)
}

function isBoundedText(value: unknown, maximum = MAX_GENERAL_STRING_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
}

export function isOpaqueIdentityReference(value: unknown, maximum: number = IDENTITY_SIGNAL_MAX_EVIDENCE_REFERENCE_LENGTH): value is string {
  return isBoundedText(value, maximum) && OPAQUE_REFERENCE.test(value) &&
    !['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase()) &&
    !SUSPICIOUS_REFERENCE.test(value) && !JWT_SHAPE.test(value)
}

function isCatalogValue(value: unknown): value is string {
  return isBoundedText(value, 128) && CATALOG_VALUE.test(value) && !SUSPICIOUS_REFERENCE.test(value)
}

export function isIdentitySignalRuleId(value: unknown): value is IdentitySignalRuleId {
  return typeof value === 'string' && RULE_ID_SET.has(value)
}

function validStringArray(value: unknown, limit: number, validator: (entry: unknown) => boolean): value is string[] {
  return Array.isArray(value) && value.length <= limit && value.every(validator)
}

function validSubject(value: unknown): boolean {
  return hasOnlyDataKeys(value, ['type', 'opaqueId']) &&
    isEnum(value.type, ['USER', 'APPLICATION', 'MAILBOX', 'TENANT', 'SOURCE']) &&
    isOpaqueIdentityReference(value.opaqueId, IDENTITY_SIGNAL_MAX_SUBJECT_REFERENCE_LENGTH)
}

function validEvidence(value: unknown): boolean {
  return Array.isArray(value) && value.length <= IDENTITY_SIGNAL_MAX_EVIDENCE_ITEMS && value.every((entry) =>
    hasOnlyDataKeys(entry, ['observedAt', 'maxAgeHours']) && isTimestamp(entry.observedAt) && isFiniteNumber(entry.maxAgeHours))
}

function validBaseline(value: unknown): value is BehaviorBaseline {
  if (!hasOnlyDataKeys(value, ['status', 'activeDays', 'successfulInteractiveSignIns', 'propertyFrequency'])) return false
  if (!isEnum(value.status, ['LEARNING', 'MATURE', 'UNAVAILABLE']) ||
      !isNonNegativeInteger(value.activeDays) || !isNonNegativeInteger(value.successfulInteractiveSignIns)) return false
  if (value.propertyFrequency === undefined) return true
  if (!isPlainRecord(value.propertyFrequency) || Reflect.ownKeys(value.propertyFrequency).length > 128) return false
  const frequencyRecord = value.propertyFrequency as RecordValue
  return Reflect.ownKeys(frequencyRecord).every((key) => {
    if (typeof key !== 'string' || !isOpaqueIdentityReference(key, 160)) return false
    const frequency = frequencyRecord[key]
    return hasOnlyDataKeys(frequency, ['events', 'days']) && isNonNegativeInteger(frequency.events) && isNonNegativeInteger(frequency.days)
  })
}

function validAuthEvent(value: unknown): value is AuthEvent {
  return hasOnlyDataKeys(value, ['id', 'occurredAt', 'outcome', 'interactive', 'subjectId', 'sourceFingerprint', 'sourceAsn', 'appId', 'client', 'deviceFingerprint']) &&
    isOpaqueIdentityReference(value.id) && isTimestamp(value.occurredAt) &&
    isEnum(value.outcome, ['SUCCESS', 'FAILURE', 'MFA_DENIED', 'MFA_TIMEOUT']) && isBoolean(value.interactive) &&
    isOpaqueIdentityReference(value.subjectId) &&
    (value.sourceFingerprint === undefined || isOpaqueIdentityReference(value.sourceFingerprint)) &&
    (value.sourceAsn === undefined || isNonNegativeInteger(value.sourceAsn)) &&
    (value.appId === undefined || isOpaqueIdentityReference(value.appId)) &&
    (value.client === undefined || (isCatalogValue(value.client) && value.client === value.client.toLowerCase())) &&
    (value.deviceFingerprint === undefined || isOpaqueIdentityReference(value.deviceFingerprint))
}

function validAuthEvents(value: unknown): value is AuthEvent[] {
  return Array.isArray(value) && value.length <= MAX_CANDIDATE_COLLECTION_ITEMS && value.every(validAuthEvent)
}

function validContextEntry(value: unknown): value is NetworkContextEntry {
  if (!hasOnlyDataKeys(value, ['id', 'type', 'startsAt', 'expiresAt', 'subjectId', 'appId', 'client', 'deviceFingerprint', 'sourceFingerprint'])) return false
  return isOpaqueIdentityReference(value.id) && typeof value.type === 'string' && NETWORK_CONTEXT_TYPES.has(value.type) &&
    isTimestamp(value.startsAt) && isTimestamp(value.expiresAt) &&
    (value.subjectId === undefined || isOpaqueIdentityReference(value.subjectId)) &&
    (value.appId === undefined || isOpaqueIdentityReference(value.appId)) &&
    (value.client === undefined || (isCatalogValue(value.client) && value.client === value.client.toLowerCase())) &&
    (value.deviceFingerprint === undefined || isOpaqueIdentityReference(value.deviceFingerprint)) &&
    (value.sourceFingerprint === undefined || isOpaqueIdentityReference(value.sourceFingerprint))
}

export function isApprovedCatalogRuntime(value: unknown): value is ApprovedCatalog {
  if (!hasOnlyDataKeys(value, ['catalogType', 'version', 'digest', 'status', 'approverIds', 'effectiveAt', 'expiresAt', 'values', 'accountClasses', 'contextEntries'])) return false
  if (typeof value.catalogType !== 'string' || !CATALOG_TYPES.has(value.catalogType as CatalogType) ||
      !isBoundedText(value.version, MAX_CATALOG_VERSION_LENGTH) || !CATALOG_VERSION.test(value.version) || value.version !== value.version.toLowerCase() || SUSPICIOUS_REFERENCE.test(value.version) ||
      typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.digest) ||
      !isEnum(value.status, ['DRAFT', 'APPROVED']) || !isTimestamp(value.effectiveAt) ||
      (value.expiresAt !== undefined && !isTimestamp(value.expiresAt)) ||
      !validStringArray(value.approverIds, 16, (entry) => isOpaqueIdentityReference(entry, 128)) ||
      !validStringArray(value.values, MAX_CATALOG_VALUES, (entry) => isCatalogValue(entry) && entry === entry.toLowerCase())) return false
  if (new Set(value.approverIds).size !== value.approverIds.length) return false
  if (value.accountClasses !== undefined) {
    if (value.catalogType !== 'ACCOUNT_CLASS' || !isPlainRecord(value.accountClasses) || Reflect.ownKeys(value.accountClasses).length > MAX_ACCOUNT_CLASSES) return false
    const classes = value.accountClasses as RecordValue
    if (!Reflect.ownKeys(classes).every((key) =>
      typeof key === 'string' && isOpaqueIdentityReference(key, IDENTITY_SIGNAL_MAX_SUBJECT_REFERENCE_LENGTH) &&
      typeof classes[key] === 'string' && ACCOUNT_CLASSES.has(classes[key] as string))) return false
  }
  if (value.contextEntries !== undefined) {
    if (value.catalogType !== 'NETWORK_CONTEXT' || !Array.isArray(value.contextEntries) ||
        value.contextEntries.length > MAX_CONTEXT_ENTRIES || !value.contextEntries.every(validContextEntry)) return false
  }
  if (value.catalogType === 'ACCOUNT_CLASS' && value.accountClasses === undefined) return false
  if (value.catalogType === 'NETWORK_CONTEXT' && value.contextEntries === undefined) return false
  return true
}

export function isEvaluationContextRuntime(value: unknown): value is IdentitySignalEvaluationContext {
  if (!hasOnlyDataKeys(value, ['organizationId', 'customerTenantId', 'evaluatedAt', 'engineVersion', 'catalogVersion', 'readiness', 'capability', 'futureClockSkewToleranceMs', 'featureFlags', 'catalogs'])) return false
  if (!isOpaqueIdentityReference(value.organizationId, 128) || !isOpaqueIdentityReference(value.customerTenantId, 128) ||
      !isTimestamp(value.evaluatedAt) || value.engineVersion !== IDENTITY_RISK_ENGINE_VERSION ||
      value.catalogVersion !== IDENTITY_SIGNAL_CATALOG_VERSION || !isEnum(value.readiness, ['READY', 'NOT_READY']) ||
      !isEnum(value.capability, ['FULL', 'PARTIAL', 'UNAVAILABLE']) || !isNonNegativeInteger(value.futureClockSkewToleranceMs) ||
      value.futureClockSkewToleranceMs > 300_000) return false
  if (value.featureFlags !== undefined) {
    if (!isPlainRecord(value.featureFlags) || Reflect.ownKeys(value.featureFlags).length > IDENTITY_SIGNAL_RULE_IDS.length) return false
    const flags = value.featureFlags as RecordValue
    if (!Reflect.ownKeys(flags).every((key) =>
      typeof key === 'string' && isIdentitySignalRuleId(key) && typeof flags[key] === 'boolean')) return false
  }
  if (value.catalogs !== undefined) {
    if (!Array.isArray(value.catalogs) || value.catalogs.length > CATALOG_TYPES.size || !value.catalogs.every(isApprovedCatalogRuntime)) return false
    const types = value.catalogs.map((catalog) => catalog.catalogType)
    if (new Set(types).size !== types.length) return false
  }
  return true
}

function validStringOrNullTimestamp(value: unknown): boolean {
  return value === null || isTimestamp(value)
}

function validRuleCandidate(value: RecordValue, ruleId: IdentitySignalRuleId): boolean {
  switch (ruleId) {
    case 'HV-ID-EXP-001.v1':
      return isBoolean(value.privileged) && isBoolean(value.enabled) && isEnum(value.effectiveMfa, ['ENFORCED', 'NOT_ENFORCED', 'UNKNOWN'])
    case 'HV-ID-EXP-002.v1':
      return isBoolean(value.privileged) && isBoolean(value.enabled) && isEnum(value.userType, ['MEMBER', 'GUEST', 'UNKNOWN'])
    case 'HV-ID-EXP-003.v1':
      return isBoolean(value.privileged) && isBoolean(value.enabled) && validBaseline(value.baseline) && validStringOrNullTimestamp(value.lastSuccessfulInteractiveSignInAt)
    case 'HV-ID-CHG-001.v1':
      return isEnum(value.lifecycle, ['CREATED', 'RE_ENABLED']) && isTimestamp(value.lifecycleAt) && isTimestamp(value.privilegeAt) && isCatalogValue(value.privilegeOperation) && isBoolean(value.privilegeSucceeded)
    case 'HV-ID-CHG-002.v1':
      return isEnum(value.userType, ['MEMBER', 'GUEST', 'UNKNOWN']) && validStringOrNullTimestamp(value.authoritativeCreatedAt) && isTimestamp(value.privilegeAt) && isCatalogValue(value.privilegeOperation) && isBoolean(value.privilegeSucceeded)
    case 'HV-ID-CHG-003.v1':
      return isTimestamp(value.anchorAt) && isOpaqueIdentityReference(value.actorId) && Array.isArray(value.events) && value.events.length <= MAX_CANDIDATE_COLLECTION_ITEMS && value.events.every((event) =>
        hasOnlyDataKeys(event, ['id', 'occurredAt', 'actorId', 'operation', 'succeeded']) && isOpaqueIdentityReference(event.id) && isTimestamp(event.occurredAt) && isOpaqueIdentityReference(event.actorId) && isCatalogValue(event.operation) && isBoolean(event.succeeded))
    case 'HV-ID-CHG-004.v1':
      return isCatalogValue(value.operation) && ['actorBaselineEvents', 'tenantBaselineEvents', 'actorOperationCount', 'tenantOperationCount', 'baselineActiveDays'].every((field) => isNonNegativeInteger(value[field])) && isBoolean(value.succeeded)
    case 'HV-ID-CHG-005.v1':
      return isEnum(value.change, ['SECURITY_DEFAULTS', 'MFA_POLICY', 'STRONG_GRANT']) && (typeof value.before === 'boolean' || isCatalogValue(value.before)) && (typeof value.after === 'boolean' || isCatalogValue(value.after)) && isBoolean(value.succeeded)
    case 'HV-ID-APP-001.v1':
      return validStringArray(value.declaredPermissions, MAX_CANDIDATE_COLLECTION_ITEMS, isCatalogValue) && validStringOrNullTimestamp(value.authoritativeCreatedAt) && isTimestamp(value.observedAt)
    case 'HV-ID-APP-002.v1':
      return validStringArray(value.applicationPermissionIds, MAX_CANDIDATE_COLLECTION_ITEMS, isCatalogValue) && isBoolean(value.credentialMetadataChanged) && isBoolean(value.authoritativeComparable) && isBoolean(value.succeeded)
    case 'HV-ID-MBX-001.v1':
      return isBoolean(value.enabled) && validStringArray(value.recipientAddresses, MAX_CANDIDATE_COLLECTION_ITEMS, (entry) => isBoundedText(entry, 320)) && validStringArray(value.verifiedAcceptedDomains, 256, (entry) => isBoundedText(entry, 253) && /^[A-Za-z0-9.-]+$/u.test(entry))
    case 'HV-ID-MBX-002.v1':
      if (!isBoolean(value.enabled) || !isEnum(value.conditionsCompleteness, ['COMPLETE', 'INCOMPLETE', 'UNAVAILABLE']) || !isEnum(value.actionsCompleteness, ['COMPLETE', 'INCOMPLETE', 'UNAVAILABLE']) || !isNonNegativeInteger(value.populatedConditionCount) || !isNonNegativeInteger(value.populatedExceptionCount) || !hasOnlyDataKeys(value.actions, ['delete', 'permanentDelete', 'moveTarget', 'markAsRead', 'stopProcessing'])) return false
      return ['delete', 'permanentDelete', 'moveTarget', 'markAsRead', 'stopProcessing'].every((field) => isBoolean((value.actions as RecordValue)[field]))
    case 'HV-ID-MBX-003.v1':
      return isBoolean(value.projectionComplete) && isTimestamp(value.mailboxChangeAt) && isTimestamp(value.independentSignInAt) && isIdentitySignalRuleId(value.independentSignInRuleId) && value.independentSignInRuleId.startsWith('HV-ID-AUTH-') && isEnum(value.baseSeverity, ['LOW', 'MEDIUM', 'HIGH'])
    case 'HV-ID-AUTH-001.v1':
      return isTimestamp(value.disabledAt) && isTimestamp(value.activityAt) && isEnum(value.outcome, ['SUCCESS', 'FAILURE'])
    case 'HV-ID-AUTH-002.v1':
      return validBaseline(value.baseline) && isTimestamp(value.eventAt) && validStringOrNullTimestamp(value.lastSuccessfulInteractiveSignInAt) && isBoolean(value.successfulInteractive)
    case 'HV-ID-AUTH-003.v1':
      return validBaseline(value.baseline) && hasOnlyDataKeys(value.properties, ['country', 'asn', 'device', 'client', 'app']) &&
        (value.properties.country === undefined || (typeof value.properties.country === 'string' && /^[A-Za-z]{2}$/u.test(value.properties.country))) &&
        (value.properties.asn === undefined || isNonNegativeInteger(value.properties.asn)) &&
        (value.properties.device === undefined || isOpaqueIdentityReference(value.properties.device)) &&
        (value.properties.client === undefined || isCatalogValue(value.properties.client)) &&
        (value.properties.app === undefined || isOpaqueIdentityReference(value.properties.app)) &&
        (value.sourceFingerprint === undefined || isOpaqueIdentityReference(value.sourceFingerprint))
    case 'HV-ID-AUTH-004.v1':
      return validBaseline(value.baseline) && [value.previous, value.current].every((point) =>
        hasOnlyDataKeys(point, ['occurredAt', 'latitude', 'longitude', 'sourceFingerprint']) && isTimestamp(point.occurredAt) && isFiniteNumber(point.latitude) && isFiniteNumber(point.longitude) && (point.sourceFingerprint === undefined || isOpaqueIdentityReference(point.sourceFingerprint)))
    case 'HV-ID-AUTH-005.v1':
      return validAuthEvents(value.events)
    case 'HV-ID-AUTH-006.v1':
      return validAuthEvents(value.events) && isBoolean(value.normalizedMfaDetailComplete)
    case 'HV-ID-AUTH-007.v1':
      return isBoolean(value.privileged) && isBoolean(value.succeeded) && isCatalogValue(value.client)
    case 'HV-ID-AUTH-008.v1':
      return validAuthEvents(value.events) && isBoolean(value.tenantWideComplete)
    case 'HV-ID-AUTH-009.v1':
      return isBoolean(value.successfulInteractive) && isTimestamp(value.occurredAt)
  }
}

export function isIdentitySignalCandidateRuntime(value: unknown): value is IdentitySignalCandidate {
  if (!isPlainRecord(value)) return false
  const ruleDescriptor = Object.getOwnPropertyDescriptor(value, 'ruleId')
  if (!ruleDescriptor || !('value' in ruleDescriptor) || !isIdentitySignalRuleId(ruleDescriptor.value)) return false
  const ruleId = ruleDescriptor.value
  if (!hasOnlyDataKeys(value, [...BASE_FIELDS, ...RULE_FIELDS[ruleId]])) return false
  if (!validSubject(value.subject) ||
      !validStringArray(value.evidenceReferences, IDENTITY_SIGNAL_MAX_EVIDENCE_REFERENCES, (entry) => isOpaqueIdentityReference(entry, IDENTITY_SIGNAL_MAX_EVIDENCE_REFERENCE_LENGTH)) ||
      !validEvidence(value.evidence) || !isEnum(value.evidenceState, ['COMPLETE', 'PARTIAL', 'CAPPED', 'MALFORMED', 'UNAVAILABLE']) ||
      (value.requiresFullCapability !== undefined && !isBoolean(value.requiresFullCapability))) return false
  return validRuleCandidate(value, ruleId)
}

export function boundedRuntimeBytes(value: unknown, maximum: number): number | null {
  let bytes = 0
  let nodes = 0
  const seen = new WeakSet<object>()
  const visit = (entry: unknown, depth: number): boolean => {
    nodes += 1
    if (nodes > 20_000 || depth > 10) return false
    if (typeof entry === 'string') bytes += entry.length * 2
    else if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null || entry === undefined) bytes += 8
    else if (Array.isArray(entry)) {
      if (entry.length > MAX_CATALOG_VALUES || seen.has(entry)) return false
      seen.add(entry)
      bytes += 16
      for (let index = 0; index < entry.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, String(index))
        if (!descriptor || !('value' in descriptor) || !visit(descriptor.value, depth + 1)) return false
        if (bytes > maximum) return false
      }
    } else if (isPlainRecord(entry)) {
      if (seen.has(entry)) return false
      seen.add(entry)
      const keys = Reflect.ownKeys(entry)
      if (keys.length > MAX_CATALOG_VALUES) return false
      bytes += 16
      for (const key of keys) {
        if (typeof key !== 'string') return false
        const descriptor = Object.getOwnPropertyDescriptor(entry, key)
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false
        bytes += key.length * 2
        if (!visit(descriptor.value, depth + 1) || bytes > maximum) return false
      }
    } else return false
    return bytes <= maximum
  }
  return visit(value, 0) ? bytes : null
}

// Measures untrusted batch input without dereferencing accessors or traversing
// rejected prototypes. Unknown enumerable data fields are still charged, so a
// malformed object cannot hide an oversized payload behind schema rejection.
export function boundedInputBytes(value: unknown, maximum: number): number | null {
  let bytes = 0
  let nodes = 0
  const seen = new WeakSet<object>()
  const visit = (entry: unknown, depth: number): boolean => {
    nodes += 1
    if (nodes > 20_000 || depth > 10) return false
    if (typeof entry === 'string') bytes += entry.length * 2
    else if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null || entry === undefined) bytes += 8
    else if (Array.isArray(entry)) {
      if (entry.length > MAX_CATALOG_VALUES || seen.has(entry)) return false
      seen.add(entry)
      bytes += 16
      for (let index = 0; index < entry.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, String(index))
        if (descriptor && 'value' in descriptor && !visit(descriptor.value, depth + 1)) return false
        if (bytes > maximum) return false
      }
    } else if (typeof entry === 'object' && entry !== null) {
      if (seen.has(entry)) return true
      seen.add(entry)
      const keys = Reflect.ownKeys(entry)
      if (keys.length > MAX_CATALOG_VALUES) return false
      bytes += 16
      for (const key of keys) {
        if (typeof key !== 'string') continue
        bytes += key.length * 2
        const descriptor = Object.getOwnPropertyDescriptor(entry, key)
        if (descriptor && 'value' in descriptor && !visit(descriptor.value, depth + 1)) return false
        if (bytes > maximum) return false
      }
    } else bytes += 8
    return bytes <= maximum
  }
  return visit(value, 0) ? bytes : null
}
