# Week 4: A Credential in the Docs, My Own Migration Coming Back, and Planning the Next Phase

Ina Sharma
Roll No: 1024030866
12–18 October 2026

## 1 Context

This week we split the remaining SmartPrint work between Harbani and me, aiming for equal
effort and minimal overlap. My share: repository cleanup, admin user management, order
collection, order notifications, and application security and logging. Before starting the
security work, I started with the most basic security problem a repository can have: a secret
written into it.

## 2 Debugging: Deleting a Secret Doesn't Un-publish It

**Error encountered:** `SMARTPRINT_TECHNICAL_GUIDE.md` contained a real, old database password
inside an example `DATABASE_URL`, where a placeholder belonged.

**Relevant context:** the credential was obsolete, no longer used by any of our databases.
But the guide is committed and pushed to GitHub, so anyone who can read the repository can
read the guide.

**Key observation:** removing it from the current file (merged as PR #3) only fixes the
*latest version* of the file. The password is still there in every earlier commit that
contained the guide, starting with the Week 2 rescue commit, and anyone can read it with
`git log -p` or the GitHub history view. This is the same lesson as Harbani's Week 2 fork
problem, from the other direction. She learned that a large file removed in a later commit
still sits in history and blocks a push. A secret removed in a later commit still sits in
history and can still be read.

**Solution:** replaced the value with a placeholder in the guide. Because the credential is
obsolete, removing it from the current docs is enough for now, *as long as* that password
isn't reused anywhere else. If it were still live, the only real fix would be to **rotate**
it (change the password), since rewriting public history can't recall copies other people
have already pulled.

**Because** git is designed never to forget. Once a secret has been pushed, treat it as
compromised: change the secret, then clean up the files. Doing it the other way round leaves
a live password sitting in history.

## 3 My Own Migration Came Back to Haunt Me

While I worked on the docs, Harbani hit a failure setting the project up from a fresh clone:
`prisma migrate dev` stopped with P3006 because the type `"UserRole"` already existed. The
cause was mine. In Week 2 I dropped my first, flawed initial migration and generated a
corrected one, but the old migration's folder stayed in the repository. Prisma replays every
folder in timestamp order, so on a fresh database the abandoned draft ran first, and then my
real migration collided with it.

Harbani traced it, proved the old migration had never been applied on any working database,
and removed just that folder (PR #4). My part is to run `npx prisma migrate status` after
pulling, to confirm my database agrees with the cleaned-up history.

Reflection: this is the third "ghost" from the Week 2 rescue commit. The first two were the
parallel `src/modules/` backend and the stale `vite.config.js` that I removed in Week 3.
Harbani found the fourth, a whole generation of old frontend pages (PR #7). There's a symmetry
here: my Week 3 cleanup removed 37 old backend files, and her cleanup removed 15 old frontend
files that once talked to exactly those backend modules. Two generations of the project were
packed into one commit, and it took both of us, one from each side of the API, to unpack them.

## 4 Planning My Next Phase

Before writing new code, I mapped each of my five areas to what already exists:

- **Admin user management:** the backend's old `users` module is gone (Week 3). The frontend
  has no page that manages *all* users, since the current admin staff page only covers shop
  staff. Harbani removed the old `AdminUsers.tsx` page because it no longer compiled, but its
  last version is preserved in history as a reference
  (`git show 9987fb4^:code/frontend/src/pages/admin/AdminUsers.tsx`).
- **Order collection:** the order lifecycle already has `READY` and `COLLECTED` states, so
  the main new pieces are a pickup code and a staff-side verification step. The database
  migration for this has to be coordinated with Harbani's pagination indexes, so we don't
  create conflicting migrations.
- **Notifications:** an email service already exists in the backend, so the
  ready-for-collection email should go through it rather than starting a new one.
- **Security and logging:** two concrete items are already on the list. Rate limiting and
  security headers are standard. The less obvious one: the development seed gives every
  account the same published password, and nothing stops the seed script from running in
  production. A production guard belongs in my area.
- **Repository cleanup:** some of this is already done. The stale `tsbuildinfo` files are
  now ignored, and `mkdocs.yml` no longer points at a missing theme folder (both Harbani,
  PR #6 and #7). What's left is checking `.gitignore` coverage and the remaining docs.

## 5 Outcome

- Obsolete database credential removed from the technical guide (PR #3).
- The cause of the P3006 migration failure understood and fixed (PR #4 by Harbani, cause
  traced to my Week 2 migration).
- A concrete starting point for each of my five areas, including what already exists and
  where my work touches Harbani's.

## 6 Follow-ups

- Confirm that the old database password isn't reused anywhere; rotate it if it is.
- Run `npx prisma migrate status` on my database after pulling the migration fix.
- Add a production guard to `prisma/seed.ts`.
- Agree on migration ordering with Harbani before either of us adds a schema change.
