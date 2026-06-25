// src/tools/limits.ts — shared file-size limits for the read-only tools.
//
// A single MAX_FILE_BYTES cap shared by `read_file` and `grep` so a file `grep` can cite is not one
// `read_file` then refuses to open (the caps used to be 1MB vs 2MB — a greppable-but-unreadable
// dead-end). `read_file` applies this cap only to WHOLE-file reads; a bounded line WINDOW is allowed
// above it (streamed, only the returned slice is read). (F10/F11)
export const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB
