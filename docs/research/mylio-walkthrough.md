# Mylio behaviour, from a public walkthrough

Source: "A smarter way to organise your photos? | Mylio explained" (YouTube, 24:48, https://www.youtube.com/watch?v=KYc6TImtRUk), via auto-captions. Third-party tutorial, not Mylio documentation; it covers what is said, not what is only shown on screen. Notes are paraphrased behaviour only (see ADR 0001).

## Navigation
- Left menu: All photos, Calendar (by year and month), Map, People (faces), Albums, Folders.
- Right panel: Info (metadata, keywords, flags), sharing/export, quick edits (crop, enhance, rotate).
- Zoom slider sets the thumbnail size.
- Active filters show as removable chips along the top.

## Concepts
- **Catalog**: stores tags, ratings, edits, face data without altering originals.
- **Folders** mirror real disk locations; moving a photo to a folder moves the file.
- **Albums** are virtual collections; one photo can be in many with no copy.
- **Spaces** (Personal, Family, Work, Private behind a PIN, Guest) are filters layered over one library. They hide or show folders, devices or albums. They do not duplicate or move files. Not shareable between different accounts.
- **Quick collections**: saved filter combinations.

## Behaviour
- Search: free-text bar plus filters (folders, people, dates); browse by area (folders, albums, map).
- Multi-select with shift-click range and ctrl/cmd-click.
- **Dedupe**: scans the library, shows groups side by side, flags identical and near-identical (resized, edited, renamed). Free tier can view but not delete.
- **Declutter**: groups burst shots by time interval and matching aspect ratio/camera; "auto mark" picks best by sharpness, open eyes, smiles, exposure, existing ratings; actions are delete marked, move marked, unmark all.
- **Quick review**: one photo at a time, arrow keys to move, P keep, X reject, 1-5 star rating; respects the current filter.
- Keywords (multi-select edit), AI "smart tags" suggestions, colour labels, star ratings.
- Faces: background scan, named/unnamed groups, batch confirm.
- "Save metadata to file" writes keywords, names, ratings into the file.
- Export with chosen format and optional metadata. Sync to other devices needs the paid tier and one account.

## Mapped onto our v1
Already in scope: timeline (Calendar), duplicate detection, date and place filter, upload/import.
Candidates not yet decided: albums, star rating and reject (Quick review), keywords, saved filters, burst declutter, map view, faces.
Naming: Mylio's "Space" is a view filter; Familio's Library owns Assets and carries access rules (see GLOSSARY.md).

## Cross-check against the official manual (manual.mylio.com, v24.3)
Index: https://manual.mylio.com/ . Pages read: spaces roles, duplicates, calendar, QuickFilters, file types, flags/stars/labels. Paraphrased.

- **Duplicates are exact only.** The manual says DeDupe matches identical files (same name or different, same folder or not, metadata may differ). Resized or visually similar images are *not* duplicates; those belong to Declutter. This corrects the video, which said "near duplicate". Photos only, not videos. Matches our hash-based v1.
- **Dedupe review**: list of files with copies, compare side by side, conflicting metadata highlighted, "auto-mark" picks the keeper (criteria undocumented), then "Delete Marked" or "Move Marked". Removing can merge metadata: single-value fields (title) keep the higher-priority copy, multi-value (keywords) are combined, album memberships kept.
- **Calendar** drills Decade → Year → Month → Day, each level with a cover photo. Which date field it uses is undocumented (we decide; EXIF capture date with file date as fallback is the obvious choice). Sort options vary by level.
- **QuickFilters** categories: rating/label/flag, SmartTag (eyes closed, smiling, blurry, exposure), keyword, folder, date (year, month, day, on this day, day of week, time of day, season, range), event, file type/extension/size, album, category, person, visual properties (ISO, aperture, orientation...), camera and lens. AND vs OR undocumented.
- **Rating**: flag (Pick, Reject, Unflagged), stars 1-5, colour labels (red, yellow, green, blue, purple). Rejected photos are dimmed by default and can be hidden; "delete rejected" is permanent and scoped to the current view. Reject maps to XMP rating -1.
- **Supported types**: photos JPEG, PNG, GIF, BMP, TIFF, WebP, HEIC/HEIF, PSD, plus many RAW (CR2, CR3, NEF, ARW, DNG, ORF, RAF, RW2...); videos MP4, MOV, MKV, AVI, M4V, 3GP, MTS and others; documents PDF, Office. RAW+JPEG pairs get special handling.
- **Space roles**: role presets and permission details exist only on the Family/Team plans and are shown as images in the manual, so they are not documented in text. We design our own roles.
- **Sync, devices, vaults, SecureCloud** are a large separate area; out of scope for a single-server design.
