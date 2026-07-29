import pg from 'pg'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required.')
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
})

await client.connect()

try {
  const tables = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `)

  const constraints = await client.query(`
    SELECT constraint_type, COUNT(*)::int AS count
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
    GROUP BY constraint_type
    ORDER BY constraint_type
  `)

  console.log(
    JSON.stringify(
      {
        database: 'connected',
        tables: tables.rows.map((row) => row.table_name),
        constraints: constraints.rows,
      },
      null,
      2
    )
  )
} finally {
  await client.end()
}
