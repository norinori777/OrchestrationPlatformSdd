import { connect, StringCodec } from "nats";

async function main() {
  const nc = await connect({ servers: "localhost:4222" });
  const sc = StringCodec();
  console.log("subscribed, waiting message...");
  const sub = nc.subscribe("demo");
  for await (const m of sub) {
    console.log("received:", sc.decode(m.data));
    break;
  }
  await nc.close();
}
main().catch(console.error);