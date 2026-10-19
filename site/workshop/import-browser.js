// One import per worker; terminate on both success and failure to release source geometry.
export function importInBrowser(bytes, options = {}) {
  return new Promise((resolve, reject) => {
    // A worker entry must be same-origin even when modules come from static.fun.dev.
    const entry = new URL('./import-worker.js', import.meta.url);
    const bootstrap = URL.createObjectURL(new Blob([`import ${JSON.stringify(entry.href)};`], { type: 'text/javascript' }));
    const worker = new Worker(bootstrap, { type: 'module' });
    const finish = (error, result) => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(bootstrap);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Model import timed out')), 120_000);
    worker.onerror = (event) => finish(new Error(event.message || 'Model import worker failed'));
    worker.onmessage = ({ data }) => finish(data.error ? Object.assign(new Error(data.error.message), { code: data.error.code }) : null, data.result);
    worker.postMessage({ bytes, options }, [bytes.buffer]);
  });
}
