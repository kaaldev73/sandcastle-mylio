# Use sharp for image decoding and thumbnails

Generating thumbnails (and, later, previews for HEIC and RAW) needs an image codec, and the Node standard library has none. We add `sharp` (libvips) as the one image-processing dependency. We chose it over a pure-JS library because it is fast, handles the wide input set the PRD requires (JPEG/PNG now; HEIC/RAW/TIFF/WebP later), and ships prebuilt binaries for the `node:22-slim` (glibc) image, so the single-container build stays simple. This is a deliberate step away from the otherwise stdlib-first stack; the cost is a native dependency in the image. Capture-date extraction stays off sharp — a small in-repo EXIF reader keeps the metadata path dependency-free — so sharp is used only where an actual codec is unavoidable.

## Update: HEIC/HEIF previews

sharp's prebuilt libvips is compiled without the HEVC decoder (a licensing
choice), so while it reads HEIC metadata it cannot actually decode the pixels.
Uploads therefore fall back to `heic-decode`, a WebAssembly build of libheif
with an HEVC decoder, only when sharp and an embedded JPEG preview both fail.
The decoder is imported lazily so its sizeable wasm payload is not paid on the
common JPEG/PNG path. Camera RAW files that sharp cannot read directly use
their embedded JPEG preview the same way.
