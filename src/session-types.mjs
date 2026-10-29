// Generated from src/session-types.mts. Edit the .mts source and run npm run build.
/** `run.mjs rpc` 가 로컬 파이프에 연결조차 못 했을 때(ENOENT·ECONNREFUSED)의 종료 코드.
 * 이 경우에만 요청이 확실히 전달되지 않았다고 판단한다. */
export const RPC_NOT_DELIVERED_EXIT = 3;
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function errorCode(error) {
    return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
