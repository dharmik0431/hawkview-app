import assert from 'node:assert/strict'
/** In-memory SQL seam for legacy collector/geolocation tests. Real locking,
 * duplicate quarantine and window persistence have separate database tests. */
export function authenticationCollectorTransaction(createMany: (args:any)=>Promise<unknown>) {
  return {
    $executeRawUnsafe: async (sql:string) => {
      assert.ok(sql === "SET LOCAL TIME ZONE 'UTC'" || sql.includes('pg_advisory_xact_lock') || sql.includes("set_config('statement_timeout'"))
      return 1
    },
    $queryRawUnsafe: async (sql:string) => {
      if (sql === "SELECT current_setting('TimeZone') AS timezone") return [{timezone:'UTC'}]
      if (sql.includes('FROM sign_in_logs')) {assert.ok(sql.includes('organization_id=$1::uuid AND customer_tenant_id=$2::uuid')); return [{id:null,raw:null,bounded:true}]}
      assert.ok(sql.includes('FROM tenant_entra_snapshots'));assert.ok(sql.includes('FOR UPDATE'));return []
    },
    tenantEntraSnapshot:{upsert:async({create,update}:any)=>{assert.equal(create.resourceType,'SIGN_INS');assert.equal(update.payload.paginationComplete,true);return create}},
    signInLog:{createMany:async(args:any)=>{assert.equal(args.skipDuplicates,false);await createMany(args);return {count:args.data.length}}},
  }
}
