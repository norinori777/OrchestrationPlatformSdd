import { connect, StringCodec } from 'nats';

async function main(): Promise<void> {
	const nc = await connect({ servers: 'localhost:4222' });
	const sc = StringCodec();
	const message = JSON.stringify({ user: 'alice', action: 'read' });

	nc.publish('demo', sc.encode(message));
	await nc.flush();
	await nc.close();
	console.log('published:', message);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});