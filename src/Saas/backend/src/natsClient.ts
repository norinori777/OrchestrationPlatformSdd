import { connect, NatsConnection, StringCodec } from 'nats';

let nc: NatsConnection | null = null;
const sc = StringCodec();

export async function connectNats(): Promise<void> {
  nc = await connect({ servers: process.env.NATS_URL ?? 'nats://localhost:4222' });
  console.log(`[NATS] connected to ${process.env.NATS_URL ?? 'nats://localhost:4222'}`);
}

export function publishEvent(subject: string, data: object): void {
  if (!nc) throw new Error('NATS not connected');
  nc.publish(subject, sc.encode(JSON.stringify(data)));
}

export async function drainNats(): Promise<void> {
  if (nc) await nc.drain();
}
