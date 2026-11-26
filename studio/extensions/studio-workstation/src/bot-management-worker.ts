import { parentPort, workerData } from 'node:worker_threads';
import { manageBotStorage } from '../../../../cli/src/web/bot-management-storage';

if (parentPort) {
  const { target, request } = workerData as { target: Parameters<typeof manageBotStorage>[0]; request: Parameters<typeof manageBotStorage>[1] };
  void manageBotStorage(target, request).then(result => {
    if ('content' in result) {
      const bytes = Uint8Array.from(result.content.bytes);
      parentPort!.postMessage({ ...result, content: { ...result.content, bytes } }, [bytes.buffer]);
    } else parentPort!.postMessage(result);
  });
}
