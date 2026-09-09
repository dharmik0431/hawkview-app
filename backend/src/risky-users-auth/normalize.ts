import { isIP } from 'node:net';
import type { AuthNormalizationContext, AuthNormalizationResult, AuthOutcome } from './contract.js';

export function textValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
export function objectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** UTC source timestamps only. Reject unsupported sub-millisecond precision rather than rounding boundaries. */
export function utcTime(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3}|\.\d{3}0{1,4})?Z$/.test(value)) return null;
  const number = Date.parse(value);
  if (!Number.isFinite(number)) return null;
  return new Date(number).toISOString().slice(0, 19) === value.slice(0, 19) ? number : null;
}
export function canonicalAddress(value: unknown): string | null {
  if (!textValue(value) || value.includes('%')) return null;
  const version = isIP(value);
  if (version === 4) return value;
  if (version === 6) return new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();
  return null;
}
const emptyError = (value: unknown): boolean => value === undefined || value === null || value === '' || value === '0' || value === 'None';
const guid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const classify = (code: number): AuthOutcome => code === 50126 ? 'INVALID_CREDENTIAL' : code === 0 ? 'SUCCESS' : code === 50076 ? 'NON_QUALIFYING' : 'UNKNOWN';

export function normalizeAuthenticationRecord(record: unknown, context: AuthNormalizationContext): AuthNormalizationResult {
  const reject = (reason: string): AuthNormalizationResult => ({ status: 'REJECTED', reason });
  if (!objectValue(record) || !objectValue(context)) return reject('MALFORMED_RECORD');
  if (![context.organizationId, context.customerTenantId, context.microsoftTenantId].every(textValue)) return reject('INVALID_SCOPE');
  if (context.source !== 'GRAPH_SIGN_INS' && context.source !== 'M365_AUDIT_STS') return reject('UNSUPPORTED_SOURCE');
  const graph = context.source === 'GRAPH_SIGN_INS';
  const eventId = record[graph ? 'id' : 'Id'];
  const eventAt = utcTime(record[graph ? 'createdDateTime' : 'CreationTime']);
  const ingestedAt = utcTime(context.ingestedAt);
  if (!textValue(eventId) || eventAt === null || ingestedAt === null) return reject('INVALID_ID_OR_CLOCK');
  if (ingestedAt < eventAt) return reject('INGESTION_PRECEDES_EVENT');
  if (!graph && record.OrganizationId !== context.microsoftTenantId) return reject('TENANT_BINDING_MISMATCH');
  const subjectField = context.subject?.sourceField ?? (graph ? 'userId' : 'UserId');
  if (!objectValue(context.subject) || !['HUMAN', 'PRIVILEGED_HUMAN'].includes(context.subject.principalClass)
    || !textValue(context.subject.resolvedSubjectRef) || !textValue(context.subject.sourceUserId)
    || context.subject.conflictingIdentifiers === true
    || !(graph ? subjectField === 'userId' && guid(context.subject.sourceUserId) : subjectField === 'UserId')
    || (subjectField === 'UserId' && (context.subject.matchedBy !== 'EXACT_NORMALIZED_UPN' || context.subject.uniqueMatch !== true))
    || record[subjectField] !== context.subject.sourceUserId) return reject('UNRESOLVED_HUMAN');
  if (!graph && record.UserType !== 0 && record.UserType !== 2) return reject('UNSUPPORTED_PRINCIPAL_TYPE');
  const app = context.application;
  if (!objectValue(app) || app.qualified !== true || !textValue(app.applicationRef) || !textValue(app.sourceValue)
    || !(graph ? app.field === 'appId' : app.field === 'ApplicationId' || app.field === 'Application')
    || (app.field !== 'Application' && !guid(app.sourceValue))
    || record[app.field] !== app.sourceValue) return reject('INSUFFICIENT_APPLICATION_BINDING');

  let outcome: AuthOutcome = 'UNKNOWN';
  let errorCode: number | null = null;
  if (graph) {
    if (objectValue(record.status) && typeof record.status.errorCode === 'number' && Number.isSafeInteger(record.status.errorCode)) {
      errorCode = record.status.errorCode;
      outcome = classify(errorCode);
      if (errorCode === 0 && !emptyError(record.status.failureReason)) outcome = 'UNKNOWN';
      if (record.isInteractive === false) outcome = 'NON_QUALIFYING';
      else if (record.isInteractive !== undefined && record.isInteractive !== true) outcome = 'UNKNOWN';
    }
  } else {
    if (record.RecordType !== 15 || (record.Operation !== 'UserLoginFailed' && record.Operation !== 'UserLoggedIn')) return reject('UNSUPPORTED_STS_OPERATION');
    const codes: unknown[] = [];
    if (record.ErrorCode !== undefined) codes.push(record.ErrorCode);
    const logonErrors: unknown[] = [record.LogonError];
    if (record.ExtendedProperties !== undefined) {
      if (!Array.isArray(record.ExtendedProperties) || record.ExtendedProperties.length > 100) return reject('MALFORMED_STS_PROPERTIES');
      for (const property of record.ExtendedProperties) {
        if (!objectValue(property) || !textValue(property.Name)) return reject('MALFORMED_STS_PROPERTIES');
        if (property.Name === 'ErrorCode' || property.Name === 'ErrorNumber') codes.push(property.Value);
        if (property.Name === 'LogonError') logonErrors.push(property.Value);
      }
    }
    // No Boolean/numeric/string coercion. ResultStatus describes audit processing, not authentication proof.
    if (codes.length > 0 && codes.every(code => typeof code === 'string' && /^(0|[1-9]\d{0,8})$/.test(code)) && new Set(codes).size === 1) {
      errorCode = Number(codes[0]);
      outcome = classify(errorCode);
      const login = record.LoginStatus;
      if (outcome === 'SUCCESS') {
        if (record.Operation !== 'UserLoggedIn' || !logonErrors.every(emptyError)
          || (login !== undefined && login !== '0' && login !== 'Success' && login !== 'Succeeded')
          || (record.ResultStatus !== undefined && record.ResultStatus !== 'Success' && record.ResultStatus !== 'Succeeded')) outcome = 'UNKNOWN';
      } else if (outcome === 'INVALID_CREDENTIAL') {
        if (record.Operation !== 'UserLoginFailed'
          || !logonErrors.every(error => emptyError(error) || error === 'InvalidUserNameOrPassword')
          || (login !== undefined && login !== '50126' && login !== 'Failure' && login !== 'Failed')) outcome = 'UNKNOWN';
      }
    }
  }
  const client = context.clientSource;
  if (!objectValue(client) || !['QUALIFIED', 'MISSING', 'AMBIGUOUS', 'PROXY_ONLY'].includes(client.qualification)) return reject('INVALID_CLIENT_QUALIFICATION');
  const field = client.field ?? (graph ? 'ipAddress' : 'ClientIP');
  if (!(graph ? field === 'ipAddress' : field === 'ClientIP' || field === 'ActorIpAddress')) return reject('INVALID_CLIENT_FIELD');
  const address = client.qualification === 'QUALIFIED' ? canonicalAddress(record[field]) : null;
  const qualification = client.qualification === 'QUALIFIED' && address === null ? 'MISSING' : client.qualification;
  const mfa = context.eventMfa;
  const eventMfa = mfa && mfa.eventId === eventId && mfa.source === context.source
    && mfa.organizationId === context.organizationId && mfa.customerTenantId === context.customerTenantId && mfa.microsoftTenantId === context.microsoftTenantId
    && (mfa.fact === 'SATISFIED' || mfa.fact === 'NOT_SATISFIED') && textValue(mfa.evidenceRef)
    ? { fact: mfa.fact, evidenceRef: mfa.evidenceRef }
    : { fact: 'NOT_EVIDENCED' as const, evidenceRef: null };
  return { status: 'ACCEPTED', event: {
    organizationId: context.organizationId, customerTenantId: context.customerTenantId, microsoftTenantId: context.microsoftTenantId,
    source: context.source, eventId, eventAt: new Date(eventAt).toISOString(), ingestedAt: new Date(ingestedAt).toISOString(),
    subjectRef: context.subject.resolvedSubjectRef, applicationRef: app.applicationRef, outcome, errorCode,
    clientSource: { qualification, address }, eventMfa,
  } };
}
