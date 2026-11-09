# Original database bootstrap

These are byte-for-byte copies of the base backups supplied in the installed
`CONMASSERVER/Tools/db` directory, included at the user's request. They contain
the original schema and seed data, not an export of the running Node databases.
They have not been sanitized or converted. Sizes, source paths and SHA-256
hashes are recorded in [source-manifest.json](source-manifest.json).

| File                 | Database    | Format    | Original dump version |
| -------------------- | ----------- | --------- | --------------------- |
| `irepodbBase.dump`   | `irepodb`   | Plain SQL | PostgreSQL 16.3       |
| `irepowbdbBase.dump` | `irepowbdb` | Plain SQL | PostgreSQL 12.7       |

Despite their extensions, restore these files with `psql`, not `pg_restore`.
Use PostgreSQL 16 and an account authorized to create databases and apply the
original ownership statements. The roles named in the dumps must already exist.
Configure your connection through PostgreSQL's normal environment or password
file; do not put credentials in this repository.

For a **new installation with neither database present**, review the SQL first,
then run from the repository root:

```sh
createdb irepodb
psql -X --set=ON_ERROR_STOP=on --single-transaction --dbname=irepodb --file=database/irepodbBase.dump
createdb irepowbdb
psql -X --set=ON_ERROR_STOP=on --single-transaction --dbname=irepowbdb --file=database/irepowbdbBase.dump
```

Do not apply these backups over existing customer databases. The original
backups predate some structures used by Node: after configuring a private
`.env`, review `src/prepare-database.ts` and apply `pnpm db:prepare` as a separate
authorized installation step. Sample imports are optional and separate.

This change copies and checks the supplied files; it does not create or restore
databases, apply schema changes, or verify a fresh installation. Other local
backups and runtime database exports remain Git-ignored. The supplied files
remain subject to the original installation's licensing terms.
