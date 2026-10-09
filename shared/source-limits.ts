// UTF-8 TXT and escaped JSON need byte allowances matching the source limit.
export const MAX_SOURCE_CHARACTERS = 7_000_000;
export const MAX_SOURCE_FILE_BYTES = MAX_SOURCE_CHARACTERS * 3;
export const MAX_JSON_BODY_BYTES = MAX_SOURCE_CHARACTERS * 6 + 1_000_000;
