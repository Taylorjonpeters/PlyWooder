import { nest, type NestItem, type NestSettings } from './nest';

export type NestRequest = { id: number; jobs: { groups: NestItem[][]; settings: NestSettings }[] };

self.onmessage = (e: MessageEvent<NestRequest>) => {
  const { id, jobs } = e.data;
  const results = jobs.map(({ groups, settings }) => groups.map((items) => nest(items, settings)));
  self.postMessage({ id, results });
};
