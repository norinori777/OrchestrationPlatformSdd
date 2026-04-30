import { connect, StringCodec } from "nats";

async function main() {
  const nc = await connect({ servers: "localhost:4222" });
  const sc = StringCodec();
  nc.publish("demo", sc.encode("hello from ts pub"));
  await nc.flush();
  await nc.close();
  console.log("published");
}
main().catch(console.error);