/** Await each frame's write callback so a slow host applies pipe backpressure. */
export function createWorkerTransport(output) {
  return message => new Promise((resolve, reject) => {
    output.write(`__STEAMHARNESS_WEB__${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve());
  });
}
