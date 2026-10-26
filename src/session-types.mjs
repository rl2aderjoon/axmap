// Generated from src/session-types.mts. Edit the .mts source and run npm run build.
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function errorCode(error) {
    return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
