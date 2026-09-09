import type { EffectiveMfaEvaluationInput, MfaEvidenceState } from '../tenants/effective-mfa-enforcement.js';
import type { RiskProtectionDto } from './identity-risk-assessment.contract.js';
import { projectAssessmentProtection } from './risk-assessment-protection.js';
import { unknownRiskProtection } from './risk-assessment-projection.js';

type Scope = { organizationId: string; customerTenantId: string };
type ReadTransaction = typeof import('./mailbox-read-transaction.js')['withMailboxReadTransaction'];
type Load = (scope: Scope, userIds: readonly string[], evaluationAt: Date, deadlineAt: number) => Promise<ReadonlyMap<string, RiskProtectionDto>>;
const RESOURCES = ['CONDITIONAL_ACCESS', 'AUTHENTICATION_STRENGTHS', 'AUTH_REGISTRATIONS', 'DIRECTORY_ROLES', 'SECURITY_DEFAULTS'] as const;
type Resource = typeof RESOURCES[number];
const MAX_AGE = 26 * 3600000;
const SOURCE_BYTES = 180000;
const TOTAL_BYTES = 1000000;
const INPUT_ROWS: Record<Resource, number> = { CONDITIONAL_ACCESS: 100, AUTHENTICATION_STRENGTHS: 100, AUTH_REGISTRATIONS: 10000, DIRECTORY_ROLES: 1000, SECURITY_DEFAULTS: 1 };
const OUTPUT_ROWS: Record<Resource, number> = { ...INPUT_ROWS, AUTH_REGISTRATIONS: 100 };
const guid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (): MfaEvidenceState => ({ status: 'MISSING', observedAt: null, reason: null });
function time(value: unknown): number | null {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  return value.getTime();
}
function idsFor(scope: Scope, userIds: readonly string[], evaluationAt: Date): string[] | null {
  if (!scope || !guid(scope.organizationId) || !guid(scope.customerTenantId) || time(evaluationAt) === null
    || !Array.isArray(userIds) || userIds.length > 1000 || !userIds.every(guid)) return null;
  const ids = [...new Set(userIds.map((id: string) => id.toLowerCase()))];
  return ids.length <= 100 ? ids : null;
}
const unknowns = (ids: readonly string[]): ReadonlyMap<string, RiskProtectionDto> => new Map(ids.map(id => [id, unknownRiskProtection()]));

interface ScopeRow extends Scope {
  microsoftTenantId: string;
  organizationStatus: string; tenantStatus: string; connectionStatus: string;
  usersSyncStatus: string | null; usersLastSuccessfulAt: Date | null; usersLastAttemptAt: Date | null;
  usersUpdatedAt: Date | null; usersGenerationValid: boolean;
}
interface UserRow extends Scope { microsoftUserId: string; userType: string; userGenerationValid: boolean }
interface SourceRow extends Scope {
  resourceType: Resource; observedAt: Date | null; syncStatus: string | null;
  lastSuccessfulAt: Date | null; lastAttemptAt: Date | null; syncUpdatedAt: Date | null;
  generationValid: boolean; shapeValid: boolean; capped: boolean; payloadBytes: number; payload: unknown;
}

const SCOPE_SQL = `/* protection:scope */
  SELECT t.organization_id AS "organizationId", t.id AS "customerTenantId", t.microsoft_tenant_id AS "microsoftTenantId",
    o.status::text AS "organizationStatus", t.status::text AS "tenantStatus", c.status::text AS "connectionStatus",
    y.status::text AS "usersSyncStatus", y.last_successful_at AS "usersLastSuccessfulAt",
    y.last_attempt_at AS "usersLastAttemptAt", y.updated_at AS "usersUpdatedAt",
    COALESCE(y.status='SUCCEEDED' AND y.last_successful_at <= $3::timestamptz
      AND y.last_successful_at >= $3::timestamptz - interval '26 hours'
      AND (y.last_attempt_at IS NULL OR y.last_attempt_at <= y.last_successful_at)
      AND y.updated_at <= $3::timestamptz, false) AS "usersGenerationValid"
  FROM customer_tenants t JOIN organizations o ON o.id=t.organization_id
  JOIN tenant_connections c ON c.organization_id=t.organization_id AND c.customer_tenant_id=t.id
  LEFT JOIN sync_states y ON y.organization_id=t.organization_id AND y.customer_tenant_id=t.id AND y.resource_type='USERS'
  WHERE t.organization_id=$1::uuid AND t.id=$2::uuid AND o.status='ACTIVE' AND t.status='ACTIVE' AND c.status='CONNECTED' LIMIT 2`;
const USERS_SQL = `/* protection:users */
  SELECT u.organization_id AS "organizationId", u.customer_tenant_id AS "customerTenantId", u.microsoft_user_id AS "microsoftUserId",
    CASE WHEN u.user_type IN ('Member','Guest') THEN u.user_type ELSE 'Unknown' END AS "userType",
    COALESCE(y.status='SUCCEEDED' AND y.last_successful_at <= $4::timestamptz
      AND y.last_successful_at >= $4::timestamptz - interval '26 hours'
      AND (y.last_attempt_at IS NULL OR y.last_attempt_at <= y.last_successful_at)
      AND u.last_seen_at <= y.last_successful_at AND u.updated_at <= y.last_successful_at AND u.updated_at <= $4::timestamptz
      AND y.updated_at <= $4::timestamptz, false) AS "userGenerationValid"
  FROM directory_users u JOIN sync_states y ON y.organization_id=u.organization_id AND y.customer_tenant_id=u.customer_tenant_id AND y.resource_type='USERS'
  WHERE u.organization_id=$1::uuid AND u.customer_tenant_id=$2::uuid AND u.microsoft_user_id=ANY($3::uuid[])
    AND u.deleted_at IS NULL AND u.user_type IN ('Member','Guest') ORDER BY u.microsoft_user_id LIMIT 101`;

// Shape/count/byte gates occur in PostgreSQL before JSON crosses the driver boundary.
// Five <=180KB source payloads plus <=100 tiny directory rows and fixed metadata stay below 1MB.
const SNAPSHOT_SQL = `/* protection:snapshot */
  WITH source AS MATERIALIZED (
    SELECT q.organization_id, q.customer_tenant_id, q.resource_type, s.payload, s.observed_at,
      y.status::text AS sync_status, y.last_successful_at, y.last_attempt_at, y.updated_at,
      CASE WHEN jsonb_typeof(s.payload)='array' THEN
        jsonb_array_length(s.payload) <= $4::integer AND octet_length(s.payload::text) <= $5::integer
        ELSE false END AS shape_valid,
      COALESCE(y.status='SUCCEEDED' AND s.observed_at <= $7::timestamptz
        AND s.observed_at >= $7::timestamptz - interval '26 hours'
        AND y.last_successful_at >= s.observed_at AND s.updated_at <= y.last_successful_at AND y.last_successful_at <= $7::timestamptz
        AND y.last_successful_at >= $7::timestamptz - interval '26 hours'
        AND (y.last_attempt_at IS NULL OR y.last_attempt_at <= y.last_successful_at)
        AND y.updated_at <= $7::timestamptz, false) AS generation_valid
    FROM (SELECT $1::uuid AS organization_id, $2::uuid AS customer_tenant_id, $3::text AS resource_type) q
    LEFT JOIN sync_states y ON y.organization_id=q.organization_id AND y.customer_tenant_id=q.customer_tenant_id AND y.resource_type::text=q.resource_type
    LEFT JOIN tenant_entra_snapshots s ON s.organization_id=q.organization_id AND s.customer_tenant_id=q.customer_tenant_id AND s.resource_type::text=q.resource_type
  ), selected AS MATERIALIZED (
    SELECT source.*, CASE WHEN shape_valid AND generation_valid THEN
      (SELECT COALESCE(jsonb_agg(item.projected), '[]'::jsonb) FROM (
        SELECT CASE $3::text
          WHEN 'AUTH_REGISTRATIONS' THEN jsonb_build_object('id', row->'id', 'isMfaRegistered', row->'isMfaRegistered',
            'perUserMfaState', row->'perUserMfaState', 'conditionalAccessContext',
            CASE WHEN jsonb_typeof(row->'conditionalAccessContext')='object' THEN jsonb_build_object(
              'transitiveGroupIds', row#>'{conditionalAccessContext,transitiveGroupIds}',
              'membershipComplete', row#>'{conditionalAccessContext,membershipComplete}',
              'observedAt', row#>'{conditionalAccessContext,observedAt}',
              'reasonCode', CASE WHEN row#>>'{conditionalAccessContext,reasonCode}'='PERMISSION_LIMITED' THEN 'PERMISSION_LIMITED' ELSE NULL END) ELSE NULL END)
          WHEN 'DIRECTORY_ROLES' THEN jsonb_build_object('principalId', row->'principalId', 'roleDefinition', jsonb_build_object('templateId', row#>'{roleDefinition,templateId}'))
          WHEN 'SECURITY_DEFAULTS' THEN jsonb_build_object('isEnabled', row->'isEnabled')
          ELSE row END AS projected
        FROM jsonb_array_elements(CASE WHEN shape_valid AND generation_valid THEN payload ELSE '[]'::jsonb END) AS rows(row)
        WHERE $3::text <> 'AUTH_REGISTRATIONS' OR lower(row->>'id')=ANY($8::text[])
        LIMIT ($9::integer + 1)
      ) item) ELSE NULL END AS candidate FROM source
  )
  SELECT organization_id AS "organizationId", customer_tenant_id AS "customerTenantId", resource_type AS "resourceType",
    observed_at AS "observedAt", sync_status AS "syncStatus", last_successful_at AS "lastSuccessfulAt",
    last_attempt_at AS "lastAttemptAt", updated_at AS "syncUpdatedAt", generation_valid AS "generationValid", shape_valid AS "shapeValid",
    CASE WHEN candidate IS NOT NULL THEN jsonb_array_length(candidate)>$9::integer OR octet_length(candidate::text)>$6::integer
      ELSE COALESCE(NOT shape_valid, false) END AS capped,
    CASE WHEN candidate IS NOT NULL AND jsonb_array_length(candidate)<=$9::integer AND octet_length(candidate::text)<=$6::integer THEN candidate ELSE NULL END AS payload,
    CASE WHEN candidate IS NOT NULL AND jsonb_array_length(candidate)<=$9::integer AND octet_length(candidate::text)<=$6::integer THEN octet_length(candidate::text) ELSE 0 END AS "payloadBytes"
  FROM selected LIMIT 2`;

function sameScope(scope: Scope, row: Scope): boolean { return row.organizationId === scope.organizationId && row.customerTenantId === scope.customerTenantId; }
function sourceEvidence(row: SourceRow | undefined, now: number): MfaEvidenceState {
  if (!row) return missing();
  const stamp = time(row.observedAt), success = time(row.lastSuccessfulAt), attempt = time(row.lastAttemptAt), updated = time(row.syncUpdatedAt);
  const observedAt = stamp !== null && stamp <= now ? new Date(stamp).toISOString() : null;
  if (row.syncStatus === 'FAILED') return { status: 'FAILED', observedAt, reason: null };
  if (row.syncStatus !== 'SUCCEEDED' || stamp === null || success === null || updated === null || stamp > now || success > now || updated > now
    || success < stamp || (attempt !== null && attempt > success)) return missing();
  if (now - stamp > MAX_AGE || now - success > MAX_AGE) return { status: 'STALE', observedAt, reason: null };
  if (row.generationValid !== true || row.shapeValid !== true || row.capped || !Array.isArray(row.payload)) return missing();
  return { status: 'FRESH', observedAt, reason: null };
}
function membership(registration: Record<string, unknown> | null, source: MfaEvidenceState, now: number): { ids: string[] | null; evidence: MfaEvidenceState } {
  if (source.status !== 'FRESH') return { ids: null, evidence: source };
  const context = registration && record(registration.conditionalAccessContext) ? registration.conditionalAccessContext : null;
  const ids = context?.transitiveGroupIds;
  const observedAt = typeof context?.observedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(context.observedAt)
    && Number.isFinite(Date.parse(context.observedAt))
    && new Date(context.observedAt).toISOString().slice(0, 19) === context.observedAt.slice(0, 19)
    && Date.parse(context.observedAt) <= Date.parse(source.observedAt!) ? context.observedAt : null;
  if (context?.membershipComplete === true && observedAt !== null && Array.isArray(ids) && ids.length <= 1000 && ids.every(guid)) {
    return { ids: [...new Set(ids.map((id: string) => id.toLowerCase()))], evidence: { status: now - Date.parse(observedAt) > MAX_AGE ? 'STALE' : 'FRESH', observedAt, reason: null } };
  }
  return { ids: null, evidence: { status: context?.reasonCode === 'PERMISSION_LIMITED' ? 'PERMISSION_LIMITED' : registration ? 'FAILED' : 'MISSING', observedAt, reason: null } };
}

/** Injection seam for synthetic tests. Production uses the approved transaction helper below. */
export function createAssessmentProtectionLoader(readTransaction: ReadTransaction): Load {
  return async (scope, userIds, evaluationAt, deadlineAt) => {
    const ids = idsFor(scope, userIds, evaluationAt);
    if (ids === null || ids.length === 0) return new Map();
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt - Date.now() < 100) return unknowns(ids);
    try {
      return await readTransaction(deadlineAt, 12000, async (client, transactionDeadlineAt) => {
        const remaining = async (): Promise<void> => {
          const milliseconds = Math.min(5000, transactionDeadlineAt - Date.now() - 50);
          if (milliseconds < 1) throw new Error('PROTECTION_SOURCE_UNAVAILABLE');
          await client.query("SELECT set_config('statement_timeout', $1, true)", [String(milliseconds)]);
        };
        await remaining();
        const scopes = (await client.query<ScopeRow>(SCOPE_SQL, [scope.organizationId, scope.customerTenantId, evaluationAt])).rows;
        const tenant = scopes[0];
        if (scopes.length !== 1 || !tenant || !sameScope(scope, tenant) || !guid(tenant.microsoftTenantId)
          || tenant.organizationStatus !== 'ACTIVE' || tenant.tenantStatus !== 'ACTIVE' || tenant.connectionStatus !== 'CONNECTED') return unknowns(ids);
        const now = evaluationAt.getTime(), success = time(tenant.usersLastSuccessfulAt), attempt = time(tenant.usersLastAttemptAt), updated = time(tenant.usersUpdatedAt);
        if (tenant.usersGenerationValid !== true || tenant.usersSyncStatus !== 'SUCCEEDED' || success === null || updated === null
          || success > now || updated > now || now - success > MAX_AGE || (attempt !== null && attempt > success)) return unknowns(ids);
        await remaining();
        const users = (await client.query<UserRow>(USERS_SQL, [scope.organizationId, scope.customerTenantId, ids, evaluationAt])).rows;
        if (users.length > 100 || users.some(user => !sameScope(scope, user) || !guid(user.microsoftUserId) || !ids.includes(user.microsoftUserId.toLowerCase()))) return unknowns(ids);
        const sources = new Map<Resource, SourceRow>();
        for (const resource of RESOURCES) {
          await remaining();
          const rows = (await client.query<SourceRow>(SNAPSHOT_SQL, [scope.organizationId, scope.customerTenantId, resource, INPUT_ROWS[resource], 8000000, SOURCE_BYTES, evaluationAt, ids, OUTPUT_ROWS[resource]])).rows;
          if (rows.length > 1 || rows.some(row => !sameScope(scope, row) || row.resourceType !== resource || !Number.isSafeInteger(row.payloadBytes) || row.payloadBytes < 0 || row.payloadBytes > SOURCE_BYTES)) throw new Error('PROTECTION_SOURCE_UNAVAILABLE');
          if (rows[0]) sources.set(resource, rows[0]);
        }
        if (Buffer.byteLength(JSON.stringify([tenant, users, [...sources.values()]]), 'utf8') > TOTAL_BYTES) throw new Error('PROTECTION_SOURCE_UNAVAILABLE');
        const states = new Map(RESOURCES.map(resource => [resource, sourceEvidence(sources.get(resource), now)]));
        const payload = (resource: Resource): unknown[] => states.get(resource)!.status === 'FRESH' ? sources.get(resource)!.payload as unknown[] : [];
        const registrations = new Map<string, Record<string, unknown> | null>();
        for (const row of payload('AUTH_REGISTRATIONS')) {
          if (!record(row) || !guid(row.id)) continue;
          const id = row.id.toLowerCase();
          if (ids.includes(id)) registrations.set(id, registrations.has(id) ? null : row);
        }
        const roles = new Map<string, string[]>();
        let roleShapeValid = true;
        for (const assignment of payload('DIRECTORY_ROLES')) {
          if (!record(assignment) || !guid(assignment.principalId) || !record(assignment.roleDefinition) || !guid(assignment.roleDefinition.templateId)) { roleShapeValid = false; continue; }
          const principal = assignment.principalId.toLowerCase();
          roles.set(principal, [...(roles.get(principal) ?? []), assignment.roleDefinition.templateId.toLowerCase()]);
        }
        const securityRows = payload('SECURITY_DEFAULTS');
        const securityDefaults = securityRows.length === 1 && record(securityRows[0]) ? securityRows[0] : null;
        const output = new Map<string, RiskProtectionDto>();
        for (const id of ids) {
          const matched = users.filter(user => user.microsoftUserId.toLowerCase() === id);
          const user = matched[0];
          if (matched.length !== 1 || !user || user.userGenerationValid !== true || !['Member', 'Guest'].includes(user.userType)) { output.set(id, unknownRiskProtection()); continue; }
          const registration = registrations.get(id) ?? null;
          const member = membership(registration, states.get('AUTH_REGISTRATIONS')!, now);
          // A missing group closure can hide a group-assigned role exclusion. Do not treat direct roles as the whole set.
          const roleEvidence = !roleShapeValid ? { status: 'FAILED' as const, observedAt: states.get('DIRECTORY_ROLES')!.observedAt, reason: null }
            : states.get('DIRECTORY_ROLES')!.status !== 'FRESH' ? states.get('DIRECTORY_ROLES')!
            : member.evidence.status !== 'FRESH' ? member.evidence
            : { ...states.get('DIRECTORY_ROLES')!, observedAt: new Date(Math.min(Date.parse(states.get('DIRECTORY_ROLES')!.observedAt!), Date.parse(member.evidence.observedAt!))).toISOString() };
          const activeRoleTemplateIds = roleEvidence.status === 'FRESH' ? [...new Set([id, ...(member.ids ?? [])].flatMap(principal => roles.get(principal) ?? []))] : null;
          const ca: EffectiveMfaEvaluationInput = {
            subject: { id, userType: user.userType as 'Member' | 'Guest', externalTenantId: null, transitiveGroupIds: member.ids, activeRoleTemplateIds },
            policies: payload('CONDITIONAL_ACCESS'), authenticationStrengths: payload('AUTHENTICATION_STRENGTHS'), now: evaluationAt,
            evidence: { policies: states.get('CONDITIONAL_ACCESS')!, authenticationStrengths: states.get('AUTHENTICATION_STRENGTHS')!, membership: member.evidence, roles: roleEvidence },
          };
          output.set(id, projectAssessmentProtection(ca, { registration, registrationEvidence: states.get('AUTH_REGISTRATIONS')!, securityDefaults, securityDefaultsEvidence: states.get('SECURITY_DEFAULTS')! }));
        }
        if (Date.now() >= transactionDeadlineAt) throw new Error('PROTECTION_SOURCE_UNAVAILABLE');
        return output;
      });
    } catch { return unknowns(ids); }
  };
}

export const loadAssessmentProtection: Load = async (scope, userIds, evaluationAt, deadlineAt) => {
  const ids = idsFor(scope, userIds, evaluationAt);
  if (ids === null || ids.length === 0) return new Map();
  try {
    const { withMailboxReadTransaction } = await import('./mailbox-read-transaction.js');
    return await createAssessmentProtectionLoader(withMailboxReadTransaction)(scope, ids, evaluationAt, deadlineAt);
  } catch { return unknowns(ids); }
};
