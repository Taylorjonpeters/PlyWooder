declare module 'occt-import-js' {
  const init: (opts?: { locateFile?: (path: string) => string }) => Promise<unknown>;
  export default init;
}
