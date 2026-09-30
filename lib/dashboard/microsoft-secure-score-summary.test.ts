import assert from 'node:assert/strict'
import test from 'node:test'
import { microsoftSecureScoreAge, microsoftSecureScoreSummary } from './microsoft-secure-score-summary.ts'
test('finite boundary percentages include zero and round the distinct tenant average',()=>{
 assert.deepEqual(microsoftSecureScoreSummary([{id:'a',secureScore:0},{id:'b',secureScore:99}]),{value:'50%',detail:'Average across 2 tenants'})
 assert.equal(microsoftSecureScoreSummary([{id:'a',secureScore:100}]).value,'100%')
})
test('conflicting observations cannot select the convenient score in either order',()=>{
 for(const second of [80,null,undefined,NaN,'20'])for(const reverse of [false,true]){
  const rows=[{id:'a',secureScore:20},{id:'a',secureScore:second},{id:'b',secureScore:40}]
  assert.deepEqual(microsoftSecureScoreSummary(reverse?rows.reverse():rows),{value:'40%',detail:'Average across 1 of 2 tenants'})
 }
})
test('invalid identities and health scores cannot become Microsoft score evidence',()=>{
 const rows=[null,[],{},...['',' ',' a','a ','a\n','x'.repeat(257),null,1].map(id=>({id,secureScore:100})),{id:'valid',healthScore:100}]
 assert.deepEqual(microsoftSecureScoreSummary(rows),{value:'Unavailable',detail:'Scores available for 0 of 1 tenant'})
})

const now = Date.parse('2026-09-29T18:00:00.000Z')
const dated = (id: string, snapshotObservedAt = '2026-09-29T12:00:00.000Z') => ({ id, secureScore: 0,
  secureScoreDetails: { version: 1, percentage: 0, snapshotObservedAt, scoreCreatedAt: '2026-09-25T00:00:00.000Z', lastSuccessfulCollectionAt: '2026-09-29T17:59:00.000Z' } })
test('age uses oldest snapshot of every score contributor, not score creation or later successful collection', () => {
 const rows = [dated('a'), dated('b', '2026-09-29T17:00:00.000Z'), {id:'missing', secureScore:null}]
 const age = microsoftSecureScoreAge(rows, now)!
 assert.equal(age.label, 'Oldest collection: 6 hours ago')
 assert.match(age.description, /2026-09-29T12:00:00.000Z; 2026-09-29T17:00:00.000Z/)
 assert.match(age.description, /Oldest Microsoft score date: 2026-09-25T00:00:00.000Z/)
 assert.equal(microsoftSecureScoreAge([dated('a')], now + 3600000)?.label, 'Oldest collection: 7 hours ago')
 assert.equal(microsoftSecureScoreAge([{id:'a',secureScore:null}],now),null)
})
test('scalar-only and invalid/mismatched/future metadata cannot date an average', () => {
 for (const details of [undefined, null, [], {...dated('a').secureScoreDetails, version:2}, {...dated('a').secureScoreDetails,percentage:20},
  ...['bad','2026-02-30T12:00:00.000Z','2026-09-30T12:00:00.000Z','1969-01-01T00:00:00.000Z',null].map(snapshotObservedAt=>({...dated('a').secureScoreDetails,snapshotObservedAt})),
  {...dated('a').secureScoreDetails,scoreCreatedAt:'2026-09-29T13:00:00.000Z'}]) {
  const row={...dated('a'),secureScoreDetails:details,lastSync:'2026-09-29T17:59:00.000Z'}
  assert.equal(microsoftSecureScoreAge([row, dated('b')],now)?.label,'Collection date unavailable')
  assert.equal(microsoftSecureScoreSummary([row]).value,'0%')
 }
})
test('duplicate score dates must agree in either order; missing provider date does not invent score age', () => {
 for (const other of [dated('a','2026-09-29T13:00:00.000Z'),{id:'a',secureScore:0}]) {
  for(const rows of [[dated('a'),other],[other,dated('a')]]) assert.equal(microsoftSecureScoreAge(rows,now)?.label,'Collection date unavailable')
 }
 assert.equal(microsoftSecureScoreAge([dated('a'),dated('a')],now)?.label,'Oldest collection: 6 hours ago')
 const newerSuccess=dated('a'); newerSuccess.secureScoreDetails.lastSuccessfulCollectionAt='2026-09-29T18:00:00.000Z'
 assert.equal(microsoftSecureScoreAge([dated('a'),newerSuccess],now)?.label,'Oldest collection: 6 hours ago')
 const row=dated('a'); const age=microsoftSecureScoreAge([{...row,secureScoreDetails:{...row.secureScoreDetails,scoreCreatedAt:null,lastSuccessfulCollectionAt:null}}],now)!
 assert.equal(age.label,'Oldest collection: 6 hours ago'); assert.match(age.description,/Microsoft score date unavailable for 1 of 1/)
 assert.equal(microsoftSecureScoreAge([dated('a')],NaN)?.label,'Collection date unavailable')
})
