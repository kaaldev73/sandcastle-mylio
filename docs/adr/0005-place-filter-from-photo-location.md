# Filter by place using the photo's own coordinates

Location comes from the photo's metadata, and a Member wants to find photos "from somewhere". The Library and Timeline views need a location filter, but the browser has no map view yet and the product carries no geocoder.

## Decision

* Location is Extracted at ingestion from the file's own EXIF GPS tags and stored on the Asset as two derived columns (`latitude`, `longitude`, decimal signed degrees); the original is never rewritten. A photo without GPS keeps NULLs in both columns.
* Location is only decoded by the same in-repo EXIF reader as the capture date; `sharp` is not used as a metadata parser.
* Filtering by place means a point plus a radius in kilometres (`lat`/`latitude` + `lon`/`lng`/`longitude`, or `place="lat,lon"` with `radiusKm`, 100 km default), matched as a bounding box around the point rather than a great-circle arc. A bounding box needs no math extensions in SQLite and never wrongly excludes a photo at the nominal radius; it may include a diagonal near-miss, which is the right bias for a place finder.
* There is no place-name search: resolving "Paris" to coordinates would need a geocoder and the map view is out of scope. Place is therefore only expressible as coordinates, which the browser (and later the map) can supply from a point the user picks.
* The filter is one more clause in the shared Asset listing scope, so the grid, the Timeline, the single-Asset neighbours and the Quick review queue all honour it consistently.
* Assets with no location data are never hidden by anything except an explicit location filter; they stay in the unfiltered grid and Timeline and can be selected with `withoutLocation=true`.

## Consequences

* GPS reads work for JPEG and for TIFF-based camera files (the common RAW containers), since both are TIFF structures.
* Coordinate rounding (6 decimal places, ~11 cm) bounds storage size and search precision at family scale.
* A stricter great-circle match, reverse-geocoded place names and a map view remain open for the Map slice.
