# Familio

Familio is a self-hosted server where a family stores, organizes and browses all their photos and videos in one place. Its behaviour is inspired by Mylio; the product has its own name and code.

## People and places

**Member**:
A person with an account, created by an admin invitation.
_Avoid_: User, account, customer

**Admin**:
A Member who can invite and remove Members and manage the server.
_Avoid_: Owner, superuser

**Library**:
A collection of Assets with its own access rule. Either a Member's private Library or the shared Family Library.
_Avoid_: Space, folder, gallery

**Family Library**:
The one Library every Member can view and add to.
_Avoid_: Shared library, public

## Media

**Asset**:
A single photo or video stored on the server, with its original file kept untouched.
_Avoid_: Media, file, item, image

**Timeline**:
The date-ordered view of the Assets in a Library, drilling from year to month to day.
_Avoid_: Feed, gallery, calendar

**Album**:
A named, virtual grouping of Assets within a Library; one Asset can be in many Albums and nothing is copied.
_Avoid_: Folder, collection

**Rating**:
A Member's judgement of an Asset: a Pick or Reject flag and/or 1-5 stars.
_Avoid_: Score, favourite

## Getting media in

**Upload**:
A Member adding Assets to a Library through the browser.
_Avoid_: Sync, backup

**Server Import**:
Adding Assets into a Library from a folder already on the server.
_Avoid_: Scan, ingest

**Duplicate**:
Two Assets in the same Library whose original files are byte-identical.
_Avoid_: Copy, similar image

## Relationships

- A **Member** has one private **Library** and can access the **Family Library**.
- An **Asset** belongs to exactly one **Library**; an **Album** belongs to one **Library**.
- A **Timeline** is a view of one **Library**, not a stored thing.
- Mylio's "Space" is a view filter over one library; Familio's **Library** owns Assets and carries access rules, so the two are not the same.
