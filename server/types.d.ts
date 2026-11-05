declare module 'tesseract.js' {
  export function createWorker(langs?: string, oem?: number, options?: Record<string, unknown>): Promise<any>;
  const _default: { createWorker: typeof createWorker };
  export default _default;
}
