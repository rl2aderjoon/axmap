/// <reference path="../node_modules/node-pty/node-pty.d.ts" />
// The prebuilt package declares its original name; the runtime uses an npm alias.
declare module 'node-pty' {
  export * from '@lydell/node-pty'
}
// Preserve the bridge's existing Windows configuration during migration;
// the package's declarations omit these legacy options.
declare module '@lydell/node-pty' {
  interface IWindowsPtyForkOptions {
    useConpty?: boolean
    useConptyDll?: boolean
  }
}
