import { nest, type NestItem, type NestSettings } from './nest';
import { suggestSheet, type SuggestRequest } from './suggest';

export type NestRequest = { id: number; jobs: { groups: NestItem[][]; settings: NestSettings }[] };
export type SuggestJob = { id: number; suggest: SuggestRequest };

self.onmessage = (e: MessageEvent<NestRequest | SuggestJob>) => {
  const msg = e.data;
  if ('suggest' in msg) {
    const result = suggestSheet(msg.suggest, (done) => self.postMessage({ id: msg.id, progress: done }));
    self.postMessage({ id: msg.id, suggestion: result });
    return;
  }
  const results = msg.jobs.map(({ groups, settings }) => groups.map((items) => nest(items, settings)));
  self.postMessage({ id: msg.id, results });
};
