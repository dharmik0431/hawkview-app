import { randomUUID } from 'node:crypto'
import pg from 'pg'

const [emailArgument, organizationSlug = 'ssh-tech'] = process.argv.slice(2)
const email = emailArgument?.trim().toLowerCase()

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required.')
}

if (!email) {
  throw new Error(
    'Usage: npm run db:assign-owner -- user@example.com [organization-slug]'
  )
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
})

await client.connect()

try {
  await client.query('BEGIN')

  const userResult = await client.query(
    `
      SELECT id, email
      FROM users
      WHERE LOWER(email) = $1
      FOR UPDATE
    `,
    [email]
  )
  const organizationResult = await client.query(
    `
      SELECT id, name, slug
      FROM organizations
      WHERE slug = $1
      FOR UPDATE
    `,
    [organizationSlug]
  )

  if (userResult.rowCount !== 1) {
    throw new Error(`No HawkView user exists for ${email}.`)
  }

  if (organizationResult.rowCount !== 1) {
    throw new Error(`No organization exists with slug ${organizationSlug}.`)
  }

  const user = userResult.rows[0]
  const organization = organizationResult.rows[0]

  await client.query(
    `
      INSERT INTO memberships (
        id,
        user_id,
        organization_id,
        role,
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, 'MSP_OWNER', 'ACTIVE', NOW(), NOW())
      ON CONFLICT (user_id, organization_id)
      DO UPDATE SET
        role = 'MSP_OWNER',
        status = 'ACTIVE',
        updated_at = NOW()
    `,
    [randomUUID(), user.id, organization.id]
  )

  await client.query(
    `
      UPDATE users
      SET platform_role = 'PLATFORM_ADMIN', updated_at = NOW()
      WHERE id = $1
    `,
    [user.id]
  )

  await client.query('COMMIT')

  console.log(
    JSON.stringify(
      {
        user: user.email,
        organization: organization.name,
        membershipRole: 'MSP_OWNER',
        platformRole: 'PLATFORM_ADMIN',
      },
      null,
      2
    )
  )
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  await client.end()
}
