import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import 'dotenv/config';

import { prisma } from '../src/config/prisma';
import { hashPassword } from '../src/utils/password';
import { normalizeEmail } from '../src/utils/validation';

// Bulk-provisions FACULTY accounts from the department faculty CSV
// (columns: S. No., Name, Designation, Email Address).
//
//   npx ts-node scripts/importFaculty.ts [csvPath]            # dry run (default)
//   npx ts-node scripts/importFaculty.ts [csvPath] --apply    # writes to the DB
//
// Free printing itself is not decided here - it is derived from the
// FACULTY role at order time (shop.service.ts::isFreeFacultyShop). This
// script only makes sure each person in the list holds that role.
//
// Passwords: nobody is given a usable password. Each new account gets a
// random one nobody sees; faculty sign in through "Forgot password", which
// emails a one-hour reset link to their own thapar.edu inbox. That also
// proves they own the address.

const DEFAULT_CSV = path.resolve(__dirname, '../../../docs/Thapar_CSE_Faculty_List.csv');
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Minimal RFC-4180 parser: handles quoted fields containing commas
// ("Professor & Head, Dean DCT") and a leading UTF-8 BOM.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const csvPath = path.resolve(args.find((a) => !a.startsWith('--')) ?? DEFAULT_CSV);

  const [, ...records] = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const seen = new Set<string>();
  const counts = { created: 0, promoted: 0, alreadyFaculty: 0, skipped: 0 };

  for (const [serial, rawName, , rawEmail] of records) {
    const label = `#${serial?.trim()} ${rawName?.trim()}`;
    // Spreadsheet exports sometimes contain stray spaces inside an address
    // ("manpreet.singh1 @thapar.edu") - removing them is the only repair
    // attempted; anything still malformed is skipped, never guessed.
    const email = normalizeEmail((rawEmail ?? '').replace(/\s+/g, ''));
    const name = (rawName ?? '').trim();

    if (!name || !EMAIL_SHAPE.test(email)) {
      console.log(`SKIP    ${label}: missing or invalid email "${(rawEmail ?? '').trim()}"`);
      counts.skipped++;
      continue;
    }
    if ((rawEmail ?? '').trim() !== email) {
      console.log(`FIXED   ${label}: "${(rawEmail ?? '').trim()}" -> "${email}"`);
    }
    if (seen.has(email)) {
      console.log(`SKIP    ${label}: duplicate of an earlier row (${email})`);
      counts.skipped++;
      continue;
    }
    seen.add(email);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing?.role === 'FACULTY') {
      counts.alreadyFaculty++;
      continue;
    }
    // A faculty member may already have self-registered as a STUDENT with
    // their thapar.edu address; promote that account (orders and documents
    // stay attached). Any other role (ADMIN, SHOP_STAFF) is never touched.
    if (existing) {
      if (existing.role !== 'STUDENT') {
        console.log(`SKIP    ${label}: ${email} already exists as ${existing.role}`);
        counts.skipped++;
        continue;
      }
      console.log(`PROMOTE ${label}: ${email} STUDENT -> FACULTY`);
      if (apply) {
        await prisma.user.update({ where: { userId: existing.userId }, data: { role: 'FACULTY' } });
      }
      counts.promoted++;
      continue;
    }

    if (apply) {
      await prisma.user.create({
        data: {
          name,
          email,
          passwordHash: await hashPassword(randomBytes(24).toString('base64url')),
          role: 'FACULTY',
          status: 'ACTIVE',
        },
      });
    }
    counts.created++;
  }

  console.log(
    `\n${apply ? 'APPLIED' : 'DRY RUN (nothing written; re-run with --apply)'}: ` +
      `${counts.created} to create, ${counts.promoted} promoted from STUDENT, ` +
      `${counts.alreadyFaculty} already faculty, ${counts.skipped} skipped`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
