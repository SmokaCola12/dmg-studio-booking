# Restoring DMG Studio from a backup

Backups are made by `npm run backup` (or the daily scheduled task) into `BACKUP_DIR` (default: `backups\` in the project
folder). Each one is a folder named `dmg-backup-YYYYMMDD-HHMMSS` (Manila time), or the same name ending in `.7z` when
`BACKUP_PASSPHRASE` is set and 7-Zip is installed.

Inside a backup:

| Item            | What it is                                  | Goes back to (default)        | Setting       |
| --------------- | ------------------------------------------- | ----------------------------- | ------------- |
| `studio.db`     | the database (bookings, studios, settings)  | `data\studio.db`              | `DB_PATH`     |
| `uploads\`      | gallery photos                              | `data\uploads\`               | `UPLOAD_DIR`  |
| `receipts\`     | private GCash payment screenshots           | `data\private\receipts\`      | `RECEIPT_DIR` |
| `manifest.json` | counts, sizes and the database checksum     | (not restored)                |               |

If `.env` sets `DB_PATH`, `UPLOAD_DIR` or `RECEIPT_DIR`, use those locations instead of the defaults below.

`.env` is NOT in the backup. Keep your own copy of it (and of the backup passphrase) somewhere safe.

## Check a backup (safe at any time, changes nothing)

```powershell
npm run backup:verify -- "backups\dmg-backup-20261116-043000"
```

It opens the backup's database read-only, runs an integrity check, compares the checksum with `manifest.json` and prints
how many bookings, studios and receipts it holds. `OK` and exit code 0 mean the backup can be restored. Do this once a
month, and always before a restore.

An encrypted `.7z` has to be extracted first (7-Zip asks for the passphrase):

```powershell
& "C:\Program Files\7-Zip\7z.exe" x "backups\dmg-backup-20261116-043000.7z" -o"backups\restore-test"
npm run backup:verify -- "backups\restore-test\dmg-backup-20261116-043000"
```

Delete `backups\restore-test` when you are done: it is an unencrypted copy of customer data.

## Restore

Run these in PowerShell from the project folder. Replace the backup name with the one you want.

1. **Stop the app.** Close the window running `npm start` (or stop the service). Nothing may be using the database.

2. **Check the backup** (extract it first if it is a `.7z`, see above):

   ```powershell
   $backup = "backups\dmg-backup-20261116-043000"
   npm run backup:verify -- $backup
   ```

   Stop here if it does not say `OK`, and try an older backup.

3. **Move the current data aside.** Do not delete it: it is your way back if the restore goes wrong.

   ```powershell
   Rename-Item data "data-before-restore-$(Get-Date -Format yyyyMMdd-HHmmss)"
   ```

   If this fails with "in use", the app is still running: go back to step 1.

4. **Put the backup in place.**

   ```powershell
   New-Item -ItemType Directory data, data\private | Out-Null
   Copy-Item "$backup\studio.db" data\studio.db
   Copy-Item "$backup\uploads" data\uploads -Recurse
   Copy-Item "$backup\receipts" data\private\receipts -Recurse
   ```

   If the backup has no `uploads` or `receipts` folder, skip that line: there were none.

5. **Delete stale `-wal` and `-shm` files.** They belong to the old database and would corrupt the restored one. After
   step 3 there should be none, but check, above all when `DB_PATH` points somewhere else:

   ```powershell
   Remove-Item data\studio.db-wal, data\studio.db-shm -ErrorAction SilentlyContinue
   ```

6. **Start the app.**

   ```powershell
   npm start
   ```

7. **Verify.**
   - The start-up line says `listening on ...` and shows no errors.
   - Open the site, then log in at `/admin`: today's schedule and recent bookings are there.
   - Open one GCash payment in the admin and check that its screenshot shows.
   - The gallery photos show on the home page.
   - Run `npm run check:env`: `GCash QR stored` says `yes`.

Bookings made after the backup was taken are not in it. Look them up in the folder you moved aside in step 3, or in the
studio inbox (new-booking emails), and enter them again by hand in the admin.

Once everything is confirmed, keep the `data-before-restore-...` folder for a week or two, then delete it.

## Going back

If the restore made things worse: stop the app, delete the new `data` folder, rename `data-before-restore-...` back to
`data`, start the app.
